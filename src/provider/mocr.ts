/**
 * MocrProvider - All AI calls go through mocr (real gRPC).
 */

import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { taskRecorder } from '../task/records.js'
import {coreHeaders,coreCredentials,coreOptions,coreMetadata,coreFetch} from '../connection.js'

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
  signal?: AbortSignal;
  taskId?: string;
  sessionId?: string;
}

export interface Message {
  role: string;
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  /** Prior assistant chain-of-thought (DeepSeek thinking mode pass-back). */
  reasoningContent?: string;
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
  const client = new pkg.MocrService(address, process.env.CORE_TLS_CA?coreCredentials():grpc.credentials.createInsecure(),coreOptions())
  cachedStub = client
  cachedAddress = address
  return client
}

export class MocrProvider {
  private config: MocrConfig;
  private selectedProviders = new Map<string, string>();
  recorder = taskRecorder;

  constructor(config: MocrConfig) {
    this.config = config;
  }

  private async resolveCredentials(modelId: string, provider = '', signal?: AbortSignal) {
    const base = process.env.CORE_HTTP_ADDR || process.env.CORE_HTTP || 'http://127.0.0.1:8080';
    const response = await coreFetch(`${base}/api/providers`, { headers:coreHeaders(), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Cannot load providers: HTTP ${response.status}`);
    const data: any = await response.json();
    const list: any[] = (Array.isArray(data) ? data : data.providers || []).filter((p: any) => p.enabled !== false);
    const matches = list.filter(p => (!provider || p.provider === provider || p.id === provider) &&
      (p.models || []).some((m: any) => (typeof m === 'string' ? m : m.id || m.model_id) === modelId) && !(p.disabled_models || []).includes(modelId));
    const chosen = matches.find(p => p.id === data.default_provider_id) || matches[0];
    if (!chosen) throw new Error(`No enabled provider configured for model ${modelId}`);
    return { provider: chosen.provider || '', baseUrl: chosen.base_url || '', apiKey: chosen.api_key || '' };
  }

  /**
   * Call mocr for text generation (server-streaming gRPC).
   */
  async *generate(request: GenerateRequest): AsyncGenerator<GenerateResponse> {
    const event = { task_id: `agent-model:${crypto.randomUUID()}`, caller_id: 'agent', kind: 'think', prompt: request.modelId,
      parent_id: request.taskId || '', session_id: request.sessionId || '', state: 'running' };
    await this.recorder.record(event);
    let text = '';
    let lastPublished = 0;
    let publishing: Promise<void> | null = null;
    try {
      for await (const chunk of this.generateStream(request)) {
        text += chunk.chunk || '';
        if (chunk.done && chunk.text) text = chunk.text;
        if (!chunk.done && text && !publishing && Date.now() - lastPublished >= 200) {
          publishing = this.recorder.record({ ...event, result: text }).catch(error=>console.warn('Progress delivery failed:',error.message)).finally(()=>{publishing=null});
          lastPublished = Date.now();
        }
        if (chunk.done && ['FINISH_REASON_ERROR', 'FINISH_REASON_LENGTH', 'FINISH_REASON_CONTENT_FILTER'].includes(chunk.finishReason || '')) throw new Error(`Model finish: ${chunk.finishReason}`);
        if (chunk.done) {await publishing;await this.recorder.record({ ...event, state: 'done', result: text });}
        yield chunk;
      }
    } catch (error: any) {
      await publishing;
      await this.recorder.record({ ...event, state: request.signal?.aborted ? 'cancelled' : 'failed', result: text, error: error.message });
      throw error;
    }
  }

  private async *generateStream(request: GenerateRequest): AsyncGenerator<GenerateResponse> {
    const stub = getStub(this.config.grpcAddress);
    request.signal?.throwIfAborted();
    const creds = request.baseUrl && request.apiKey ? request : await this.resolveCredentials(request.modelId, request.provider || this.selectedProviders.get(request.modelId), request.signal);

    const payload: any = {
      modelId: request.modelId,
      messages: request.messages.map(message => {
        const wire: any = {
          role: message.role,
          content: message.content,
          toolCalls: message.toolCalls?.map(call => ({ id: call.id, type: call.type || 'function', functionName: call.name, arguments: call.arguments })),
        };
        // Prior assistant chain-of-thought (DeepSeek thinking mode requires
        // it on every assistant message once tools are present).
        if (message.reasoningContent) {
          wire.reasoningContent = message.reasoningContent;
        }
        if (message.toolCallId) {
          wire.toolCallId = message.toolCallId;
        }
        return wire;
      }),
      systemPrompt: request.systemPrompt || '',
      maxTokens: request.maxTokens || 8192,
      temperature: request.temperature ?? 0.7,
      stream: true,
      thinking: !!request.thinking,
      provider: creds.provider || '',
      baseUrl: creds.baseUrl || '',
      apiKey: creds.apiKey || '',
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

    const metadata=coreMetadata();
    if(request.sessionId) metadata.set('x-0kay-session-id', request.sessionId);
    if(request.taskId) metadata.set('x-0kay-request-id', request.taskId);
    const difficulty=request.difficultyHint ?? 0.5;
    metadata.set('x-0kay-thinking-level',!request.thinking?'off':difficulty<=0.25?'low':difficulty<0.7?'medium':difficulty<1?'high':'max');
    const stream = stub.Generate(payload, metadata, { deadline: Date.now() + 300_000 });
    const cancel = () => stream.cancel();
    request.signal?.addEventListener('abort', cancel, { once: true });
    if (request.signal?.aborted) cancel();

    try {
      let completed = false;
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
        if (resp.done) { completed = true; break; }
      }
      if (!completed) throw new Error('Model stream ended without completion');
    } finally {
      request.signal?.removeEventListener('abort', cancel);
      stream.cancel();
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
    signal?: AbortSignal,
  ): Promise<string> {
      signal?.throwIfAborted();
      const stub = getStub(this.config.grpcAddress)
      const resp: any = await new Promise((resolve, reject) => {
        const call = stub.ChooseModels(
          {
            prompt,
            context: {
              difficultyHint: Number.isFinite(difficultyHint) ? difficultyHint : 0.5,
              maxTokens: 1024,
              requireThinking,
            },
          },
          coreMetadata(), { deadline: Date.now() + 15000 },
          (err: any, r: any) => { signal?.removeEventListener('abort', cancel); err ? reject(err) : resolve(r); },
        )
        const cancel = () => call.cancel();
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
      })
      const model = requireThinking ? resp?.thinkModel : resp?.outputModel;
      if (!model?.modelId) throw new Error('No model selected');
      this.selectedProviders.set(model.modelId, model.provider || '');
      return model.modelId;
  }

  private splitIntoChunks(text: string, size: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size) {
      chunks.push(text.substring(i, i + size));
    }
    return chunks;
  }
}
