/**
 * Native macOS/Linux input backend for the computer-use tool.
 *
 * Mirrors the Windows backend in `win_native.ts`: it uses `koffi` (prebuilt
 * FFI, no compiler, no process spawn) to drive the pointer and keyboard
 * directly instead of shelling out to `osascript`/`cliclick`/`xdotool` for every
 * action, which is what made control feel sluggish.
 *
 *  - macOS: CoreGraphics (`CGEvent*`) — posts mouse/key events and unicode text.
 *  - Linux: X11 + XTest (`XTestFake*`) — works on X11 (not Wayland, where the
 *    caller falls back to `xdotool`/`ydotool`).
 *
 * Anything unsupported or unavailable returns `null`/`false`, and the tool
 * falls back to the previous shell-based implementation, so nothing regresses.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface PosixInput {
  moveMouse(x: number, y: number): void;
  click(x: number, y: number, button: 'left' | 'right', double: boolean): void;
  drag(x1: number, y1: number, x2: number, y2: number, button: 'left' | 'right', durationMs: number): void;
  scroll(delta: number): void;
  /** Returns false when this backend cannot type the text (caller falls back). */
  typeText(text: string): boolean;
  /** Returns false when the spec/key is unsupported (caller falls back). */
  pressHotkey(spec: string): boolean;
}

let cached: PosixInput | null = null;
let resolved = false;

/** Native input backend for this platform, or null to use the shell fallback. */
export function posixInput(): PosixInput | null {
  if (resolved) return cached;
  resolved = true;
  try {
    if (process.platform === 'darwin') cached = initMac();
    else if (process.platform === 'linux') cached = initLinux();
    else cached = null;
  } catch {
    cached = null;
  }
  return cached;
}

// ---------------------------------------------------------------------------
// macOS (CoreGraphics)
// ---------------------------------------------------------------------------

const MAC_KEYCODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15,
  y: 16, t: 17, '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25, '7': 26,
  '-': 27, '8': 28, '0': 29, ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, l: 37, j: 38, "'": 39,
  k: 40, ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, tab: 48, space: 49, '`': 50,
  delete: 51, backspace: 51, escape: 53, esc: 53, command: 55, cmd: 55, meta: 55, win: 55, super: 55,
  shift: 56, capslock: 57, alt: 58, option: 58, ctrl: 59, control: 59,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  home: 115, end: 119, pageup: 116, pagedown: 121, left: 123, right: 124, down: 125, up: 126,
  enter: 36, return: 36, insert: 114, forwarddelete: 117,
};

function koffiLib(): any {
  return require('koffi');
}

