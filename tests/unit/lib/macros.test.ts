/**
 * Macros: press one button, the game gets a list of keys. Reading macros.yaml, resolving it
 * into operations, the three kinds of button that start one, compiling a game's macros, and
 * the trigger keys handed out for a keypad.
 */

import { describe, expect, it } from "vitest";

import {
  compileMacros,
  dumpMacros,
  MACRO_LIMITS,
  MacroError,
  macrosTyping,
  parseMacros,
  resolveMacro,
  triggersOf,
} from "../../../src/lib/macros.js";
import type { MacroDef, MacroOp } from "../../../src/lib/macros.js";
import { freeTrigger, wireTrigger } from "../../../src/lib/wiring.js";
import type { ActionSpec } from "../../../src/types/profile.js";

const ACTIONS: Record<string, ActionSpec> = {
  reload: { label: "Reload", key: "Insert", kbm: "KeyR" },
  crouch: { label: "Crouch", key: "Home", kbm: "ControlLeft+KeyC" },
  fire: { label: "Fire", kbm: "MouseLeft" },
  scroll: { label: "Scroll", kbm: "WheelUp" },
  nothing: { label: "No key in the game" },
  quick: { label: "Quick", key: "F13" },
  burst: { label: "Burst", key: "F14" },
};

const def = (steps: MacroDef["steps"], extra: Partial<MacroDef> = {}): MacroDef => ({
  steps,
  ...extra,
});

const down = (code: string): MacroOp => ({ op: "down", input: { key: code } });
const up = (code: string): MacroOp => ({ op: "up", input: { key: code } });
const wait = (ms: number): MacroOp => ({ op: "wait", ms });

describe("parseMacros", () => {
  it("reads a macro written as the list of keys the game should get", () => {
    const parsed = parseMacros({ macros: { abc: ["KeyA", "KeyB", "KeyC"] } }, "macros.yaml");
    expect(parsed.macros.abc).toEqual({
      steps: [{ tap: "KeyA" }, { tap: "KeyB" }, { tap: "KeyC" }],
    });
  });

  it("reads a bare {action: id} as a tap of that action's key", () => {
    const parsed = parseMacros({ macros: { x: [{ action: "reload" }] } }, "macros.yaml");
    expect(parsed.macros.x?.steps).toEqual([{ tap: { action: "reload" } }]);
  });

  it("reads taps, downs, ups and waits, and the macro's own settings", () => {
    const parsed = parseMacros(
      {
        macros: {
          quick: {
            repeat: true,
            hold: 50,
            gap: 10,
            steps: [
              "KeyH",
              { wait: 50 },
              { tap: "KeyJ", hold: 40 },
              { down: "ShiftLeft" },
              { up: { action: "reload" } },
            ],
          },
        },
      },
      "macros.yaml",
    );
    expect(parsed.macros.quick).toEqual({
      repeat: true,
      hold: 50,
      gap: 10,
      steps: [
        { tap: "KeyH" },
        { wait: 50 },
        { tap: "KeyJ", hold: 40 },
        { down: "ShiftLeft" },
        { up: { action: "reload" } },
      ],
    });
  });

  it("is empty for an empty file", () => {
    expect(parseMacros(null, "macros.yaml")).toEqual({ macros: {} });
    expect(parseMacros({}, "macros.yaml")).toEqual({ macros: {} });
  });

  it.each([
    ["a file that is not a mapping", ["x"], /must be a mapping/],
    ["a macro that is a number", { macros: { a: 1 } }, /list of keys or a mapping/],
    ["steps that are not a list", { macros: { a: { steps: {} } } }, /must be a list of keys/],
    ["an unknown setting", { macros: { a: { steps: [], loop: 1 } } }, /'loop' is not a setting/],
    [
      "a step with two things to do",
      { macros: { a: { steps: [{ tap: "KeyA", wait: 5 }] } } },
      /exactly one of tap, down, up, wait/,
    ],
    [
      "a hold on something that is not a tap",
      { macros: { a: { steps: [{ down: "KeyA", hold: 5 }] } } },
      /'hold' is not allowed here/,
    ],
    ["a negative wait", { macros: { a: { steps: [{ wait: -1 }] } } }, /wait is whole milliseconds/],
    [
      "a fractional hold",
      { macros: { a: { steps: [{ tap: "KeyA", hold: 1.5 }] } } },
      /hold is whole milliseconds/,
    ],
    ["a gap that is not a number", { macros: { a: { gap: "x", steps: [] } } }, /gap is whole/],
    ["a step that is a number", { macros: { a: [5] } }, /a key, or a mapping/],
    ["a target that is neither", { macros: { a: { steps: [{ tap: 5 }] } } }, /a key like KeyH/],
  ])("refuses %s", (_name, data, message) => {
    expect(() => parseMacros(data, "macros.yaml")).toThrow(MacroError);
    expect(() => parseMacros(data, "macros.yaml")).toThrow(message);
  });
});

