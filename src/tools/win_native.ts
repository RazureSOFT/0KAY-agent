/**
 * Native Windows backend for the computer-use tool.
 *
 * Uses `koffi` (a prebuilt FFI library — no compiler, no PowerShell, no process
 * spawn) to call user32/gdi32/gdiplus directly:
 *
 *  - screen capture: StretchBlt into a DIB + GDI+ JPEG encode (~30ms/frame),
 *  - mouse: SetCursorPos + mouse_event,
 *  - keyboard: SendInput (virtual-key hotkeys and unicode text),
 *  - window list: EnumWindows.
 *
 * `koffi` is an optional dependency and is loaded lazily, only on Windows, so
 * the package still installs and runs on macOS/Linux/CI without it.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);

export interface NativeCapture {
  buffer: Buffer;
  width: number;
  height: number;
}

interface NativeApi {
  screenSize(): { width: number; height: number };
  capture(width: number, quality: number): NativeCapture;
  moveMouse(x: number, y: number): void;
  click(x: number, y: number, button: 'left' | 'right', double: boolean): void;
  drag(x1: number, y1: number, x2: number, y2: number, button: 'left' | 'right', durationMs: number): void;
  scroll(delta: number): void;
  typeText(text: string): void;
  pressHotkey(spec: string): void;
  listWindows(): string[];
}

let api: NativeApi | null = null;
let failure: string | null = null;

/** True when the native backend is available on this Windows host. */
export function nativeAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  try { ensureNative(); return true; } catch { return false; }
}

/** Lazily initialise (and cache) the native API; throws a clear error if unavailable. */
export function ensureNative(): NativeApi {
  if (api) return api;
  if (failure) throw new Error(failure);
  try {
    api = init();
    return api;
  } catch (error: any) {
    failure = `computeruse native backend unavailable (${error?.message || error}); install optional dependency "koffi"`;
    throw new Error(failure);
  }
}