function initMac(): PosixInput | null {
  const koffi = koffiLib();
  const app = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
  const CGPoint = koffi.struct('CGPoint', { x: 'double', y: 'double' });

  const CGEventCreateMouseEvent = app.func('void* CGEventCreateMouseEvent(void*, uint32, CGPoint, uint32)');
  const CGEventCreateKeyboardEvent = app.func('void* CGEventCreateKeyboardEvent(void*, uint16, bool)');
  const CGEventCreateScrollWheelEvent = app.func('void* CGEventCreateScrollWheelEvent(void*, uint32, uint32, int32)');
  const CGEventPost = app.func('void CGEventPost(uint32, void*)');
  const CGEventSetFlags = app.func('void CGEventSetFlags(void*, uint64)');
  const CGEventSetIntegerValueField = app.func('void CGEventSetIntegerValueField(void*, uint32, int64)');
  const CGEventKeyboardSetUnicodeString = app.func('void CGEventKeyboardSetUnicodeString(void*, uint64, void*)');
  const CFRelease = app.func('void CFRelease(void*)');

  const HID_TAP = 0;
  const MOUSE_MOVED = 5, LEFT_DOWN = 1, LEFT_UP = 2, RIGHT_DOWN = 3, RIGHT_UP = 4, LEFT_DRAGGED = 6, RIGHT_DRAGGED = 7;
  const BUTTON_LEFT = 0, BUTTON_RIGHT = 1;
  const CLICK_STATE_FIELD = 1;
  const FLAG_SHIFT = 0x20000, FLAG_CTRL = 0x40000, FLAG_ALT = 0x80000, FLAG_CMD = 0x100000;

  function postMouse(type: number, x: number, y: number, button: number, clickState = 0): void {
    const event = CGEventCreateMouseEvent(null, type, { x, y }, button);
    if (!event) throw new Error('CGEventCreateMouseEvent failed');
    try {
      if (clickState) CGEventSetIntegerValueField(event, CLICK_STATE_FIELD, clickState);
      CGEventPost(HID_TAP, event);
    } finally {
      CFRelease(event);
    }
  }

  function modifierFlags(parts: string[]): number {
    let flags = 0;
    for (const part of parts) {
      switch (part) {
        case 'cmd': case 'command': case 'meta': case 'win': case 'super': flags |= FLAG_CMD; break;
        case 'ctrl': case 'control': flags |= FLAG_CTRL; break;
        case 'alt': case 'option': flags |= FLAG_ALT; break;
        case 'shift': flags |= FLAG_SHIFT; break;
        default: throw new Error(`unsupported modifier: ${part}`);
      }
    }
    return flags;
  }

  function postKey(keycode: number, down: boolean, flags: number): void {
    const event = CGEventCreateKeyboardEvent(null, keycode, down);
    if (!event) throw new Error('CGEventCreateKeyboardEvent failed');
    try {
      if (flags) CGEventSetFlags(event, flags);
      CGEventPost(HID_TAP, event);
    } finally {
      CFRelease(event);
    }
  }

  return {
    moveMouse: (x, y) => postMouse(MOUSE_MOVED, x, y, BUTTON_LEFT),
    click: (x, y, button, double) => {
      const down = button === 'right' ? RIGHT_DOWN : LEFT_DOWN;
      const up = button === 'right' ? RIGHT_UP : LEFT_UP;
      const code = button === 'right' ? BUTTON_RIGHT : BUTTON_LEFT;
      postMouse(down, x, y, code, 1);
      postMouse(up, x, y, code, 1);
      if (double) {
        postMouse(down, x, y, code, 2);
        postMouse(up, x, y, code, 2);
      }
    },
    drag: (x1, y1, x2, y2, button, durationMs) => {
      const down = button === 'right' ? RIGHT_DOWN : LEFT_DOWN;
      const up = button === 'right' ? RIGHT_UP : LEFT_UP;
      const dragged = button === 'right' ? RIGHT_DRAGGED : LEFT_DRAGGED;
      const code = button === 'right' ? BUTTON_RIGHT : BUTTON_LEFT;
      postMouse(down, x1, y1, code, 1);
      const steps = Math.max(8, Math.min(48, Math.round((durationMs || 300) / 12)));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        postMouse(dragged, Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t), code, 0);
      }
      postMouse(up, x2, y2, code, 1);
    },
    scroll: (delta) => {
      const event = CGEventCreateScrollWheelEvent(null, 1, 1, -delta); // unit=line
      if (!event) throw new Error('CGEventCreateScrollWheelEvent failed');
      try { CGEventPost(HID_TAP, event); } finally { CFRelease(event); }
    },
    typeText: (text) => {
      if (!text) return true;
      const buffer = Buffer.from(text, 'utf16le');
      const down = CGEventCreateKeyboardEvent(null, 0, true);
      const up = CGEventCreateKeyboardEvent(null, 0, false);
      if (!down || !up) { if (down) CFRelease(down); if (up) CFRelease(up); throw new Error('CGEventCreateKeyboardEvent failed'); }
      try {
        CGEventKeyboardSetUnicodeString(down, text.length, buffer);
        CGEventPost(HID_TAP, down);
        CGEventKeyboardSetUnicodeString(up, text.length, buffer);
        CGEventPost(HID_TAP, up);
      } finally {
        CFRelease(down); CFRelease(up);
      }
      return true;
    },
    pressHotkey: (spec) => {
      const parts = spec.toLowerCase().split('+').map((value) => value.trim());
      const key = parts.pop() || '';
      if (!key) throw new Error(`unsupported key: ${spec}`);
      const flags = modifierFlags(parts);
      const keycode = MAC_KEYCODES[key];
      if (keycode === undefined) return false;
      postKey(keycode, true, flags);
      postKey(keycode, false, flags);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Linux (X11 + XTest)
// ---------------------------------------------------------------------------

function initLinux(): PosixInput | null {
  if (!process.env.DISPLAY) return null;
  const koffi = koffiLib();
  const x11 = koffi.load('libX11.so.6');
  const xtst = koffi.load('libXtst.so.6');
  const XOpenDisplay = x11.func('void* XOpenDisplay(const char*)');
  const XFlush = x11.func('int XFlush(void*)');
  const XStringToKeysym = x11.func('unsigned long XStringToKeysym(const char*)');
  const XKeysymToKeycode = x11.func('unsigned char XKeysymToKeycode(void*, unsigned long)');
  const XTestFakeMotionEvent = xtst.func('int XTestFakeMotionEvent(void*, int, int, int, unsigned long)');
  const XTestFakeButtonEvent = xtst.func('int XTestFakeButtonEvent(void*, unsigned int, int, unsigned long)');
  const XTestFakeKeyEvent = xtst.func('int XTestFakeKeyEvent(void*, unsigned int, int, unsigned long)');

  const display = XOpenDisplay(null);
  if (!display) return null;

  const KEY_NAMES: Record<string, string> = {
    enter: 'Return', return: 'Return', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'BackSpace',
    delete: 'Delete', space: 'space', home: 'Home', end: 'End', pageup: 'Prior', pgup: 'Prior', pagedown: 'Next',
    pgdn: 'Next', left: 'Left', up: 'Up', right: 'Right', down: 'Down', insert: 'Insert',
    shift: 'Shift_L', ctrl: 'Control_L', control: 'Control_L', alt: 'Alt_L', option: 'Alt_L',
    cmd: 'Super_L', command: 'Super_L', meta: 'Super_L', win: 'Super_L', super: 'Super_L', capslock: 'Caps_Lock',
  };

  function keycodeFor(name: string): number {
    const key = name.toLowerCase();
    const symbol = KEY_NAMES[key] ?? (/^f([1-9]|1[0-9]|2[0-4])$/.test(key) ? key.toUpperCase() : key.length === 1 ? key : '');
    if (!symbol) throw new Error(`unsupported key: ${name}`);
    const keysym = XStringToKeysym(symbol);
    if (!keysym) throw new Error(`unsupported key: ${name}`);
    const keycode = XKeysymToKeycode(display, keysym);
    if (!keycode) throw new Error(`unsupported key: ${name}`);
    return keycode;
  }

  function tap(keycode: number, down: boolean): void {
    const ok = XTestFakeKeyEvent(display, keycode, down ? 1 : 0, 0);
    if (!ok) throw new Error('XTestFakeKeyEvent failed');
  }

  return {
    moveMouse: (x, y) => {
      if (!XTestFakeMotionEvent(display, -1, x, y, 0)) throw new Error('XTestFakeMotionEvent failed');
      XFlush(display);
    },
    click: (x, y, button, double) => {
      XTestFakeMotionEvent(display, -1, x, y, 0);
      const code = button === 'right' ? 3 : 1;
      for (let i = 0; i < (double ? 2 : 1); i++) {
        XTestFakeButtonEvent(display, code, 1, 0);
        XTestFakeButtonEvent(display, code, 0, 0);
      }
      XFlush(display);
    },
    drag: (x1, y1, x2, y2, button, durationMs) => {
      const code = button === 'right' ? 3 : 1;
      XTestFakeMotionEvent(display, -1, x1, y1, 0);
      XTestFakeButtonEvent(display, code, 1, 0);
      const steps = Math.max(8, Math.min(48, Math.round((durationMs || 300) / 12)));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        XTestFakeMotionEvent(display, -1, Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t), 0);
      }
      XTestFakeButtonEvent(display, code, 0, 0);
      XFlush(display);
    },
    scroll: (delta) => {
      const button = delta > 0 ? 5 : 4; // 5 = down, 4 = up
      for (let i = 0; i < Math.abs(delta); i++) {
        XTestFakeButtonEvent(display, button, 1, 0);
        XTestFakeButtonEvent(display, button, 0, 0);
      }
      XFlush(display);
    },
    // Arbitrary text needs the XKB layout; keep using `xdotool type` there.
    typeText: () => false,
    pressHotkey: (spec) => {
      const parts = spec.toLowerCase().split('+').map((value) => value.trim());
      const key = parts.pop() || '';
      if (!key) throw new Error(`unsupported key: ${spec}`);
      const modifiers = parts.map(keycodeFor);
      for (const code of modifiers) tap(code, true);
      const code = keycodeFor(key);
      tap(code, true);
      tap(code, false);
      for (const mod of [...modifiers].reverse()) tap(mod, false);
      XFlush(display);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