describe("resolveMacro", () => {
  it("types A then B then C, a pause between and none after the last", () => {
    const parsed = parseMacros({ macros: { abc: ["KeyA", "KeyB", "KeyC"] } }, "m.yaml");
    const { ops, problems } = resolveMacro(parsed.macros.abc ?? def([]), ACTIONS);
    expect(problems).toEqual([]);
    expect(ops).toEqual([
      down("KeyA"),
      wait(30),
      up("KeyA"),
      wait(30),
      down("KeyB"),
      wait(30),
      up("KeyB"),
      wait(30),
      down("KeyC"),
      wait(30),
      up("KeyC"),
    ]);
  });

  it("uses the macro's own hold and gap, and a tap's own hold over both", () => {
    const { ops } = resolveMacro(
      def([{ tap: "KeyA" }, { tap: "KeyB", hold: 80 }, { tap: "KeyC" }], { hold: 10, gap: 5 }),
      ACTIONS,
    );
    expect(ops.filter((op) => op.op === "wait")).toEqual([
      wait(10),
      wait(5),
      wait(80),
      wait(5),
      wait(10),
    ]);
  });

  it("leaves no pause where a step says what it wants: a wait, a down or an up", () => {
    const { ops } = resolveMacro(
      def([{ tap: "KeyA" }, { wait: 7 }, { tap: "KeyB" }, { down: "ShiftLeft" }]),
      ACTIONS,
    );
    expect(ops).toEqual([
      down("KeyA"),
      wait(30),
      up("KeyA"),
      wait(7),
      down("KeyB"),
      wait(30),
      up("KeyB"),
      down("ShiftLeft"),
    ]);
  });

  it("types an action as the key the game has it on, not the key the keypad sends", () => {
    const { ops } = resolveMacro(def([{ tap: { action: "reload" } }]), ACTIONS);
    expect(ops[0]).toEqual(down("KeyR"));
  });

  it("holds a chord's modifiers around its key and lifts them in reverse", () => {
    const { ops } = resolveMacro(def([{ tap: { action: "crouch" } }]), ACTIONS);
    expect(ops).toEqual([
      down("ControlLeft"),
      down("KeyC"),
      wait(30),
      up("KeyC"),
      up("ControlLeft"),
    ]);
  });

  it("leaves a key an explicit down is holding alone when a tap shares it", () => {
    // down Shift, tap Shift+A, tap B, up Shift: the tap must not lift the Shift, or B is bare.
    const { ops, problems } = resolveMacro(
      def([{ down: "ShiftLeft" }, { tap: "ShiftLeft+KeyA" }, { tap: "KeyB" }, { up: "ShiftLeft" }]),
      ACTIONS,
    );
    expect(problems).toEqual([]);
    expect(ops).toEqual([
      down("ShiftLeft"),
      down("KeyA"),
      wait(30),
      up("KeyA"),
      wait(30),
      down("KeyB"),
      wait(30),
      up("KeyB"),
      up("ShiftLeft"),
    ]);
  });

  it("does the same when the chord comes from an action", () => {
    const { ops } = resolveMacro(
      def([{ down: "ControlLeft" }, { tap: { action: "crouch" } }, { up: "ControlLeft" }]),
      ACTIONS,
    );
    expect(ops).toEqual([
      down("ControlLeft"),
      down("KeyC"),
      wait(30),
      up("KeyC"),
      up("ControlLeft"),
    ]);
  });

  it("presses a held key's modifiers again once it has been let go", () => {
    const { ops } = resolveMacro(
      def([{ down: "ShiftLeft" }, { up: "ShiftLeft" }, { tap: "ShiftLeft+KeyA" }]),
      ACTIONS,
    );
    expect(ops).toEqual([
      down("ShiftLeft"),
      up("ShiftLeft"),
      down("ShiftLeft"),
      down("KeyA"),
      wait(30),
      up("KeyA"),
      up("ShiftLeft"),
    ]);
  });

  it("presses the mouse buttons", () => {
    expect(resolveMacro(def([{ down: { action: "fire" } }]), ACTIONS).ops).toEqual([
      { op: "down", input: { mouse: "left" } },
    ]);
  });

  it.each([
    ["an action that is not there", { tap: { action: "nope" } }, "step 1: no action 'nope'"],
    [
      "an action the game has no key for",
      { tap: { action: "nothing" } },
      "step 1: 'nothing' has no keyboard key (kbm) in this game",
    ],
    [
      "something that is not a key",
      { tap: "KeyRR" },
      "step 1: 'KeyRR' is not a key or mouse button",
    ],
    [
      "the wheel",
      { tap: { action: "scroll" } },
      "step 1: 'scroll': the wheel and the side buttons cannot be typed",
    ],
    [
      "a side button",
      { tap: "Mouse4" },
      "step 1: 'Mouse4': the wheel and the side buttons cannot be typed",
    ],
    [
      "a wait past the limit",
      { wait: MACRO_LIMITS.waitMs + 1 },
      `step 1: wait is over ${String(MACRO_LIMITS.waitMs)} ms`,
    ],
    [
      "a hold past the limit",
      { tap: "KeyA", hold: MACRO_LIMITS.holdMs + 1 },
      `step 1: hold is over ${String(MACRO_LIMITS.holdMs)} ms`,
    ],
  ])("reports %s", (_name, step, message) => {
    expect(resolveMacro(def([step]), ACTIONS).problems).toEqual([message]);
  });

  it("reports a macro with no steps, one with too many, and a default hold or gap past the limit", () => {
    expect(resolveMacro(def([]), ACTIONS).problems).toEqual(["has no steps"]);
    const many = Array.from({ length: MACRO_LIMITS.steps + 1 }, () => ({ wait: 1 }));
    expect(resolveMacro(def(many), ACTIONS).problems[0]).toMatch(/has 65 steps; the most is 64/);
    expect(resolveMacro(def([{ tap: "KeyA" }], { hold: 99_999 }), ACTIONS).problems).toEqual([
      "hold is over 5000 ms",
    ]);
    expect(resolveMacro(def([{ tap: "KeyA" }], { gap: 99_999 }), ACTIONS).problems).toEqual([
      "gap is over 10000 ms",
    ]);
  });

  it("reports a macro that expands past the operation limit", () => {
    // A tap of a three-modifier chord is nine operations; 64 of them is 576.
    const heavy = Array.from({ length: MACRO_LIMITS.steps }, () => ({
      tap: "ControlLeft+ShiftLeft+AltLeft+KeyA",
    }));
    expect(resolveMacro(def(heavy, { gap: 0 }), ACTIONS).problems).toEqual([
      `is 576 operations long; the most is ${String(MACRO_LIMITS.ops)}`,
    ]);
    // 64 plain keys with the default pause is 64 * 3 + 63 operations.
    const plain = Array.from({ length: MACRO_LIMITS.steps }, () => ({ tap: "KeyA" }));
    expect(resolveMacro(def(plain), ACTIONS).problems).toEqual([]);
  });

  it("will not repeat a macro that waits too little to ever yield", () => {
    const quiet = def([{ down: "KeyA" }, { up: "KeyA" }], { repeat: true });
    expect(resolveMacro(quiet, ACTIONS).problems).toEqual([
      "repeats, so it must wait at least 10 ms in all",
    ]);
    expect(resolveMacro(def([{ tap: "KeyA" }], { repeat: true }), ACTIONS).problems).toEqual([]);
  });

  it("puts the gap between one pass and the next when a repeating macro ends and starts on a tap", () => {
    const waits = (ops: { op: string; ms?: number }[]): (number | undefined)[] =>
      ops.filter((op) => op.op === "wait").map((op) => op.ms);
    const once = resolveMacro(def([{ tap: "KeyA" }], { gap: 200 }), ACTIONS);
    const looped = resolveMacro(def([{ tap: "KeyA" }], { gap: 200, repeat: true }), ACTIONS);
    expect(waits(once.ops)).toEqual([30]);
    expect(waits(looped.ops)).toEqual([30, 200]);
    // Ending on a hold or a wait, a pass needs no extra pause.
    const wait = resolveMacro(
      def([{ tap: "KeyA" }, { wait: 50 }], { gap: 200, repeat: true }),
      ACTIONS,
    );
    expect(waits(wait.ops)).toEqual([30, 50]);
  });
});

