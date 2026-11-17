/**
 * What the Macros panel does apart from drawing: the key list as text, which macros differ
 * from the file, and a macro and its action being added or taken out.
 */

import { describe, expect, it } from "vitest";

import {
  addMacro,
  canonicalMacro,
  changedMacros,
  keyFromWord,
  macroProblem,
  patchedMacros,
  removeMacro,
  stepsFromText,
  textFromSteps,
  wordFromKey,
} from "../../../src/editor/macros-model.js";
import { parseMacros } from "../../../src/lib/macros.js";
import type { MacroDef } from "../../../src/lib/macros.js";
import { TRIGGER_KEYS } from "../../../src/lib/macros.js";
import type { ActionSpec } from "../../../src/types/profile.js";
import { parse } from "yaml";

describe("a key as typed", () => {
  it("takes a letter or a digit for its code, and anything else as written", () => {
    expect(keyFromWord("a")).toBe("KeyA");
    expect(keyFromWord("Z")).toBe("KeyZ");
    expect(keyFromWord("1")).toBe("Digit1");
    expect(keyFromWord("KeyA")).toBe("KeyA");
    expect(keyFromWord("Space")).toBe("Space");
    expect(keyFromWord("F5")).toBe("F5");
    expect(keyFromWord("10")).toBe("10");
  });

  it("says a code the short way, and not the others", () => {
    expect(wordFromKey("KeyA")).toBe("A");
    expect(wordFromKey("Digit1")).toBe("1");
    expect(wordFromKey("Space")).toBe("Space");
    expect(wordFromKey("Numpad1")).toBe("Numpad1");
  });
});

describe("the key list as text", () => {
  const steps = (text: string): MacroDef["steps"] => {
    const read = stepsFromText(text);
    if ("error" in read) throw new Error(read.error);
    return read.steps;
  };

  it("reads keys separated by spaces or commas, however many", () => {
    expect(steps("A B C")).toEqual([{ tap: "KeyA" }, { tap: "KeyB" }, { tap: "KeyC" }]);
    expect(steps("a,b ,  c\n1")).toEqual([
      { tap: "KeyA" },
      { tap: "KeyB" },
      { tap: "KeyC" },
      { tap: "Digit1" },
    ]);
    expect(steps("KeyA Space Digit2")).toEqual([
      { tap: "KeyA" },
      { tap: "Space" },
      { tap: "Digit2" },
    ]);
    expect(steps("")).toEqual([]);
  });

  it("reads a modifier held with a key, a hold, the other steps and a game action", () => {
    expect(steps("ControlLeft+r")).toEqual([{ tap: "ControlLeft+KeyR" }]);
    expect(steps("H:80")).toEqual([{ tap: "KeyH", hold: 80 }]);
    expect(steps("down:ShiftLeft A up:ShiftLeft wait:50 @reload")).toEqual([
      { down: "ShiftLeft" },
      { tap: "KeyA" },
      { up: "ShiftLeft" },
      { wait: 50 },
      { tap: { action: "reload" } },
    ]);
  });

  it("refuses what is not a key, and names it", () => {
    expect(stepsFromText("A +")).toEqual({ error: "Not a key: +" });
    expect(stepsFromText("A down:")).toEqual({ error: "Not a key: down:" });
    expect(stepsFromText("wait:soon")).toEqual({ error: "Wait is whole ms: wait:soon" });
    expect(stepsFromText("@")).toEqual({ error: "Not a key: @" });
    expect(stepsFromText("down:A:5")).toEqual({ error: "Not a key: down:A:5" });
  });

  it("reads back what it read, so editing never changes a macro it was not asked to", () => {
    for (const text of [
      "A B C",
      "1 Space",
      "ControlLeft+R H:80",
      "down:ShiftLeft A up:ShiftLeft",
      "wait:50 @reload",
    ]) {
      expect(textFromSteps(steps(text))).toBe(text);
    }
    expect(textFromSteps(steps("KeyA Digit1"))).toBe("A 1");
  });
});

