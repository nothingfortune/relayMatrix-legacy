/**
 * What the Windows helper needs to know about a key: the hardware scan code it types, and
 * the virtual key its keyboard hook sees. One table, written here; the helper's script is
 * generated from it (`helper-script.ts`), so the two cannot drift.
 *
 * A DirectInput game reads scan codes and ignores an injected event that has only a virtual
 * key, so the helper types scan codes (`KEYEVENTF_SCANCODE`), with the extended flag where
 * the key has an `E0` prefix. The hook is given a virtual key, a scan code and that same
 * flag; it names a key by scan code and flag first, because only they tell the numpad's
 * Enter from the main Enter and an arrow from the numpad's 4 with Num Lock off.
 *
 * Pause, Print Screen and Num Lock have scan sequences that cannot be typed by one scan code
 * and flag (Pause is `E1 1D 45`), so they are never typed, and the hook finds them by
 * virtual key. They can still be a trigger.
 *
 * Node-free.
 */

import { STANDARD_BUTTONS } from "./controls.js";

export interface HelperKey {
  /** `KeyboardEvent.code`. */
  code: string;
  /** Set 1 scan code, without the `E0` prefix. */
  scan: number;
  /** Whether the key has the `E0` prefix (`KEYEVENTF_EXTENDEDKEY`). */
  extended: boolean;
  /** Windows virtual-key code. */
  vk: number;
  /** False for a key that is only ever read, never typed. */
  typeable: boolean;
}

type Row = readonly [code: string, scan: number, vk: number, extended?: boolean];

/** The keys of a standard keyboard, by `KeyboardEvent.code`. */
const ROWS: readonly Row[] = [
  ["Escape", 0x01, 0x1b],
  ["Digit1", 0x02, 0x31],
  ["Digit2", 0x03, 0x32],
  ["Digit3", 0x04, 0x33],
  ["Digit4", 0x05, 0x34],
  ["Digit5", 0x06, 0x35],
  ["Digit6", 0x07, 0x36],
  ["Digit7", 0x08, 0x37],
  ["Digit8", 0x09, 0x38],
  ["Digit9", 0x0a, 0x39],
  ["Digit0", 0x0b, 0x30],
  ["Minus", 0x0c, 0xbd],
  ["Equal", 0x0d, 0xbb],
  ["Backspace", 0x0e, 0x08],
  ["Tab", 0x0f, 0x09],
  ["KeyQ", 0x10, 0x51],
  ["KeyW", 0x11, 0x57],
  ["KeyE", 0x12, 0x45],
  ["KeyR", 0x13, 0x52],
  ["KeyT", 0x14, 0x54],
  ["KeyY", 0x15, 0x59],
  ["KeyU", 0x16, 0x55],
  ["KeyI", 0x17, 0x49],
  ["KeyO", 0x18, 0x4f],
  ["KeyP", 0x19, 0x50],
  ["BracketLeft", 0x1a, 0xdb],
  ["BracketRight", 0x1b, 0xdd],
  ["Enter", 0x1c, 0x0d],
  ["ControlLeft", 0x1d, 0xa2],
  ["KeyA", 0x1e, 0x41],
  ["KeyS", 0x1f, 0x53],
  ["KeyD", 0x20, 0x44],
  ["KeyF", 0x21, 0x46],
  ["KeyG", 0x22, 0x47],
  ["KeyH", 0x23, 0x48],
  ["KeyJ", 0x24, 0x4a],
  ["KeyK", 0x25, 0x4b],
  ["KeyL", 0x26, 0x4c],
  ["Semicolon", 0x27, 0xba],
  ["Quote", 0x28, 0xde],
  ["Backquote", 0x29, 0xc0],
  ["ShiftLeft", 0x2a, 0xa0],
  ["Backslash", 0x2b, 0xdc],
  ["KeyZ", 0x2c, 0x5a],
  ["KeyX", 0x2d, 0x58],
  ["KeyC", 0x2e, 0x43],
  ["KeyV", 0x2f, 0x56],
  ["KeyB", 0x30, 0x42],
  ["KeyN", 0x31, 0x4e],
  ["KeyM", 0x32, 0x4d],
  ["Comma", 0x33, 0xbc],
  ["Period", 0x34, 0xbe],
  ["Slash", 0x35, 0xbf],
  ["ShiftRight", 0x36, 0xa1],
  ["NumpadMultiply", 0x37, 0x6a],
  ["AltLeft", 0x38, 0xa4],
  ["Space", 0x39, 0x20],
  ["CapsLock", 0x3a, 0x14],
  ["F1", 0x3b, 0x70],
  ["F2", 0x3c, 0x71],
  ["F3", 0x3d, 0x72],
  ["F4", 0x3e, 0x73],
  ["F5", 0x3f, 0x74],
  ["F6", 0x40, 0x75],
  ["F7", 0x41, 0x76],
  ["F8", 0x42, 0x77],
  ["F9", 0x43, 0x78],
  ["F10", 0x44, 0x79],
  ["ScrollLock", 0x46, 0x91],
  ["Numpad7", 0x47, 0x67],
  ["Numpad8", 0x48, 0x68],
  ["Numpad9", 0x49, 0x69],
  ["NumpadSubtract", 0x4a, 0x6d],
  ["Numpad4", 0x4b, 0x64],
  ["Numpad5", 0x4c, 0x65],
  ["Numpad6", 0x4d, 0x66],
  ["NumpadAdd", 0x4e, 0x6b],
  ["Numpad1", 0x4f, 0x61],
  ["Numpad2", 0x50, 0x62],
  ["Numpad3", 0x51, 0x63],
  ["Numpad0", 0x52, 0x60],
  ["NumpadDecimal", 0x53, 0x6e],
  ["IntlBackslash", 0x56, 0xe2],
  ["F11", 0x57, 0x7a],
  ["F12", 0x58, 0x7b],
  // F13-F24: 0x64-0x6e, then 0x76. Checked against MapVirtualKey on a Windows machine.
  ["F13", 0x64, 0x7c],
  ["F14", 0x65, 0x7d],
  ["F15", 0x66, 0x7e],
  ["F16", 0x67, 0x7f],
  ["F17", 0x68, 0x80],
  ["F18", 0x69, 0x81],
  ["F19", 0x6a, 0x82],
  ["F20", 0x6b, 0x83],
  ["F21", 0x6c, 0x84],
  ["F22", 0x6d, 0x85],
  ["F23", 0x6e, 0x86],
  ["F24", 0x76, 0x87],
  // The E0 keys.
  ["NumpadEnter", 0x1c, 0x0d, true],
  ["ControlRight", 0x1d, 0xa3, true],
  ["NumpadDivide", 0x35, 0x6f, true],
  ["AltRight", 0x38, 0xa5, true],
  ["Home", 0x47, 0x24, true],
  ["ArrowUp", 0x48, 0x26, true],
  ["PageUp", 0x49, 0x21, true],
  ["ArrowLeft", 0x4b, 0x25, true],
  ["ArrowRight", 0x4d, 0x27, true],
  ["End", 0x4f, 0x23, true],
  ["ArrowDown", 0x50, 0x28, true],
  ["PageDown", 0x51, 0x22, true],
  ["Insert", 0x52, 0x2d, true],
  ["Delete", 0x53, 0x2e, true],
  ["MetaLeft", 0x5b, 0x5b, true],
  ["MetaRight", 0x5c, 0x5c, true],
  ["ContextMenu", 0x5d, 0x5d, true],
];