describe("triggersOf: the buttons that start a macro", () => {
  it("takes a keypad key, a keyboard key and a controller button, any or all", () => {
    expect(triggersOf({ key: "F13" }).triggers).toEqual([{ device: "azeron", input: "F13" }]);
    expect(triggersOf({ kbm: "KeyM" }).triggers).toEqual([{ device: "keyboard", input: "KeyM" }]);
    expect(triggersOf({ pad: "RB" }).triggers).toEqual([{ device: "pad", input: "RB" }]);
    expect(triggersOf({ key: "F13", kbm: "KeyM", pad: "RB" })).toEqual({
      triggers: [
        { device: "azeron", input: "F13" },
        { device: "keyboard", input: "KeyM" },
        { device: "pad", input: "RB" },
      ],
      problems: [],
    });
  });

  it.each([
    [undefined, "is not an action of this game"],
    [{ label: "x" }, "has no button: give it a keypad key, a keyboard key or a controller button"],
    [{ key: "F13", meta: "ShiftLeft" }, "keypad key is sent with a modifier"],
    [{ key: "KeyA" }, "keypad key KeyA is not an F13-F24 key"],
    [{ key: "F9" }, "keypad key F9 is not an F13-F24 key"],
    [{ kbm: "ControlLeft+KeyM" }, "keyboard key ControlLeft+KeyM must be one plain key"],
    [{ kbm: "ShiftLeft" }, "keyboard key ShiftLeft must be one plain key"],
    [{ kbm: "MouseLeft" }, "keyboard key MouseLeft must be one plain key"],
    [{ kbm: "WheelUp" }, "keyboard key WheelUp must be one plain key"],
    [{ kbm: "KeyRR" }, "keyboard key KeyRR must be one plain key"],
    [{ pad: "LeftStickUp" }, "controller control LeftStickUp is not a button"],
    [{ pad: "Nope" }, "controller control Nope is not a button"],
  ])("%j: %s", (spec, problem) => {
    const found = triggersOf(spec);
    expect(found.problems).toEqual([problem]);
    expect(found.triggers).toEqual([]);
  });

  it("says so when one of several buttons is wrong, and keeps the others", () => {
    const found = triggersOf({ key: "F13", pad: "LeftStickUp" });
    expect(found.triggers).toEqual([{ device: "azeron", input: "F13" }]);
    expect(found.problems).toEqual(["controller control LeftStickUp is not a button"]);
  });
});

