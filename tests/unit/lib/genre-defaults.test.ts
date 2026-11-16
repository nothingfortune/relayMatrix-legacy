/**
 * A genre's defaults, drawn without starting a game: the pad table, each style's layout, the
 * text the CLI prints, and the checks on a genre's `xbox:` column. Inline vocabularies, so
 * nothing here reads a genre file.
 */

import { describe, expect, it } from "vitest";

import {
  SINGLE_UNIT,
  defaultsReport,
  genreDefaults,
  offPad,
  padRows,
  positionRows,
  styleDefaults,
} from "../../../src/lib/defaults.js";
import type { DefaultsInput } from "../../../src/lib/defaults.js";
import { lintGenrePad, lintGenreStyles } from "../../../src/lib/lint.js";
import { styleNames } from "../../../src/lib/styles.js";
import type { StyleSpec } from "../../../src/lib/styles.js";
import type { ActionSpec } from "../../../src/types/profile.js";

const ACTIONS: Record<string, ActionSpec> = {
  forward: { label: "Move forward", xbox: "LeftStickUp", tags: ["movement"] },
  back: { label: "Move back", xbox: "LeftStickDown", tags: ["movement"] },
  jump: { label: "Jump", xbox: "A", tags: ["movement", "required"] },
  map: { label: "Map", xbox: "View", tags: ["menu"] },
  look: { label: "Look", provided_by: "mouse", tags: ["movement"] },
  prone: { label: "Prone", tags: ["movement"] },
};

const STYLES: Record<string, StyleSpec> = {
  keyboard: { label: "Like a keyboard", left: "default" },
  controller: {
    label: "Like a controller",
    note: "A pad.",
    right: { pinky_1: { label: "Prone", tap: "prone" } },
  },
};

const INPUT: DefaultsInput = {
  genre: "Test",
  actions: ACTIONS,
  defaults: { index_1: { label: "Jump", tap: "jump" } },
  styles: STYLES,
};

describe("the pad of a vocabulary", () => {
  it("lists every control of the pad, in order, with the action on it or none", () => {
    const rows = padRows(ACTIONS);
    expect(rows.find((row) => row.control === "A")).toEqual({
      control: "A",
      action: "jump",
      label: "Jump",
    });
    expect(rows.find((row) => row.control === "B")).toEqual({
      control: "B",
      action: null,
      label: null,
    });
    expect(rows).toHaveLength(24);
  });

  it("lists what is on no control, but not what only the mouse supplies", () => {
    expect(offPad(ACTIONS)).toEqual([{ id: "prone", label: "Prone" }]);
  });
});

describe("a genre's layouts", () => {
  it("offers its styles, the one that says it is the default first, then the one unit", () => {
    const styles: Record<string, StyleSpec> = {
      controller: { label: "Like a controller" },
      keyboard: { label: "Like a keyboard", default: true },
    };
    expect(styleNames(styles)).toEqual(["keyboard", "controller"]);
    expect(styleNames(STYLES)).toEqual(["controller", "keyboard"]);
    expect(genreDefaults({ ...INPUT, styles }).styles.map((style) => style.name)).toEqual([
      "keyboard",
      "controller",
      SINGLE_UNIT,
    ]);
  });

  it("builds the controller layout from the pad's controls plus the style's own keys", () => {
    const controller = styleDefaults(INPUT, "controller");
    expect(controller.error).toBeNull();
    expect(controller.right.dpad_down).toEqual({ label: "Jump", tap: "jump" });
    expect(controller.left.stick?.directions).toEqual({ up: "forward", down: "back" });
    expect(controller.right.pinky_1).toEqual({ label: "Prone", tap: "prone" });
    expect(controller.left.thumb_aux_upper).toEqual({ label: "Map", tap: "map" });
  });

  it("builds the one-unit layout on the left and nothing on the right", () => {
    const single = styleDefaults(INPUT, SINGLE_UNIT);
    expect(single.left.index_1).toEqual({ label: "Jump", tap: "jump" });
    expect(single.right).toEqual({});
  });

  it("says why a style cannot be built, as data, and the others still can", () => {
    const clash = { ...ACTIONS, also_jump: { label: "Also", xbox: "A" } };
    const defaults = genreDefaults({ ...INPUT, actions: clash });
    const controller = defaults.styles.find((style) => style.name === "controller");
    expect(controller?.error).toMatch(/also_jump and jump are both on A/);
    expect(controller?.left).toEqual({});
    expect(defaults.styles.find((style) => style.name === "keyboard")?.error).toBeNull();
  });

  it("says a style that is not there", () => {
    expect(styleDefaults(INPUT, "nope").error).toMatch(/no style 'nope'/);
  });
});

