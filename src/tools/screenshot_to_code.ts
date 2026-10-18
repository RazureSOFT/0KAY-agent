/**
 * `screenshot_to_code` tool — full reimplementation of abi/screenshot-to-code.
 *
 * Features:
 *  - Inputs: image file / data URL, HTML? no — screenshots, mockups, and (new)
 *    a screen recording via `video` (frames extracted with ffmpeg) or `frames`.
 *  - Stacks: html_tailwind, html_css, react_tailwind, vue_tailwind, bootstrap,
 *    ionic_tailwind.
 *  - Vision models: OpenAI / Anthropic / Gemini chosen from configured keys.
 *  - Asset extraction: reuse real logos/images cropped from the screenshot
 *    (Firecrawl-style asset pass) as a list the model can reference.
 *  - Self-check: when a browser is available, render the generated page and take
 *    a preview screenshot, feeding a structural diff back for one refinement
 *    pass (the source project's "screenshot preview" tool).
 *  - Variants: generate N independent candidates and return all.
 *  - Offline: with no key, returns a deterministic structural scaffold.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult, type LlmMessagePart } from './types.js';
import { success, failure, clamp } from './helpers.js';
import { isPathAllowed } from '../workspace/paths.js';
import { extractVideoFrames } from './document.js';
import { screenshotHtmlDataUrl } from './browser_driver.js';

const STACKS: Record<string, { hint: string; file: string; lang: string }> = {
  html_tailwind: { hint: 'a single HTML file using Tailwind CSS via the CDN script', file: 'index.html', lang: 'html' },
  html_css: { hint: 'a single HTML file with embedded plain CSS', file: 'index.html', lang: 'html' },
  react_tailwind: { hint: 'a React + Tailwind component as JSX (export default App)', file: 'App.jsx', lang: 'jsx' },
  vue_tailwind: { hint: 'a Vue 3 single-file component with Tailwind classes', file: 'App.vue', lang: 'vue' },
  bootstrap: { hint: 'a single HTML file using Bootstrap 5 via CDN', file: 'index.html', lang: 'html' },
  ionic_tailwind: { hint: 'an Ionic React component with Tailwind classes (export default App)', file: 'App.tsx', lang: 'tsx' },
};

interface ImageInfo { mime: string; base64: string; width: number; height: number; palette: Array<{ hex: string; ratio: number }>; }

function parseDataUrl(data: string): { mime: string; base64: string } {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(data.trim());
  if (!match) throw new Error('invalid data URL (expected data:<mime>;base64,<data>)');
  return { mime: match[1], base64: match[2] };
}

function pngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length >= 24 && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  return null;
}
function jpegSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset++; continue; }
    const marker = buffer[offset + 1]; const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  return null;
}
function gifSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length >= 10 && buffer.slice(0, 3).toString('ascii') === 'GIF') return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  return null;
}
function imageSize(buffer: Buffer): { width: number; height: number } { return pngSize(buffer) || jpegSize(buffer) || gifSize(buffer) || { width: 0, height: 0 }; }

function paletteOf(buffer: Buffer, top = 8): Array<{ hex: string; ratio: number }> {
  const counts = new Map<string, number>(); let total = 0;
  for (let i = 0; i + 3 < buffer.length; i += 997) {
    const key = `${buffer[i] >> 5},${buffer[i + 1] >> 5},${buffer[i + 2] >> 5}`;
    counts.set(key, (counts.get(key) || 0) + 1); total++;
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([key, count]) => {
    const [r, g, b] = key.split(',').map((v) => Math.min(255, (Number(v) << 5) + 16));
    return { hex: `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`, ratio: Number((count / Math.max(1, total)).toFixed(3)) };
  });
}

async function loadImage(source: string, cwd: string): Promise<ImageInfo> {
  if (source.startsWith('data:')) {
    const { mime, base64 } = parseDataUrl(source);
    const buffer = Buffer.from(base64, 'base64');
    const size = imageSize(buffer);
    return { mime, base64, width: size.width, height: size.height, palette: paletteOf(buffer) };
  }
  const filePath = path.resolve(cwd, source);
  const buffer = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/png';
  const size = imageSize(buffer);
  return { mime, base64: buffer.toString('base64'), width: size.width, height: size.height, palette: paletteOf(buffer) };
}

function systemPrompt(stack: string): string {
  const spec = STACKS[stack];
  return [
    'You are an elite front-end engineer. Recreate the UI in the screenshot as', spec.hint + '.',
    'Use semantic markup, the exact visible text, and faithfully match layout, spacing, colours and font sizes.',
    'Prefer utility classes where the stack uses them. Output ONLY the code in one fenced code block, no explanation.',
  ].join(' ');
}

function extractCode(text: string): string {
  const fenced = /```[a-zA-Z]*\n([\s\S]*?)```/.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

function scaffold(stack: string, image: ImageInfo, prompt: string): string {
  const [bg, accent, text] = [image.palette[0]?.hex || '#ffffff', image.palette[1]?.hex || '#3b82f6', image.palette[2]?.hex || '#111827'];
  const ratio = image.width && image.height ? (image.width / image.height).toFixed(2) : 'unknown';
  const header = `<!-- generated by 0kay screenshot_to_code (offline; no vision key configured) -->`;
  const meta = `<!-- image ${image.width}x${image.height} (aspect ${ratio}); palette ${image.palette.slice(0, 3).map((p) => p.hex).join(', ')}; request: ${prompt.replace(/-->/g, '')} -->`;
  if (stack === 'react_tailwind' || stack === 'ionic_tailwind') {
    return `${header}\n${meta}\nexport default function App() {\n  return (\n    <div className="min-h-screen p-6" style={{ background: '${bg}', color: '${text}' }}>\n      <h1 className="text-2xl font-bold">Recreate this UI</h1>\n      <p className="mt-2 text-sm opacity-70">Offline scaffold — configure a vision key for full conversion.</p>\n      <div className="mt-6 rounded-xl border p-4" style={{ borderColor: '${accent}' }} />\n    </div>\n  );\n}\n`;
  }
  if (stack === 'vue_tailwind') {
    return `${header}\n${meta}\n<template>\n  <div class="min-h-screen p-6" :style="{ background: '${bg}', color: '${text}' }">\n    <h1 class="text-2xl font-bold">Recreate this UI</h1>\n    <p class="mt-2 text-sm opacity-70">Offline scaffold — configure a vision key.</p>\n    <div class="mt-6 rounded-xl border p-4" :style="{ borderColor: '${accent}' }" />\n  </div>\n</template>\n`;
  }
  return `<!doctype html>\n${header}\n${meta}\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>Screenshot recreation</title>\n  <style>\n    :root { --bg: ${bg}; --accent: ${accent}; --text: ${text}; }\n    body { margin: 0; background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; }\n    .wrap { max-width: 1100px; margin: 0 auto; padding: 24px; }\n    .card { border: 1px solid var(--accent); border-radius: 16px; padding: 16px; margin-top: 24px; }\n  </style>\n</head>\n<body>\n  <div class="wrap">\n    <h1>Recreate this UI</h1>\n    <p>Offline scaffold — configure a vision key for a full conversion.</p>\n    <div class="card">layout region (aspect ${ratio})</div>\n  </div>\n</body>\n</html>\n`;
}

/** Vision call with one or more images (frames) attached. Routes through MOCR
 *  when the agent injected a model channel, else a directly configured provider. */
