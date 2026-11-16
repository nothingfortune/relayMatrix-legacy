/**
 * A game's macros.yaml reaching the editor and coming back: the payload carries its text, the
 * save path accepts it and refuses what does not parse, and a save builds dist/ and lints.
 * The data root is a scratch copy of the fixture: nothing real is read or written.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/paths.js")>();
  const root = mkdtempSync(join(tmpdir(), "azeron-macros-save-"));
  for (const dir of ["devices", "genres", "games", "templates", "dist"]) {
    cpSync(join(actual.dataRoot, dir), join(root, dir), { recursive: true });
  }
  return {
    ...actual,
    repoRoot: root,
    dataRoot: root,
    repoPath: (...parts: readonly string[]) => {
      const joined = join(...parts);
      return isAbsolute(joined) ? joined : join(root, joined);
    },
  };
});

import { dataRoot } from "../../../src/config/paths.js";
import { buildPayload } from "../../../src/lib/editor/payload.js";
import { Game } from "../../../src/lib/model.js";
import { SaveRejected, resolveSavePath, validateSaveContent } from "../../../src/lib/serve.js";
import { checkAfterSave } from "../../../src/lib/tasks.js";

const GAME = "games/SpaceSims/everspace";
const MACROS_PATH = `${GAME}/macros.yaml`;
const MACROS = join(dataRoot, MACROS_PATH);
const ACTIONS = join(dataRoot, GAME, "actions.yaml");
const OUT = join(dataRoot, "dist/SpaceSims/everspace/macros.json");
const ORIGINAL_ACTIONS = readFileSync(ACTIONS, "utf8");

const withActions = (): void => {
  const added = "actions:\n  quick_heal: {label: Quick heal, key: F13}\n";
  writeFileSync(ACTIONS, ORIGINAL_ACTIONS.replace(/^actions:\n/m, added), "utf8");
};

beforeEach(() => {
  rmSync(MACROS, { force: true });
  rmSync(OUT, { force: true });
  writeFileSync(ACTIONS, ORIGINAL_ACTIONS, "utf8");
});

afterEach(() => {
  rmSync(MACROS, { force: true });
  rmSync(OUT, { force: true });
  writeFileSync(ACTIONS, ORIGINAL_ACTIONS, "utf8");
});

describe("the payload's macros", () => {
  it("is empty for a game with no macros.yaml", () => {
    const game = buildPayload().games.find((entry) => entry.slug === "everspace");
    expect(game?.macros).toEqual({ macros: {} });
    expect(game?.macrosText).toBe("");
  });

  it("carries the file as written, comments included, and what it says", () => {
    const text = "# my macros\nmacros:\n  quick_heal: [KeyH, KeyJ]\n";
    writeFileSync(MACROS, text, "utf8");
    const game = buildPayload().games.find((entry) => entry.slug === "everspace");
    expect(game?.macrosText).toBe(text);
    expect(game?.macros.macros).toEqual({
      quick_heal: { steps: [{ tap: "KeyH" }, { tap: "KeyJ" }] },
    });
  });
});

describe("saving macros.yaml", () => {
  it("is allowed for a game's own file and nothing beside it", () => {
    expect(resolveSavePath(dataRoot, MACROS_PATH)).toBe(MACROS);
    expect(() => resolveSavePath(dataRoot, "games/SpaceSims/macros.yaml")).toThrow(SaveRejected);
    expect(() => resolveSavePath(dataRoot, `${GAME}/../../../macros.yaml`)).toThrow(SaveRejected);
    expect(() => resolveSavePath(dataRoot, `${GAME}/macros.json`)).toThrow(SaveRejected);
  });

  it("is refused, before anything is written, when it is not macros", () => {
    expect(() => {
      validateSaveContent(MACROS_PATH, "macros:\n  abc: KeyA\n");
    }).toThrow(/macros\.abc must be a list of keys or a mapping/);
    expect(() => {
      validateSaveContent(MACROS_PATH, "macros:\n  abc: {steps: [KeyA], speed: 3}\n");
    }).toThrow(SaveRejected);
    expect(() => {
      validateSaveContent(MACROS_PATH, "macros: [unclosed\n");
    }).toThrow(/not valid YAML/);
    expect(() => {
      validateSaveContent(MACROS_PATH, "macros:\n  abc: [KeyA]\n");
    }).not.toThrow();
    expect(() => {
      validateSaveContent(MACROS_PATH, "macros: {}\n");
    }).not.toThrow();
  });
});

describe("what a save of macros.yaml comes to", () => {
  it("rebuilds dist's macros.json from the saved file, and lints it", () => {
    withActions();
    writeFileSync(MACROS, "macros:\n  quick_heal: [KeyH, KeyJ]\n", "utf8");
    const check = checkAfterSave(MACROS_PATH, Game.discover());
    expect(check.game).toBe("everspace");
    expect(check.buildErrors).toEqual([]);
    expect(check.built.some((entry) => entry.output.endsWith("macros.json"))).toBe(true);
    expect(existsSync(OUT)).toBe(true);
    expect(check.findings.filter((finding) => finding.rule.startsWith("macro"))).toEqual([]);
  });

  it("reports a macro that does not resolve, as an error with no profile to accept it on", () => {
    withActions();
    writeFileSync(MACROS, "macros:\n  quick_heal: [KeyH, Nonsense]\n", "utf8");
    const check = checkAfterSave(MACROS_PATH, Game.discover());
    const found = check.findings.filter((finding) => finding.rule === "macro-invalid");
    expect(found).toHaveLength(1);
    expect(found[0]?.key).toBe("quick_heal");
    expect(found[0]?.profile).toBeUndefined();
    expect(check.buildErrors.join("\n")).toContain("quick_heal");
  });

  it("removes the program when the last macro is saved out", () => {
    withActions();
    writeFileSync(MACROS, "macros:\n  quick_heal: [KeyH]\n", "utf8");
    checkAfterSave(MACROS_PATH, Game.discover());
    expect(existsSync(OUT)).toBe(true);
    writeFileSync(MACROS, "macros: {}\n", "utf8");
    const check = checkAfterSave(MACROS_PATH, Game.discover());
    expect(check.buildErrors).toEqual([]);
    expect(existsSync(OUT)).toBe(false);
  });
});