describe("reading a layout as rows", () => {
  it("names each control and what is on it, the thumb first, sticks by direction", () => {
    const rows = positionRows(ACTIONS, {
      pinky_1: { tap: "prone" },
      index_1: { label: "Hop", tap: "jump", long: "map" },
      stick: { mode: "keyboard", directions: { down: "back", up: "forward" } },
      stick_press: { tap: "jump" },
    });
    expect(rows).toEqual([
      { where: "Stick up", what: "Move forward" },
      { where: "Stick down", what: "Move back" },
      { where: "Stick press", what: "Jump" },
      { where: "Pinky 1", what: "Prone" },
      { where: "Index 1", what: "Jump" },
      { where: "Index 1 long", what: "Map" },
    ]);
  });

  it("says a stick that is not on keys", () => {
    expect(positionRows(ACTIONS, { stick: { mode: "mouse" } })).toEqual([
      { where: "Stick", what: "mouse mode" },
    ]);
  });
});

describe("what azeron defaults prints", () => {
  it("lists the genres and their layouts with no argument", () => {
    const text = defaultsReport([INPUT]);
    expect(text).toMatch(/Test +controller, keyboard, default/);
  });

  it("prints the pad, the first layout and the others on offer", () => {
    const text = defaultsReport([INPUT], "test");
    expect(text).toMatch(/^Test: the Xbox pad/);
    expect(text).toMatch(/A +Jump/);
    expect(text).toMatch(/On no control: Prone/);
    expect(text).toMatch(/Like a controller \(controller\)/);
    expect(text).toMatch(/Left unit/);
    expect(text).toMatch(/Other layouts: keyboard, default/);
  });

  it("prints the layout asked for", () => {
    expect(defaultsReport([INPUT], "Test", "default")).toMatch(/One unit \(default\)/);
  });

  it("refuses a genre or layout that is not there, saying what is", () => {
    expect(() => defaultsReport([INPUT], "Nope")).toThrow(/have: Test/);
    expect(() => defaultsReport([INPUT], "Test", "nope")).toThrow(
      /has no 'nope' layout \(have: controller, keyboard, default\)/,
    );
  });
});

describe("the checks on a genre's pad", () => {
  it("finds nothing wrong with a sound one", () => {
    expect(lintGenrePad(ACTIONS)).toEqual([]);
    expect(lintGenreStyles(INPUT)).toEqual([]);
  });

  it("errors on a control that is not on a pad", () => {
    const findings = lintGenrePad({ x: { xbox: "Z" }, y: { xbox: "A" } });
    expect(findings.map((finding) => [finding.rule, finding.level])).toEqual([
      ["xbox-unknown", "error"],
    ]);
  });

  it("errors on two actions on one control", () => {
    const findings = lintGenrePad({ x: { xbox: "A" }, y: { xbox: "A" } });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "xbox-collision", level: "error", key: "A" });
    expect(findings[0]?.message).toMatch(/x and y/);
  });

  it("warns on a menu on a button play presses, and not on View or Menu", () => {
    const findings = lintGenrePad({
      inventory: { xbox: "X", tags: ["menu"] },
      map: { xbox: "View", tags: ["menu"] },
      main: { xbox: "Menu", tags: ["menu"] },
    });
    expect(findings.map((finding) => [finding.rule, finding.level, finding.key])).toEqual([
      ["xbox-menu-on-play", "warning", "X"],
    ]);
  });

  it("errors on a style that cannot be built", () => {
    const findings = lintGenreStyles({
      ...INPUT,
      styles: { controller: { label: "C", stick_mode: "missing" } },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "style-unbuildable", level: "error" });
  });
});
