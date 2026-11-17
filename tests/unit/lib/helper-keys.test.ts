/**
 * The key table the helper types from and its hook reads with. Scan codes matter: a
 * DirectInput game ignores an event with only a virtual key.
 */

import { describe, expect, it } from "vitest";

import { ANALOG_KEYCODES } from "../../../src/lib/keys.js";
import {
  HELPER_KEYS,
  PAD_BITS,
  PAD_CONTROLS_NEEDED,
  helperKey,
  isReadable,
  isReadablePad,
  isTypeable,
} from "../../../src/lib/helper-keys.js";
import { TRIGGER_KEYS } from "../../../src/lib/macros.js";
import { isPadButton } from "../../../src/lib/macros.js";
import { PAD_CONTROLS } from "../../../src/lib/controls.js";

const scan = (code: string): string => {
  const key = helperKey(code);
  if (key === undefined) return "none";
  return `${key.extended ? "E0 " : ""}${key.scan.toString(16).padStart(2, "0")}`;
};

describe("scan codes", () => {
  it("has each key once, and each physical key once", () => {
    expect(new Set(HELPER_KEYS.map((key) => key.code)).size).toBe(HELPER_KEYS.length);
    const typed = HELPER_KEYS.filter((key) => key.typeable).map(
      (key) => `${String(key.extended)}${String(key.scan)}`,
    );
    expect(new Set(typed).size).toBe(typed.length);
  });

  it("has the usual keys", () => {
    expect(scan("Escape")).toBe("01");
    expect(scan("Digit1")).toBe("02");
    expect(scan("Digit0")).toBe("0b");
    expect(scan("KeyQ")).toBe("10");
    expect(scan("KeyA")).toBe("1e");
    expect(scan("KeyZ")).toBe("2c");
    expect(scan("Space")).toBe("39");
    expect(scan("Enter")).toBe("1c");
    expect(scan("ShiftLeft")).toBe("2a");
    expect(scan("ControlLeft")).toBe("1d");
    expect(scan("AltLeft")).toBe("38");
    expect(scan("F1")).toBe("3b");
    expect(scan("F10")).toBe("44");
    expect(scan("F11")).toBe("57");
    expect(scan("F12")).toBe("58");
  });

  it("gives the E0 keys their prefix, apart from the keys they share a scan code with", () => {
    for (const code of [
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Insert",
      "Delete",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "NumpadEnter",
      "NumpadDivide",
      "ControlRight",
      "AltRight",
      "MetaLeft",
      "MetaRight",
      "ContextMenu",
    ]) {
      expect(helperKey(code)?.extended, code).toBe(true);
    }
    expect(scan("NumpadEnter")).toBe("E0 1c");
    expect(scan("NumpadDivide")).toBe("E0 35");
    expect(scan("ControlRight")).toBe("E0 1d");
    expect(scan("AltRight")).toBe("E0 38");
    expect(scan("ArrowUp")).toBe("E0 48");
    // The numpad keys they are confused with have no prefix and the same scan code.
    expect(scan("Numpad8")).toBe("48");
    expect(scan("NumpadMultiply")).toBe("37");
    expect(helperKey("Numpad8")?.extended).toBe(false);
    expect(helperKey("Enter")?.extended).toBe(false);
  });

  it("has F13 to F24 at 0x64-0x6e and then 0x76", () => {
    const scans = Array.from({ length: 12 }, (_, index) => helperKey(`F${String(index + 13)}`));
    expect(scans.map((key) => key?.scan)).toEqual([
      0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x76,
    ]);
    expect(scans.map((key) => key?.vk)).toEqual(
      Array.from({ length: 12 }, (_, index) => 0x7c + index),
    );
    expect(scans.every((key) => key?.extended === false && key.typeable)).toBe(true);
  });

  it("has the whole numpad", () => {
    expect(
      ["Numpad7", "Numpad8", "Numpad9", "Numpad4", "Numpad5", "Numpad6", "Numpad1", "Numpad2"].map(
        scan,
      ),
    ).toEqual(["47", "48", "49", "4b", "4c", "4d", "4f", "50"]);
    expect(scan("Numpad3")).toBe("51");
    expect(scan("Numpad0")).toBe("52");
    expect(scan("NumpadDecimal")).toBe("53");
    expect(scan("NumpadAdd")).toBe("4e");
    expect(scan("NumpadSubtract")).toBe("4a");
  });

  it("knows every trigger key an Azeron can be given", () => {
    for (const code of TRIGGER_KEYS) {
      expect(isTypeable(code), code).toBe(true);
    }
  });

  it("knows every key a keypad can send, apart from the ones it cannot type", () => {
    const missing = Object.keys(ANALOG_KEYCODES).filter((code) => !isReadable(code));
    expect(missing).toEqual([]);
  });

  it("never types the keys with no single scan code, but can read them", () => {
    for (const code of ["Pause", "PrintScreen", "NumLock"]) {
      expect(isReadable(code), code).toBe(true);
      expect(isTypeable(code), code).toBe(false);
    }
    expect(isTypeable("NoSuchKey")).toBe(false);
    expect(isReadable("NoSuchKey")).toBe(false);
  });

  it("has virtual keys for the hook to fall back on", () => {
    expect(helperKey("KeyA")?.vk).toBe(0x41);
    expect(helperKey("Digit0")?.vk).toBe(0x30);
    expect(helperKey("ControlRight")?.vk).toBe(0xa3);
    expect(helperKey("Pause")?.vk).toBe(0x13);
    expect(helperKey("NumpadEnter")?.vk).toBe(helperKey("Enter")?.vk);
  });
});

describe("controller buttons", () => {
  it("has XInput's bits", () => {
    expect(PAD_BITS.A).toBe(0x1000);
    expect(PAD_BITS.B).toBe(0x2000);
    expect(PAD_BITS.X).toBe(0x4000);
    expect(PAD_BITS.Y).toBe(0x8000);
    expect(PAD_BITS.LB).toBe(0x100);
    expect(PAD_BITS.RB).toBe(0x200);
    expect(PAD_BITS.Menu).toBe(0x10);
    expect(PAD_BITS.View).toBe(0x20);
    expect(PAD_BITS.DpadUp).toBe(1);
    expect(PAD_BITS.LS).toBe(0x40);
    // The triggers are levels, given bits past the buttons'.
    expect(PAD_BITS.LT).toBeGreaterThan(0xffff);
    expect(PAD_BITS.RT).toBeGreaterThan(0xffff);
    expect(new Set(Object.values(PAD_BITS)).size).toBe(Object.keys(PAD_BITS).length);
  });

  it("covers every button the editor and the browser's pad name", () => {
    expect(PAD_CONTROLS_NEEDED.filter((control) => !isReadablePad(control))).toEqual([]);
    expect(
      PAD_CONTROLS.filter((control) => isPadButton(control) && !isReadablePad(control)),
    ).toEqual([]);
  });

  it("does not claim a stick direction", () => {
    expect(isReadablePad("LeftStickUp")).toBe(false);
  });
});