describe("which macros differ from the file", () => {
  const loaded: Record<string, MacroDef> = {
    a: { steps: [{ tap: "KeyA" }] },
    b: { repeat: true, steps: [{ tap: "KeyB" }, { wait: 5 }] },
  };

  it("sees an added, an edited and a removed macro, and not a reordered field", () => {
    expect(changedMacros(loaded, structuredClone(loaded))).toEqual([]);
    const reordered: Record<string, MacroDef> = {
      a: loaded.a ?? { steps: [] },
      b: { steps: [{ tap: "KeyB" }, { wait: 5 }], repeat: true },
    };
    expect(changedMacros(loaded, reordered)).toEqual([]);
    expect(changedMacros(loaded, { ...loaded, c: { steps: [{ tap: "KeyC" }] } })).toEqual(["c"]);
    expect(changedMacros(loaded, { ...loaded, a: { steps: [{ tap: "KeyZ" }] } })).toEqual(["a"]);
    expect(changedMacros(loaded, { a: loaded.a ?? { steps: [] } })).toEqual(["b"]);
  });

  it("puts the same fields in the same order whatever order they came in", () => {
    const def = canonicalMacro({ gap: 5, repeat: true, steps: [{ hold: 3, tap: "KeyA" }] });
    expect(JSON.stringify(def)).toBe('{"repeat":true,"gap":5,"steps":[{"tap":"KeyA","hold":3}]}');
  });

  it("writes only the changed macros into the file, and the file still parses to them", () => {
    const text = "# mine\nmacros:\n  # keep me\n  a: [KeyA]\n";
    const working: Record<string, MacroDef> = {
      a: { steps: [{ tap: "KeyA" }] },
      c: { hold: 40, steps: [{ tap: "KeyC" }, { down: "ShiftLeft" }] },
    };
    const patched = patchedMacros(text, { a: working.a ?? { steps: [] } }, working);
    expect(patched).toContain("# mine");
    expect(patched).toContain("# keep me");
    expect(patched).toContain("a: [KeyA]");
    expect(parseMacros(parse(patched), "x").macros).toEqual(working);
  });
});

describe("a macro and its action", () => {
  const def: MacroDef = { steps: [{ tap: "KeyA" }] };

  it("adds the action with a trigger key from F13-F24, never one from the game's pool", () => {
    const actions: Record<string, ActionSpec> = { fire: { label: "Fire", key: "Insert" } };
    const macros: Record<string, MacroDef> = {};
    const key = addMacro(actions, macros, "abc", "ABC", def);
    expect(key).toBe("F13");
    expect(actions.abc).toEqual({ label: "ABC", key: "F13" });
    expect(macros).toEqual({ abc: def });
    expect(TRIGGER_KEYS).toContain(key);
  });

  it("gives each its own trigger, and says when none is left", () => {
    const actions: Record<string, ActionSpec> = {};
    const macros: Record<string, MacroDef> = {};
    const keys = TRIGGER_KEYS.map((_, index) =>
      addMacro(actions, macros, `m${String(index)}`, `M${String(index)}`, def),
    );
    expect(keys).toEqual([...TRIGGER_KEYS]);
    expect(addMacro(actions, macros, "extra", "Extra", def)).toBeNull();
  });

  it("takes the action out with the macro, or keeps it and says so", () => {
    const make = (): [Record<string, ActionSpec>, Record<string, MacroDef>] => {
      const actions: Record<string, ActionSpec> = {};
      const macros: Record<string, MacroDef> = {};
      addMacro(actions, macros, "abc", "ABC", def);
      return [actions, macros];
    };
    const [gone, goneMacros] = make();
    expect(removeMacro(gone, goneMacros, "abc", true)).toEqual({ actionKept: false });
    expect(gone).toEqual({});
    expect(goneMacros).toEqual({});
    const [kept, keptMacros] = make();
    expect(removeMacro(kept, keptMacros, "abc", false)).toEqual({ actionKept: true });
    expect(kept.abc).toBeDefined();
    expect(keptMacros).toEqual({});
  });

  it("says what stops a macro resolving, and nothing when it is sound", () => {
    const actions: Record<string, ActionSpec> = { reload: { label: "Reload", kbm: "KeyR" } };
    expect(macroProblem({ steps: [{ tap: "KeyA" }] }, actions)).toBeNull();
    expect(macroProblem({ steps: [{ tap: { action: "reload" } }] }, actions)).toBeNull();
    expect(macroProblem({ steps: [{ tap: { action: "nope" } }] }, actions)).toBe(
      "step 1: no action 'nope'",
    );
    expect(macroProblem({ steps: [] }, actions)).toBe("has no steps");
    expect(macroProblem({ steps: [{ tap: "Nonsense" }] }, actions)).toContain("step 1");
  });
});
