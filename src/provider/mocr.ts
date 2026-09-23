/**
 * MocrProvider - All AI calls go through mocr (real gRPC).
 */

import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PROTO_DIR = process.env.PROTO_DIR || path.resolve(__dirname, '../../../proto')

export interface GenerateRequest {
  modelId: string;
  messages: Message[];
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  thinking?: boolean;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  difficultyHint?: number;
  requireThinking?: boolean;
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required' | string;
}

export interface Message {
  role: string;
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface ToolCall {
  id: string;
  type?: string;
  name: string;
  arguments: string;
}

export interface GenerateResponse {
  chunk?: string;
  done: boolean;
  finishReason?: string;
  thinkingContent?: string;
  role?: string;
  text?: string;
  toolCalls?: ToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface MocrConfig {
  grpcAddress: string;
}

const loaderOptions: protoLoader.Options = {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTO_DIR],
}

let cachedStub: any = null
let cachedAddress = ''

function getStub(address: string): any {
  if (cachedStub && cachedAddress === address) return cachedStub
  const def = protoLoader.loadSync(path.join(PROTO_DIR, 'mocr/v1/mocr.proto'), loaderOptions)
  const pkg = (grpc.loadPackageDefinition(def) as any).mocr?.v1
  if (!pkg?.MocrService) {
    throw new Error('mocr.v1.MocrService not found in proto definition')
  }
  const client = new pkg.MocrService(address, grpc.credentials.createInsecure())
  cachedStub = client
  cachedAddress = address
  return client
}

export class MocrProvider {
  private config: MocrConfig;
  private creds: { provider: string; baseUrl: string; apiKey: string } | null = null;
  private credPromise: Promise<void> | null = null;

  constructor(config: MocrConfig) {
    this.config = config;
  }

  /** Load provider credentials from Core once (optional). */
  private ensureCreds(): Promise<void> {
    if (this.credPromise) return this.credPromise;
    const coreHttp = process.env.CORE_HTTP || 'http://127.0.0.1:8080'
    this.credPromise = (async () => {
      try {
        const res = await fetch(`${coreHttp}/api/providers`)
        if (!res.ok) return
        const data: any = await res.json()
        const list: any[] = Array.isArray(data) ? data : (data.providers || [])
        const defaultId = data.default_provider_id || data.defaultProviderId || ''
        let chosen: any = null
        for (const p of list) {
          if (!p || typeof p !== 'object') continue
          if (defaultId && p.id === defaultId) { chosen = p; break }
          if (!chosen && p.enabled !== false && p.api_key) chosen = p
        }
        if (chosen?.api_key) {
          this.creds = {
            provider: chosen.provider || '',
            baseUrl: chosen.base_url || '',
            apiKey: chosen.api_key || '',
          }
        }
      } catch {
        // offline — leave creds null
      }
    })()
    return this.credPromise
  }

  /**
   * Call mocr for text generation (server-streaming gRPC).
   */
  async *generate(request: GenerateRequest): AsyncGenerator<GenerateResponse> {
    const stub = getStub(this.config.grpcAddress);
    await this.ensureCreds();

    const payload: any = {
      modelId: request.modelId,
      messages: request.messages,
      systemPrompt: request.systemPrompt || '',
      maxTokens: request.maxTokens || 1024,
      temperature: request.temperature ?? 0.7,
      stream: true,
      thinking: !!request.thinking,
      provider: request.provider || this.creds?.provider || '',
      baseUrl: request.baseUrl || this.creds?.baseUrl || '',
      apiKey: request.apiKey || this.creds?.apiKey || '',
      toolChoice: request.toolChoice || 'auto',
      tools: (request.tools || []).map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parametersJson: JSON.stringify(tool.parameters || { type: 'object', properties: {} }),
        },
      })),
    };

    const stream: any = await new Promise((resolve, reject) => {
      const call = stub.Generate(payload)
      call.on('metadata', () => resolve(call))
      call.on('error', reject)
      // some servers send first message before metadata callback settles
      setTimeout(() => resolve(call), 50)
    }).catch(() => stub.Generate(payload))

    try {
      for await (const resp of stream) {
        const out: GenerateResponse = {
          chunk: resp.chunk || undefined,
          done: !!resp.done,
          finishReason: resp.finishReason || (resp.done ? 'STOP' : undefined),
          thinkingContent: resp.thinkingContent || undefined,
          role: resp.role || undefined,
          text: resp.text || undefined,
          toolCalls: Array.isArray(resp.toolCalls)
            ? resp.toolCalls.map((tool: any) => ({
                id: tool.id || '',
                type: tool.type || 'function',
                name: tool.functionName || tool.name || '',
                arguments: tool.arguments || '{}',
              }))
            : undefined,
        }
        if (resp.usage) {
          out.usage = {
            promptTokens: Number(resp.usage.promptTokens || 0),
            completionTokens: Number(resp.usage.completionTokens || 0),
            totalTokens: Number(resp.usage.totalTokens || 0),
          }
        }
        yield out
        if (resp.done) break
      }
    } catch (err: any) {
      // Offline/fallback path: deterministic reply so the agent still works
      const prompt = request.messages.map(m => `${m.role}: ${m.content}`).join('\n')
      const response = `Agent offline reply (mocr unreachable): ${prompt.substring(0, 80)}...`
      for (const chunk of this.splitIntoChunks(response, 40)) {
        yield { chunk, done: false }
      }
      yield {
        done: true,
        finishReason: 'STOP',
        usage: {
          promptTokens: Math.max(1, Math.ceil(prompt.length / 4)),
          completionTokens: Math.ceil(response.length / 4),
          totalTokens: Math.max(1, Math.ceil(prompt.length / 4)) + Math.ceil(response.length / 4),
        },
      }
    }
  }

  /**
   * Choose think/output models via mocr (optional helper).
   * difficultyHint/requireThinking come from life thinking intensity metadata.
   */
  async chooseModels(
    prompt: string,
    requireThinking = false,
    difficultyHint = 0.5,
  ): Promise<string> {
    try {
      const stub = getStub(this.config.grpcAddress)
      const resp: any = await new Promise((resolve, reject) => {
        stub.ChooseModels(
          {
            prompt,
            context: {
              difficultyHint: Number.isFinite(difficultyHint) ? difficultyHint : 0.5,
              maxTokens: 1024,
              requireThinking,
            },
          },
          (err: any, r: any) => (err ? reject(err) : resolve(r)),
        )
      })
      const id = resp?.outputModel?.modelId || resp?.thinkModel?.modelId || ''
      return id || 'default-model'
    } catch {
      return 'default-model'
    }
  }

  private splitIntoChunks(text: string, size: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size) {
      chunks.push(text.substring(i, i + size));
    }
    return chunks;
  }
}
