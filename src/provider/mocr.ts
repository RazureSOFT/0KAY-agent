/**
 * MocrProvider - All AI calls go through mocr (real gRPC).
 */

import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { taskRecorder } from '../task/records.js'
import {coreHeaders,coreCredentials,coreOptions,coreMetadata,coreFetch,egressFetch} from '../connection.js'
import {classifyFailure,resolveRetryOptions,retryDelayMs,streamIdleTimeoutMs,sleep,shouldRetry,nextWithIdleTimeout,ModelEmptyCompletionError} from './retry.js'

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
  /** Unique id for this logical generation (reused across retries). */
  requestId?: string;
  sessionId?: string;
}

export interface Message {
  role: string;
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  /** Multimodal parts (text + images) sent straight to the model. */
  parts?: MessagePart[];
  /** Prior assistant chain-of-thought (DeepSeek thinking mode pass-back). */
  reasoningContent?: string;
}

/** One segment of a multimodal message. */
export interface MessagePart {
  /** "text" or "image". */
  type: string;
  text?: string;
  /** data URL (data:<mime>;base64,<data>) or https URL. */
  imageUrl?: string;
  mimeType?: string;
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

/** Pull a context-window number out of a provider model object, if present. */
function extractContextLength(value: any): number {
  if (!value || typeof value !== 'object') return 0;
  for (const key of ['context_length', 'context_window', 'max_context_length', 'max_input_tokens', 'input_token_limit', 'n_ctx', 'max_model_len']) {
    const n = Number(value[key]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

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
  private contextLengths = new Map<string, number>();
  recorder = taskRecorder;

  constructor(config: MocrConfig) {
    this.config = config;
  }

  private async resolveCredentials(modelId: string, provider = '', signal?: AbortSignal) {
    const base = process.env.CORE_HTTP_ADDR || process.env.CORE_HTTP || 'http://127.0.0.1:8080';
    // Credentials are resolved per call: GET /api/providers is redacted now, so
    // the secret-bearing catalog comes from /api/providers/credentials. Not
    // caching keeps provider edits effective immediately.
    const response = await coreFetch(`${base}/api/providers/credentials`, { headers:coreHeaders(), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Cannot load providers: HTTP ${response.status}`);
    const data: any = await response.json();
    const list: any[] = (Array.isArray(data) ? data : data.providers || []).filter((p: any) => p.enabled !== false);
    const defaultProvider = list.find(p => p.id === data.default_provider_id);
    let chosen: any;
    if (modelId) {
      // The provider hint from MOCR is the preset name (e.g. "custom"), while
      // this endpoint normalizes `provider` to the effective wire protocol
      // (e.g. "openai"), so the id/model must decide. Match by model, and use
      // the hint only to break ties.
      const byModel = list.filter(p =>
        (p.models || []).some((m: any) => (typeof m === 'string' ? m : m.id || m.model_id) === modelId) &&
        !(p.disabled_models || []).includes(modelId));
      if (provider) {
        const byProvider = byModel.filter(p => p.provider === provider || p.id === provider);
        chosen = byProvider.find(p => p.id === data.default_provider_id) || byProvider[0];
      }
      if (!chosen) chosen = byModel.find(p => p.id === data.default_provider_id) || byModel[0];
      if (!chosen) throw new Error(`No enabled provider configured for model ${modelId}`);
    } else {
      chosen = defaultProvider || list[0];
      if (!chosen) throw new Error('No enabled provider configured');
    }
    const resolvedModel = modelId || chosen.default_model || data.default_model ||
      (chosen.models || []).map((m: any) => (typeof m === 'string' ? m : m.id || m.model_id)).filter(Boolean)[0] || '';
    return { provider: chosen.provider || '', baseUrl: chosen.base_url || '', apiKey: chosen.api_key || '', format: chosen.format || '', model: resolvedModel };
  }

  /**
   * Best-effort context window (in tokens) for a model, read from the provider's
   * `/models/{model}` (then the `/models` list). Cached; 0 when unknown.
   */
  async modelContextLength(modelId: string, signal?: AbortSignal): Promise<number> {
    if (!modelId) return 0;
    const cached = this.contextLengths.get(modelId);
    if (cached !== undefined) return cached;
    let length = 0;
    try {
      const creds = await this.resolveCredentials(modelId, '', signal);
      const endpoint = String(creds.baseUrl || '').replace(/\/$/, '');
      if (endpoint) {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (creds.apiKey) headers.Authorization = `Bearer ${creds.apiKey}`;
        const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
        length = await this.contextLengthFrom(`${endpoint}/models/${encodeURIComponent(modelId)}`, headers, timeout);
        if (!length) length = await this.contextLengthFrom(`${endpoint}/models`, headers, timeout, modelId);
      }
    } catch { /* best effort */ }
    if (length > 0) this.contextLengths.set(modelId, length);
    return length;
  }

  private async contextLengthFrom(url: string, headers: Record<string, string>, signal: AbortSignal, matchId = ''): Promise<number> {
    try {
      const response = await egressFetch(url, { headers, signal }, 8000);
      if (!response.ok) return 0;
      const data: any = await response.json();
      return this.parseContextLength(data, matchId);
    } catch { return 0; }
  }

  /** Extract a context window from a provider /models payload (pure). */
  private parseContextLength(data: any, matchId = ''): number {
    if (matchId) {
      const list: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      const target = matchId.toLowerCase();
      const hit = list.find((m: any) => String(m?.id || '').toLowerCase() === target)
        || list.find((m: any) => { const id = String(m?.id || '').toLowerCase(); return id && (id.includes(target) || target.includes(id)); });
      return extractContextLength(hit) || extractContextLength(data);
    }
    return extractContextLength(data) || extractContextLength(data?.data);
  }

  /**
   * Describe an image with a vision-capable provider model (OpenAI-compatible
   * or Anthropic format). Used to make uploaded images visible to the text-only
   * agent loop.
   */
  async describeImage(modelId: string, base64: string, mime = 'image/png', prompt = '', maxTokens = 1024, signal?: AbortSignal): Promise<string> {
    if (!base64) return '';
    const creds = await this.resolveCredentials(modelId, '', signal);
    if (!creds.baseUrl) throw new Error('vision provider has no base_url');
    const ask = prompt || 'Describe this image in two or three sentences.';
    const endpoint = creds.baseUrl.replace(/\/$/, '');
    const isAnthropic = String(creds.provider).toLowerCase() === 'anthropic' || String(creds.format).toLowerCase() === 'anthropic';
    if (isAnthropic) {
      const url = endpoint.endsWith('/v1') ? `${endpoint}/messages` : `${endpoint}/v1/messages`;
      const res = await egressFetch(url, { method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-api-key': creds.apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: creds.model, max_tokens: maxTokens, messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
        { type: 'text', text: ask },
      ] }] }) }, 60000);
      if (!res.ok) throw new Error(`vision HTTP ${res.status}`);
      const payload: any = await res.json();
      return (payload.content || []).map((part: any) => part?.text || '').join('').trim();
    }
    const res = await egressFetch(`${endpoint}/chat/completions`, { method: 'POST', signal, headers: { 'content-type': 'application/json', Authorization: `Bearer ${creds.apiKey}` }, body: JSON.stringify({ model: creds.model, max_tokens: maxTokens, messages: [{ role: 'user', content: [
      { type: 'text', text: ask },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
    ] }] }) }, 60000);
    if (!res.ok) throw new Error(`vision HTTP ${res.status}`);
    const payload: any = await res.json();
    const content = payload.choices?.[0]?.message?.content;
    if (Array.isArray(content)) return content.map((part: any) => part?.text || '').join('').trim();
    return String(content || '').trim();
  }

  /**
   * Call mocr for text generation (server-streaming gRPC).
   */
  async *generate(request: GenerateRequest): AsyncGenerator<GenerateResponse> {
    const event = { task_id: `agent-model:${crypto.randomUUID()}`, caller_id: 'agent', kind: 'think', prompt: request.modelId,
      parent_id: request.taskId || '', session_id: request.sessionId || '', state: 'running' };
    await this.recorder.record(event);
    let text = '';
    let reasoning = '';
    let lastPublished = 0;
    let publishing: Promise<void> | null = null;
    try {
      for await (const chunk of this.generateStream(request)) {
        text += chunk.chunk || '';
        if (chunk.thinkingContent) reasoning += chunk.thinkingContent;
        if (chunk.done && chunk.text) text = chunk.text;
        if (!chunk.done && (text || reasoning) && !publishing && Date.now() - lastPublished >= 200) {
          publishing = this.recorder.record({ ...event, result: text, reasoning }).catch(error=>console.warn('Progress delivery failed:',error.message)).finally(()=>{publishing=null});
          lastPublished = Date.now();
        }
        if (chunk.done && ['FINISH_REASON_ERROR', 'FINISH_REASON_LENGTH', 'FINISH_REASON_CONTENT_FILTER'].includes(chunk.finishReason || '')) throw new Error(`Model finish: ${chunk.finishReason}`);
        if (chunk.done) {await publishing;await this.recorder.record({ ...event, state: 'done', result: text, reasoning });}
        yield chunk;
      }
    } catch (error: any) {
      await publishing;
      await this.recorder.record({ ...event, state: request.signal?.aborted ? 'cancelled' : 'failed', result: text, error: error.message, reasoning });
      throw error;
    }
  }

  private async *generateStream(request: GenerateRequest): AsyncGenerator<GenerateResponse> {
    const creds = request.baseUrl && request.apiKey ? request : await this.resolveCredentials(request.modelId, request.provider || this.selectedProviders.get(request.modelId), request.signal);
    const options = resolveRetryOptions();
    // One request-id per logical generation, reused across retries so a retry
    // cannot double-count. It must be unique per call: mocr keys its usage
    // outbox by request-id, so reusing a task id for every turn of a task would
    // overwrite earlier turns and massively under-count usage.
    const scoped: GenerateRequest = request.requestId
      ? request
      : { ...request, requestId: `${request.taskId || 'agent-model'}:${crypto.randomUUID()}` };
    for (let attempt = 0; ; attempt++) {
      let emitted = false;
      try {
        yield* this.attemptGenerate(scoped, creds, streamIdleTimeoutMs(attempt), () => { emitted = true; });
        return;
      } catch (error) {
        const failure = classifyFailure(error, request.signal);
        if (!shouldRetry(failure, attempt, options, emitted)) throw error;
        const delay = retryDelayMs(attempt, options, failure.retryAfterMs);
        console.warn(`[Agent] model attempt ${attempt + 1} failed (${failure.reason}); retrying in ${delay}ms`);
        await sleep(delay, request.signal);
      }
    }
  }

  private async *attemptGenerate(
    request: GenerateRequest,
    creds: { provider?: string; baseUrl?: string; apiKey?: string },
    idleMs: number,
    onEmit: () => void,
  ): AsyncGenerator<GenerateResponse> {
    const stub = getStub(this.config.grpcAddress);
    request.signal?.throwIfAborted();

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
        if (message.parts?.length) {
          wire.contentParts = message.parts.map((part) => ({
            type: part.type,
            text: part.text || '',
            imageUrl: part.imageUrl || '',
            mimeType: part.mimeType || '',
          }));
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
    const requestId = request.requestId || request.taskId;
    if(requestId) metadata.set('x-0kay-request-id', requestId);
    const difficulty=request.difficultyHint ?? 0.5;
    metadata.set('x-0kay-thinking-level',!request.thinking?'off':difficulty<=0.25?'low':difficulty<0.7?'medium':difficulty<1?'high':'max');
    const stream = stub.Generate(payload, metadata, { deadline: Date.now() + 300_000 });
    const cancel = () => stream.cancel();
    request.signal?.addEventListener('abort', cancel, { once: true });
    if (request.signal?.aborted) cancel();
    const iterator = stream[Symbol.asyncIterator]();

    try {
      let completed = false;
      let sawPayload = false;
      for (;;) {
        const result = await nextWithIdleTimeout(iterator, idleMs, cancel);
        if (result.done) break;
        const resp: any = result.value;
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
        const hasPayload = !!(out.chunk || out.thinkingContent || (out.toolCalls && out.toolCalls.length) || (out.done && out.text));
        if (hasPayload) { sawPayload = true; onEmit(); }
        // A done frame with no text/tool calls is worth one clean retry rather
        // than surfacing an empty answer (mirrors ZCode's empty-completion retry).
        if (resp.done && !sawPayload) throw new ModelEmptyCompletionError();
        yield out;
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