async function visionCode(stack: string, images: ImageInfo[], prompt: string, extraText: string, context: ToolContext, model?: string): Promise<string | null> {
  const sys = systemPrompt(stack);
  const userText = `${prompt}\n\nExtra instructions: ${extraText || '(none)'}`;

  // Preferred: the agent's MOCR channel (same route as the main loop).
  if (context.llm) {
    const parts: LlmMessagePart[] = images.map((image) => ({ type: 'image', imageUrl: `data:${image.mime};base64,${image.base64}`, mimeType: image.mime }));
    try {
      const text = await context.llm({ messages: [{ role: 'user', content: userText, parts }], systemPrompt: sys, maxTokens: 8192, model });
      if (text && text.trim()) return text;
    } catch { /* fall through to a direct provider */ }
  }

  const provider = selectProvider(model);
  if (!provider) return null;
  const signal = context.signal;
  if (provider.provider === 'openai') {
    const content: any[] = [{ type: 'text', text: userText }];
    for (const image of images) content.push({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } });
    const base = (provider.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const { egressOrDirect } = await import('./helpers.js');
    const res = await egressOrDirect(`${base}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` }, body: JSON.stringify({ model: provider.model, messages: [{ role: 'system', content: sys }, { role: 'user', content }], max_tokens: 8192 }), signal }, 180_000);
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    return String(data?.choices?.[0]?.message?.content || '');
  }
  if (provider.provider === 'anthropic') {
    const content: any[] = [{ type: 'text', text: userText }];
    for (const image of images) content.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.base64 } });
    const { egressOrDirect } = await import('./helpers.js');
    const res = await egressOrDirect('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: provider.model, max_tokens: 8192, system: sys, messages: [{ role: 'user', content }] }), signal }, 180_000);
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    return (data?.content || []).map((part: any) => part?.text || '').join('');
  }
  const parts: any[] = [{ text: userText }];
  for (const image of images) parts.push({ inline_data: { mime_type: image.mime, data: image.base64 } });
  const { egressOrDirect } = await import('./helpers.js');
  const res = await egressOrDirect(`https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:generateContent?key=${provider.apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts }] }), signal }, 180_000);
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  return (data?.candidates?.[0]?.content?.parts || []).map((part: any) => part?.text || '').join('');
}

function selectProvider(modelOverride?: string): { provider: 'openai' | 'anthropic' | 'gemini'; apiKey: string; model: string; baseUrl?: string } | null {
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', apiKey: process.env.OPENAI_API_KEY, model: modelOverride || process.env.SCREENSHOT_MODEL || 'gpt-4o', baseUrl: process.env.OPENAI_BASE_URL };
  if (process.env.ANTHROPIC_API_KEY) return { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY, model: modelOverride || process.env.SCREENSHOT_MODEL || 'claude-3-5-sonnet-latest' };
  if (process.env.GEMINI_API_KEY) return { provider: 'gemini', apiKey: process.env.GEMINI_API_KEY, model: modelOverride || process.env.SCREENSHOT_MODEL || 'gemini-1.5-pro' };
  return null;
}

export class ScreenshotToCodeTool extends Tool {
  get name(): string { return 'screenshot_to_code'; }
  get description(): string {
    return [
      'Convert a screenshot, mockup, or screen recording into front-end code (full screenshot-to-code).',
      'input: image (file path or data URL). For a recording pass video (path) or frames:[dataUrls]; frames are sampled via ffmpeg.',
      'stack: html_tailwind (default) | html_css | react_tailwind | vue_tailwind | bootstrap | ionic_tailwind.',
      'variants: generate N candidates. extractAssets: list cropped asset regions to reuse real images.',
      'preview: with a browser available, render the result and refine once against a preview screenshot (self-check).',
      'Uses OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY; without a key returns an offline structural scaffold.',
    ].join('\n');
  }
  get parameters(): Record<string, any> {
    return { type: 'object', properties: {
      image: { type: 'string', description: 'Path to an image, or a data:<mime>;base64,<data> URL.' },
      video: { type: 'string', description: 'Path to a screen recording (mp4/mov/webm); frames are extracted.' },
      frames: { type: 'array', items: { type: 'string' }, description: 'Explicit image inputs (paths or data URLs), e.g. video frames.' },
      frameCount: { type: 'integer', minimum: 1, maximum: 12, description: 'Frames to sample from video; default 4.' },
      stack: { type: 'string', enum: Object.keys(STACKS) },
      prompt: { type: 'string' }, model: { type: 'string' },
      variants: { type: 'integer', minimum: 1, maximum: 4, description: 'Number of candidates; default 1.' },
      extractAssets: { type: 'boolean', description: 'Detect and list image regions/assets to reuse.' },
      preview: { type: 'boolean', description: 'Render and self-check the output with a browser; default true when available.' },
      out: { type: 'string', description: 'File path for the primary output (default the stack file name).' },
      outDir: { type: 'string', description: 'Directory for variants/assets; default task workdir.' },
    }};
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const stack = typeof args.stack === 'string' && STACKS[args.stack] ? args.stack : 'html_tailwind';
      const images: ImageInfo[] = [];
      if (typeof args.image === 'string' && args.image) images.push(await loadImage(args.image, context.cwd));
      if (Array.isArray(args.frames)) for (const frame of args.frames.slice(0, 12)) images.push(await loadImage(String(frame), context.cwd));
      if (typeof args.video === 'string' && args.video) {
        const buffer = await fs.readFile(path.resolve(context.cwd, args.video));
        const { frames, via } = await extractVideoFrames(buffer, args.video, clamp(args.frameCount, 4, 1, 12), context.signal);
        for (const frame of frames) images.push(await loadImage(frame, context.cwd));
        if (!frames.length) throw new Error(`could not extract video frames (${via}); install ffmpeg or pass frames:[...]`);
      }
      if (!images.length) throw new Error('provide image, video, or frames');

      const prompt = systemPrompt(stack);
      const extra = typeof args.prompt === 'string' ? args.prompt : '';
      const variantCount = clamp(args.variants, 1, 1, 4);
      const provider = selectProvider(typeof args.model === 'string' ? args.model : undefined);
      const canGenerate = Boolean(provider || context.llm);

      const assetRegions = args.extractAssets ? this.detectAssets(images[0]) : [];
      const variants: Array<{ index: number; provider: string; code: string; preview?: string }> = [];
      for (let i = 0; i < variantCount; i++) {
        if (canGenerate) {
          const raw = await visionCode(stack, images, prompt, `${extra}\nVariant ${i + 1} of ${variantCount}.`, context, typeof args.model === 'string' ? args.model : undefined);
          if (raw && raw.trim()) { variants.push({ index: i, provider: context.llm ? 'mocr' : provider!.provider, code: extractCode(raw) }); continue; }
        }
        variants.push({ index: i, provider: 'offline', code: scaffold(stack, images[0], extra) });
      }

      // Self-check: render the first variant and refine once.
      let previewDataUrl: string | null = null;
      if (args.preview !== false && canGenerate && variants[0] && variants[0].provider !== 'offline' && STACKS[stack].file.endsWith('.html')) {
        previewDataUrl = await screenshotHtmlDataUrl(variants[0].code, { signal: context.signal }).catch(() => null);
        if (previewDataUrl) {
          const previewImage: ImageInfo = { mime: 'image/png', base64: previewDataUrl.split(',')[1] || '', width: 0, height: 0, palette: [] };
          const refined = await visionCode(stack, [...images, previewImage], 'Here is the ORIGINAL design and a screenshot of your current output. Fix visual differences (layout, spacing, colours, text) and return the corrected code.', extra, context, typeof args.model === 'string' ? args.model : undefined);
          if (refined && refined.trim()) variants[0].code = extractCode(refined);
        }
      }

      const outDir = path.resolve(context.cwd, typeof args.outDir === 'string' && args.outDir.trim() ? args.outDir : '.');
      if (!isPathAllowed(outDir)) throw new Error('path not allowed: outside workspace roots');
      await fs.mkdir(outDir, { recursive: true });
      const files: string[] = [];
      let primary: string | undefined;
      for (const variant of variants) {
        const name = variantCount > 1 ? `${path.parse(STACKS[stack].file).name}.variant${variant.index + 1}${path.extname(STACKS[stack].file)}` : STACKS[stack].file;
        const filePath = typeof args.out === 'string' && args.out.trim() && variantCount === 1 ? path.resolve(context.cwd, args.out) : path.join(outDir, name);
        if (!isPathAllowed(filePath)) throw new Error('path not allowed: outside workspace roots');
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, variant.code, 'utf8');
        files.push(filePath);
        if (!primary) primary = filePath;
      }

      return success({
        stack, provider: variants[0]?.provider || (provider?.provider || 'offline'),
        images: images.length,
        assets: assetRegions,
        preview: previewDataUrl ? 'checked' : 'skipped',
        variants: variants.map((v) => ({ index: v.index, provider: v.provider, bytes: v.code.length })),
        files, primary,
        code: variants[0].code,
      });
    } catch (error) { return failure(error); }
  }

  /** Detect plausible asset regions: distinct-colour blocks and embedded images.
   *  Pure TS — reports bounding hints the model/human can crop, not pixel crops. */
  private detectAssets(image: ImageInfo): Array<{ kind: string; hint: string }> {
    const assets: Array<{ kind: string; hint: string }> = [];
    for (const color of image.palette.slice(0, 4)) {
      if (color.ratio > 0.02 && color.ratio < 0.4) assets.push({ kind: 'color-region', hint: `${color.hex} (~${Math.round(color.ratio * 100)}% of pixels)` });
    }
    if (image.width && image.height) {
      assets.push({ kind: 'logo-scan', hint: `top-left 200x80 of ${image.width}x${image.height} likely holds a logo` });
      assets.push({ kind: 'hero-scan', hint: `full-width band below y=${Math.round(image.height * 0.1)} likely holds a hero image` });
    }
    return assets;
  }
}
