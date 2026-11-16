/**
 * Patching a game's macros.yaml one macro at a time: comments and the other macros survive,
 * a plain list stays a plain list, and the file is never left empty.
 */

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { MACROS_HEADER, patchMacro } from "../../../src/lib/macros-file.js";
import { parseMacros } from "../../../src/lib/macros.js";
import type { MacroDef } from "../../../src/lib/macros.js";

const read = (text: string): Record<string, MacroDef> =>
  parseMacros(parse(text), "macros.yaml").macros;

const ORIGINAL = `# What each button types.
macros:
  # the heal
  quick_heal:
    repeat: true # hold to keep healing
    gap: 20
    steps: [KeyH, {wait: 50}]

  abc: [KeyA, KeyB, KeyC]
`;

describe("patchMacro", () => {
  it("starts a missing file with a header and the macro as a plain list", () => {
    const text = patchMacro("", "abc", { steps: [{ tap: "KeyA" }, { tap: "KeyB" }] });
    expect(text.startsWith(MACROS_HEADER)).toBe(true);
    expect(text).toContain("abc: [KeyA, KeyB]");
    expect(read(text)).toEqual({ abc: { steps: [{ tap: "KeyA" }, { tap: "KeyB" }] } });
  });

  it("writes a macro with settings as a mapping, and the other steps in their own form", () => {
    const def: MacroDef = {
      repeat: true,
      hold: 40,
      gap: 10,
      steps: [
        { tap: "KeyA", hold: 80 },
        { down: "ShiftLeft" },
        { tap: { action: "reload" } },
        { up: "ShiftLeft" },
        { wait: 25 },
      ],
    };
    const text = patchMacro("", "m", def);
    expect(text).toContain("repeat: true");
    expect(text).toContain("hold: 40");
    expect(read(text)).toEqual({ m: def });
  });

  it("leaves every other line as it was", () => {
    const text = patchMacro(ORIGINAL, "fresh", { steps: [{ tap: "KeyZ" }] });
    expect(text.startsWith(ORIGINAL.trimEnd())).toBe(true);
    expect(text).toContain("fresh: [KeyZ]");
    expect(text).toContain("# hold to keep healing");
    expect(Object.keys(read(text))).toEqual(["quick_heal", "abc", "fresh"]);
  });

  it("changes one macro and keeps the comment above it", () => {
    const text = patchMacro(ORIGINAL, "abc", { steps: [{ tap: "KeyX" }] });
    expect(text).toContain("# the heal");
    expect(text).toContain("# hold to keep healing");
    expect(read(text).abc).toEqual({ steps: [{ tap: "KeyX" }] });
    expect(read(text).quick_heal?.repeat).toBe(true);
  });

  it("takes one out", () => {
    const text = patchMacro(ORIGINAL, "abc", null);
    expect(Object.keys(read(text))).toEqual(["quick_heal"]);
    expect(text).toContain("# What each button types.");
  });

  it("is never an empty file: the last macro out leaves `macros: {}`", () => {
    const one = patchMacro("", "abc", { steps: [{ tap: "KeyA" }] });
    const none = patchMacro(one, "abc", null);
    expect(none.trim().length).toBeGreaterThan(0);
    expect(none).toContain("macros: {}");
    expect(read(none)).toEqual({});
    // And one can be added to it again, as a block like the rest.
    const again = patchMacro(none, "x", { steps: [{ tap: "KeyX" }] });
    expect(again).not.toContain("{ x");
    expect(read(again)).toEqual({ x: { steps: [{ tap: "KeyX" }] } });
  });

  it("copes with a file that has no macros section yet", () => {
    const text = patchMacro("# nothing yet\nmacros:\n", "abc", { steps: [{ tap: "KeyA" }] });
    expect(read(text)).toEqual({ abc: { steps: [{ tap: "KeyA" }] } });
    expect(text).toContain("# nothing yet");
  });
});