/** Read, never typed: found by virtual key, because their scan sequences are not one code. */
const READ_ONLY: readonly Row[] = [
  ["NumLock", 0x45, 0x90],
  ["Pause", 0x45, 0x13],
  ["PrintScreen", 0x37, 0x2c, true],
];

export const HELPER_KEYS: readonly HelperKey[] = [
  ...ROWS.map(([code, scan, vk, extended]) => ({
    code,
    scan,
    extended: extended === true,
    vk,
    typeable: true,
  })),
  ...READ_ONLY.map(([code, scan, vk, extended]) => ({
    code,
    scan,
    extended: extended === true,
    vk,
    typeable: false,
  })),
];

const BY_CODE: ReadonlyMap<string, HelperKey> = new Map(HELPER_KEYS.map((key) => [key.code, key]));

/** A key by `KeyboardEvent.code`, or undefined when the helper does not know it. */
export function helperKey(code: string): HelperKey | undefined {
  return BY_CODE.get(code);
}

/** Whether the helper can type this key. */
export function isTypeable(code: string): boolean {
  return BY_CODE.get(code)?.typeable === true;
}

/** Whether the helper's keyboard hook can recognise this key as a trigger. */
export function isReadable(code: string): boolean {
  return BY_CODE.has(code);
}

/** The panic key: held with Ctrl and Alt, it releases everything and stops the helper. */
export const PANIC_KEY_TEXT = "Ctrl+Alt+Pause";

/**
 * A controller button's bit in the helper's mask: XInput's `wButtons` for the buttons, and
 * two bits past its range for the triggers, which XInput reports as a 0-255 level. A trigger
 * counts as pressed above `PAD_TRIGGER_THRESHOLD`, XInput's own
 * `XINPUT_GAMEPAD_TRIGGER_THRESHOLD`.
 */
export const PAD_BITS: Readonly<Record<string, number>> = {
  DpadUp: 0x0001,
  DpadDown: 0x0002,
  DpadLeft: 0x0004,
  DpadRight: 0x0008,
  Menu: 0x0010,
  View: 0x0020,
  LS: 0x0040,
  RS: 0x0080,
  LB: 0x0100,
  RB: 0x0200,
  A: 0x1000,
  B: 0x2000,
  X: 0x4000,
  Y: 0x8000,
  LT: 0x10000,
  RT: 0x20000,
};

export const PAD_TRIGGER_THRESHOLD = 30;

/** Whether the helper can read this controller control. */
export function isReadablePad(control: string): boolean {
  return control in PAD_BITS;
}

/** The controls the browser's standard layout names, which the table must all cover. */
export const PAD_CONTROLS_NEEDED: readonly string[] = STANDARD_BUTTONS.filter(
  (control): control is string => control !== null,
);