describe("compileMacros", () => {
  const actions: Record<string, ActionSpec> = {
    ...ACTIONS,
    abc: { label: "ABC", key: "F15", kbm: "KeyM", pad: "RB" },
  };
  const data = parseMacros(
    {
      macros: {
        quick: { repeat: true, steps: [{ action: "reload" }] },
        abc: ["KeyA", "KeyB", "KeyC"],
        burst: ["KeyB"],
      },
    },
    "macros.yaml",
  );

  it("lists each macro with every button that starts it, by action id", () => {
    const { program, problems } = compileMacros(data, actions);
    expect(problems).toEqual([]);
    expect(program.version).toBe(2);
    expect(program.macros.map((macro) => macro.action)).toEqual(["abc", "burst", "quick"]);
    expect(program.macros[0]).toMatchObject({
      action: "abc",
      label: "ABC",
      repeat: false,
      on: [
        { device: "azeron", input: "F15" },
        { device: "keyboard", input: "KeyM" },
        { device: "pad", input: "RB" },
      ],
    });
    expect(program.macros[2]).toMatchObject({ action: "quick", repeat: true });
  });

  it("writes the same file however the macros are ordered", () => {
    const reversed = parseMacros(
      { macros: { burst: data.macros.burst, abc: data.macros.abc, quick: data.macros.quick } },
      "macros.yaml",
    );
    const text = dumpMacros(compileMacros(data, actions).program);
    expect(dumpMacros(compileMacros(reversed, actions).program)).toBe(text);
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("leaves a macro with a problem out, and says which rule it breaks", () => {
    const broken = parseMacros(
      {
        macros: {
          reload: ["KeyB"], // its keypad key is Insert: not a trigger
          quick: [{ action: "nope" }],
          ghost: ["KeyB"], // not an action at all
        },
      },
      "macros.yaml",
    );
    const { program, problems } = compileMacros(broken, actions);
    expect(program.macros).toEqual([]);
    expect(problems).toEqual([
      {
        macro: "reload",
        rule: "macro-trigger",
        message: "keypad key Insert is not an F13-F24 key",
      },
      { macro: "quick", rule: "macro-invalid", message: "step 1: no action 'nope'" },
      { macro: "ghost", rule: "macro-trigger", message: "is not an action of this game" },
    ]);
  });

  it("refuses a keypad trigger and a keyboard key that are the same physical key", () => {
    // The helper's hook cannot tell a keypad's F13 from a keyboard's F13.
    const clash = { ...actions, twin: { label: "Twin", kbm: "F13" } };
    const both = parseMacros({ macros: { quick: ["KeyB"], twin: ["KeyB"] } }, "macros.yaml");
    const { program, problems } = compileMacros(both, clash);
    expect(program.macros.map((macro) => macro.action)).toEqual(["quick"]);
    expect(problems).toEqual([
      { macro: "twin", rule: "macro-trigger", message: "F13 also starts 'quick'" },
    ]);
  });

  it("refuses a trigger key that another action holds with a modifier, which the helper would swallow", () => {
    const chord = { ...actions, copy: { label: "Copy", kbm: "ControlLeft+F13" } };
    const only = parseMacros({ macros: { quick: ["KeyB"] } }, "macros.yaml");
    const { program, problems } = compileMacros(only, chord);
    expect(program.macros).toEqual([]);
    expect(problems).toEqual([
      {
        macro: "quick",
        rule: "macro-trigger",
        message: "F13 is swallowed from 'copy', which is on ControlLeft+F13",
      },
    ]);
    // On another key it is no concern.
    const apart = { ...actions, copy: { label: "Copy", kbm: "ControlLeft+KeyC" } };
    expect(compileMacros(only, apart).problems).toEqual([]);
  });

  it("lets a pad button share a name with a key, since they are different buttons", () => {
    const ok = {
      one: { label: "One", pad: "A" },
      two: { label: "Two", kbm: "KeyA" },
    };
    const both = parseMacros({ macros: { one: ["KeyB"], two: ["KeyB"] } }, "macros.yaml");
    expect(compileMacros(both, { ...ACTIONS, ...ok }).problems).toEqual([]);
  });

  it("refuses two macros started by the same button", () => {
    const twin = { ...actions, twin: { label: "Twin", key: "F13" } };
    const twice = parseMacros({ macros: { quick: ["KeyB"], twin: ["KeyB"] } }, "macros.yaml");
    const { program, problems } = compileMacros(twice, twin);
    expect(program.macros.map((macro) => macro.action)).toEqual(["quick"]);
    expect(problems).toEqual([
      { macro: "twin", rule: "macro-trigger", message: "F13 also starts 'quick'" },
    ]);
  });
});

describe("trigger keys for a keypad", () => {
  it("hands out F13 first, then the next that no live action is on", () => {
    expect(freeTrigger({})).toBe("F13");
    expect(freeTrigger({ a: { key: "F13" }, b: { key: "F14" } })).toBe("F15");
  });

  it("counts a keyboard key an action is on as taken, since the helper hears both alike", () => {
    expect(freeTrigger({ a: { kbm: "F13" } })).toBe("F14");
    expect(freeTrigger({ a: { kbm: "F13" }, b: { key: "F14" } })).toBe("F15");
    // The helper hears F13 whatever is held with it, so a chord on F13 holds F13 too.
    expect(freeTrigger({ a: { kbm: "ControlLeft+F13" } })).toBe("F14");
    expect(freeTrigger({ a: { kbm: "ControlLeft+KeyR" } })).toBe("F13");
  });

  it("counts only actions live together, and a modifier-held key as taken", () => {
    const live = { a: { key: "F13", mode: "ship" }, b: { key: "F14", meta: "F15" } };
    expect(freeTrigger(live, (other) => other.mode !== "ship")).toBe("F13");
    expect(freeTrigger(live)).toBe("F16");
  });

  it("is null when all twelve are spent", () => {
    const all: Record<string, ActionSpec> = {};
    for (let n = 13; n <= 24; n++) all[`m${String(n)}`] = { key: `F${String(n)}` };
    expect(freeTrigger(all)).toBeNull();
  });

  it("gives a macro's action a trigger once, and never moves one it has", () => {
    const given: Record<string, ActionSpec> = { quick: { label: "Quick" } };
    expect(wireTrigger(given, "quick")).toBe("F13");
    expect(given.quick?.key).toBe("F13");
    expect(wireTrigger(given, "quick")).toBeNull();
    expect(given.quick?.key).toBe("F13");
    expect(wireTrigger(given, "missing")).toBeNull();
  });
});

describe("macrosTyping", () => {
  const data = parseMacros(
    {
      macros: {
        a: [{ action: "reload" }, "KeyB"],
        b: [{ down: { action: "crouch" } }, "KeyB", { up: { action: "crouch" } }],
        c: ["KeyA", "KeyB"],
        d: [{ tap: { action: "reload" } }],
      },
    },
    "macros.yaml",
  );

  it("names every macro that types an action, by tap, down or up", () => {
    expect(macrosTyping(data, "reload")).toEqual(["a", "d"]);
    expect(macrosTyping(data, "crouch")).toEqual(["b"]);
  });

  it("names none for an action no macro types, and ignores a raw key of the same name", () => {
    expect(macrosTyping(data, "fire")).toEqual([]);
    expect(macrosTyping(data, "KeyB")).toEqual([]);
    expect(macrosTyping({ macros: {} }, "reload")).toEqual([]);
  });
});
