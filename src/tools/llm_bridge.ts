/**
 * Model bridge for the web/vision tools.
 *
 * Preferred path: the agent injects `context.llm`, which routes through MOCR
 * (the same channel as the main loop). When a tool runs without that channel
 * (standalone, or before injection), this falls back to a directly configured
 * provider (OpenAI / Anthropic / Gemini) and finally returns null so the tool
 * uses its deterministic path.
 */

import { egressOrDirect } from './helpers.js';
import type { ToolContext, LlmMessagePart } from './types.js';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; parts?: LlmMessagePart[]; }

export interface ProviderConfig { provider: 'openai' | 'anthropic' | 'gemini'; apiKey: string; model: string; baseUrl?: string; }

export function pickProvider(env: NodeJS.ProcessEnv = process.env, modelOverride?: string): ProviderConfig | null {
  if (env.OPENAI_API_KEY) return { provider: 'openai', apiKey: env.OPENAI_API_KEY, model: modelOverride || env.OKAY_MODEL || 'gpt-4o-mini', baseUrl: env.OPENAI_BASE_URL };
  if (env.ANTHROPIC_API_KEY) return { provider: 'anthropic', apiKey: env.ANTHROPIC_API_KEY, model: modelOverride || env.OKAY_MODEL || 'claude-3-5-sonnet-latest' };
  if (env.GEMINI_API_KEY) return { provider: 'gemini', apiKey: env.GEMINI_API_KEY, model: modelOverride || env.OKAY_MODEL || 'gemini-1.5-flash' };
  return null;
}

/** Chat through MOCR when the agent injected a model channel, else a direct
 *  provider, else null. `context` is optional so pure helpers can call this. */
export async function chatVia(context: ToolContext | undefined, messages: ChatMessage[], options: { signal?: AbortSignal; maxTokens?: number; model?: string; temperature?: number; parts?: LlmMessagePart[] } = {}): Promise<string | null> {
  const signal = options.signal || context?.signal;
  if (context?.llm) {
    const systemPrompt = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n') || undefined;
    const convo = messages.filter((m) => m.role !== 'system');
    const last = convo[convo.length - 1];
    const withParts = last && options.parts?.length ? convo.map((m, i) => (i === convo.length - 1 ? { ...m, parts: [...(m.parts || []), ...options.parts!] } : m)) : convo;
    try {
      const text = await context.llm({ messages: withParts, systemPrompt, maxTokens: options.maxTokens, model: options.model, temperature: options.temperature });
      if (text != null) return text;
    } catch { /* fall through to a direct provider */ }
  }
  return providerChat(messages, { ...options, signal });
}

export async function providerChat(messages: ChatMessage[], options: { signal?: AbortSignal; maxTokens?: number; model?: string; temperature?: number } = {}): Promise<string | null> {
  const provider = pickProvider(process.env, options.model);
  if (!provider) return null;
  const maxTokens = options.maxTokens ?? 1024;
  try {
    if (provider.provider === 'openai') {
      const base = (provider.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
      const res = await egressOrDirect(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify({ model: provider.model, messages, max_tokens: maxTokens, temperature: options.temperature }),
        signal: options.signal,
      }, 120_000);
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) return null;
      return String(data?.choices?.[0]?.message?.content || '');
    }
    if (provider.provider === 'anthropic') {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      const convo = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
      const res = await egressOrDirect('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: provider.model, max_tokens: maxTokens, system, messages: convo }),
        signal: options.signal,
      }, 120_000);
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) return null;
      return (data?.content || []).map((part: any) => part?.text || '').join('');
    }
    const res = await egressOrDirect(`https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:generateContent?key=${provider.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })) }),
      signal: options.signal,
    }, 120_000);
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    return (data?.candidates?.[0]?.content?.parts || []).map((part: any) => part?.text || '').join('');
  } catch {
    return null;
  }
}