function init(): NativeApi {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const gdi32 = koffi.load('gdi32.dll');
  const gdiplus = koffi.load('gdiplus.dll');

  // --- GDI+ (JPEG encoder) -------------------------------------------------
  const GdiplusStartupInput = koffi.struct('GdiplusStartupInput', {
    GdiplusVersion: 'uint32', DebugEventCallback: 'void*', SuppressBackgroundThread: 'int32', SuppressExternalCodecs: 'int32',
  });
  const GUID = koffi.struct('GUID', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: koffi.array('uint8', 8) });
  const EncoderParameter = koffi.struct('EncoderParameter', { Guid: 'GUID', NumberOfValues: 'uint32', Type: 'uint32', Value: 'void*' });
  const EncoderParameters = koffi.struct('EncoderParameters', { Count: 'uint32', Param: koffi.array('EncoderParameter', 1) });

  const GdiplusStartup = gdiplus.func('int __stdcall GdiplusStartup(_Out_ uintptr_t*, GdiplusStartupInput*, void*)');
  const GdipCreateBitmapFromHBITMAP = gdiplus.func('int __stdcall GdipCreateBitmapFromHBITMAP(void*, void*, _Out_ void**)');
  const GdipSaveImageToFile = gdiplus.func('int __stdcall GdipSaveImageToFile(void*, const char16_t*, GUID*, EncoderParameters*)');
  const GdipDisposeImage = gdiplus.func('int __stdcall GdipDisposeImage(void*)');

  const token = [null];
  if (GdiplusStartup(token, { GdiplusVersion: 1, DebugEventCallback: null, SuppressBackgroundThread: 0, SuppressExternalCodecs: 0 }, null) !== 0) {
    throw new Error('GdiplusStartup failed');
  }

  const JPEG_CLSID = { Data1: 0x557CF401, Data2: 0x1A04, Data3: 0x11D3, Data4: [0x9A, 0x73, 0x00, 0x00, 0xF8, 0x1E, 0xF3, 0x2E] };
  const QUALITY_GUID = { Data1: 0x1D5BE4B5, Data2: 0xFA4A, Data3: 0x452D, Data4: [0x9C, 0xDD, 0x5D, 0xB3, 0x51, 0x05, 0xE7, 0xEB] };

  // --- GDI capture ---------------------------------------------------------
  const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int)');
  const GetDC = user32.func('void* __stdcall GetDC(void*)');
  const ReleaseDC = user32.func('int __stdcall ReleaseDC(void*, void*)');
  const CreateCompatibleDC = gdi32.func('void* __stdcall CreateCompatibleDC(void*)');
  const CreateCompatibleBitmap = gdi32.func('void* __stdcall CreateCompatibleBitmap(void*, int, int)');
  const SelectObject = gdi32.func('void* __stdcall SelectObject(void*, void*)');
  const StretchBlt = gdi32.func('bool __stdcall StretchBlt(void*, int, int, int, int, void*, int, int, int, int, uint32)');
  const SetStretchBltMode = gdi32.func('int __stdcall SetStretchBltMode(void*, int)');
  const DeleteDC = gdi32.func('bool __stdcall DeleteDC(void*)');
  const DeleteObject = gdi32.func('bool __stdcall DeleteObject(void*)');
  const SRCCOPY = 0x00CC0020;

  // --- input ---------------------------------------------------------------
  const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int, int)');
  const mouseEvent = user32.func('void __stdcall mouse_event(uint32, int32, int32, uint32, uintptr_t)');
  const MOUSEINPUT = koffi.struct('MOUSEINPUT', { dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
  const INPUTUNION = koffi.union('INPUTUNION', { mi: MOUSEINPUT, ki: KEYBDINPUT });
  const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUTUNION });
  const SendInput = user32.func('uint32 __stdcall SendInput(uint32, INPUT*, int32)');
  const INPUT_KEYBOARD = 1;
  const KEYEVENTF_KEYUP = 0x0002;
  const KEYEVENTF_UNICODE = 0x0004;
  const INPUT_SIZE = koffi.sizeof(INPUT);

  const VK: Record<string, number> = {
    enter: 0x0D, return: 0x0D, tab: 0x09, escape: 0x1B, esc: 0x1B, backspace: 0x08, delete: 0x2E, del: 0x2E,
    insert: 0x2D, ins: 0x2D, space: 0x20, home: 0x24, end: 0x23, pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22,
    left: 0x25, up: 0x26, right: 0x27, down: 0x28, capslock: 0x14, printscreen: 0x2C, scrolllock: 0x91, pause: 0x13,
    shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12, win: 0x5B, meta: 0x5B, cmd: 0x5B,
    ';': 0xBA, '=': 0xBB, ',': 0xBC, '-': 0xBD, '.': 0xBE, '/': 0xBF, '`': 0xC0, '[': 0xDB, '\\': 0xDC, ']': 0xDD, "'": 0xDE,
  };

  function vkFor(name: string): number {
    const key = name.toLowerCase();
    if (key in VK) return VK[key];
    if (/^[a-z]$/.test(key)) return key.toUpperCase().charCodeAt(0);
    if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
    const fn = key.match(/^f([1-9]|1[0-9]|2[0-4])$/);
    if (fn) return 0x70 + (Number(fn[1]) - 1);
    throw new Error(`unsupported key: ${name}`);
  }

  function keyboardInputs(entries: Array<{ vk?: number; scan?: number; up?: boolean }>): any[] {
    return entries.map((entry) => ({
      type: INPUT_KEYBOARD,
      u: { ki: { wVk: entry.vk || 0, wScan: entry.scan || 0, dwFlags: (entry.scan !== undefined ? KEYEVENTF_UNICODE : 0) | (entry.up ? KEYEVENTF_KEYUP : 0), time: 0, dwExtraInfo: 0 } },
    }));
  }

  function sendKeyboard(entries: Array<{ vk?: number; scan?: number; up?: boolean }>): void {
    const inputs = keyboardInputs(entries);
    const sent = SendInput(inputs.length, inputs, INPUT_SIZE);
    if (sent !== inputs.length) throw new Error(`SendInput failed (${sent}/${inputs.length})`);
  }

  // Reused capture resources; rebuilt only when the target size changes.
  let cachedWidth = 0;
  let cachedHeight = 0;
  let cachedDc: any = null;
  let cachedScreenDc: any = null;
  let cachedBitmap: any = null;
  let cachedOld: any = null;
  const jpegPath = path.join(os.tmpdir(), `0kay-native-${process.pid}.jpg`);

  function prepare(width: number, screenW: number, screenH: number): { tw: number; th: number } {
    const tw = width > 0 && width < screenW ? width : screenW;
    const th = Math.max(1, Math.round(screenH * tw / screenW));
    if (tw === cachedWidth && screenW === cachedScreenW && screenH === cachedScreenH) {
      return { tw, th };
    }
    cleanup();
    cachedScreenW = screenW;
    cachedScreenH = screenH;
    cachedScreenDc = GetDC(null);
    cachedDc = CreateCompatibleDC(cachedScreenDc);
    cachedBitmap = CreateCompatibleBitmap(cachedScreenDc, tw, th);
    cachedOld = SelectObject(cachedDc, cachedBitmap);
    SetStretchBltMode(cachedDc, 3);
    cachedWidth = tw;
    cachedHeight = th;
    return { tw, th };
  }

  let cachedScreenW = 0;
  let cachedScreenH = 0;

  function cleanup(): void {
    try { if (cachedDc && cachedOld) SelectObject(cachedDc, cachedOld); } catch { /* ignore */ }
    try { if (cachedBitmap) DeleteObject(cachedBitmap); } catch { /* ignore */ }
    try { if (cachedDc) DeleteDC(cachedDc); } catch { /* ignore */ }
    try { if (cachedScreenDc) ReleaseDC(null, cachedScreenDc); } catch { /* ignore */ }
    cachedDc = cachedBitmap = cachedOld = cachedScreenDc = null;
    cachedWidth = cachedHeight = cachedScreenW = cachedScreenH = 0;
  }

  function capture(width: number, quality: number): NativeCapture {
    const screenW = GetSystemMetrics(0);
    const screenH = GetSystemMetrics(1);
    const { tw, th } = prepare(width, screenW, screenH);
    if (!StretchBlt(cachedDc, 0, 0, tw, th, cachedScreenDc, 0, 0, screenW, screenH, SRCCOPY)) {
      cleanup();
      throw new Error('StretchBlt failed');
    }
    const bitmap = [null];
    if (GdipCreateBitmapFromHBITMAP(cachedBitmap, null, bitmap) !== 0) throw new Error('GdipCreateBitmapFromHBITMAP failed');
    const q = Buffer.alloc(4);
    q.writeUInt32LE(Math.max(1, Math.min(100, quality)), 0);
    const params = { Count: 1, Param: [{ Guid: QUALITY_GUID, NumberOfValues: 1, Type: 4, Value: q }] };
    const status = GdipSaveImageToFile(bitmap[0], jpegPath, JPEG_CLSID, params);
    GdipDisposeImage(bitmap[0]);
    if (status !== 0) throw new Error(`GdipSaveImageToFile failed (${status})`);
    return { buffer: readFileSync(jpegPath), width: tw, height: th };
  }

  function vkInputs(spec: string): Array<{ vk?: number; up?: boolean }> {
    const parts = spec.toLowerCase().split('+').map((value) => value.trim());
    const key = parts.pop() || '';
    if (!key) throw new Error(`unsupported key: ${spec}`);
    const modifierVk = parts.map((part) => {
      const vk = vkFor(part);
      if (![0x10, 0x11, 0x12, 0x5B].includes(vk)) throw new Error(`unsupported modifier: ${part}`);
      return vk;
    });
    const keyVk = vkFor(key);
    const entries: Array<{ vk?: number; up?: boolean }> = [];
    for (const vk of modifierVk) entries.push({ vk });
    entries.push({ vk: keyVk });
    entries.push({ vk: keyVk, up: true });
    for (const vk of [...modifierVk].reverse()) entries.push({ vk, up: true });
    return entries;
  }

  function sleep(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  function listWindows(): string[] {
    const WNDENUMPROC = koffi.proto('bool WNDENUMPROC(void* hwnd, intptr_t lparam)');
    const EnumWindows = user32.func('bool __stdcall EnumWindows(WNDENUMPROC*, intptr_t)');
    const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void*)');
    const GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(void*)');
    const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void*, void*, int)');
    const titles: string[] = [];
    const callback = koffi.register((hwnd: any) => {
      try {
        if (IsWindowVisible(hwnd)) {
          const length = GetWindowTextLengthW(hwnd);
          if (length > 0) {
            const buffer = Buffer.alloc((length + 1) * 2);
            GetWindowTextW(hwnd, buffer, length + 1);
            const title = buffer.toString('utf16le').replace(/\0.*$/s, '').trim();
            if (title) titles.push(title);
          }
        }
      } catch { /* skip window */ }
      return true;
    }, koffi.pointer(WNDENUMPROC));
    try {
      EnumWindows(callback, 0);
    } finally {
      koffi.unregister(callback);
    }
    return titles;
  }

  return {
    screenSize: () => ({ width: GetSystemMetrics(0), height: GetSystemMetrics(1) }),
    capture,
    moveMouse: (x: number, y: number) => { if (!SetCursorPos(x, y)) throw new Error('SetCursorPos failed'); },
    click: (x: number, y: number, button: 'left' | 'right', double: boolean) => {
      if (!SetCursorPos(x, y)) throw new Error('SetCursorPos failed');
      const down = button === 'right' ? 0x0008 : 0x0002;
      const up = button === 'right' ? 0x0010 : 0x0004;
      mouseEvent(down, 0, 0, 0, 0);
      mouseEvent(up, 0, 0, 0, 0);
      if (double) {
        sleep(60);
        mouseEvent(down, 0, 0, 0, 0);
        mouseEvent(up, 0, 0, 0, 0);
      }
    },
    scroll: (delta: number) => { mouseEvent(0x0800, 0, 0, -delta * 120, 0); },
    drag: (x1: number, y1: number, x2: number, y2: number, button: 'left' | 'right', durationMs: number) => {
      if (!SetCursorPos(x1, y1)) throw new Error('SetCursorPos failed');
      const down = button === 'right' ? 0x0008 : 0x0002;
      const up = button === 'right' ? 0x0010 : 0x0004;
      mouseEvent(down, 0, 0, 0, 0);
      try {
        const steps = Math.max(8, Math.min(48, Math.round((durationMs || 300) / 12)));
        const pause = Math.max(1, Math.round((durationMs || 300) / steps));
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          SetCursorPos(Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t));
          sleep(pause);
        }
        SetCursorPos(x2, y2);
      } finally {
        mouseEvent(up, 0, 0, 0, 0);
      }
    },
    typeText: (text: string) => {
      const entries: Array<{ scan: number; up?: boolean }> = [];
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        entries.push({ scan: code });
        entries.push({ scan: code, up: true });
      }
      if (entries.length) sendKeyboard(entries);
    },
    pressHotkey: (spec: string) => sendKeyboard(vkInputs(spec)),
    listWindows,
  };
}
