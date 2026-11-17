/**
 * A game's macros through the build and the checks: macros.yaml is read, dist/<game>/macros.json
 * is written and held to the gate like every other output, and a macro that does not resolve is
 * an error. The data root is a scratch copy of the fixture: nothing real is read or written.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/paths.js")>();
  const root = mkdtempSync(join(tmpdir(), "azeron-macros-"));
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
import { ERROR, lintGame } from "../../../src/lib/lint.js";
import { Game } from "../../../src/lib/model.js";
import { buildAll } from "../../../src/lib/tasks.js";

const GAME = "games/SpaceSims/everspace";
const MACROS = join(dataRoot, GAME, "macros.yaml");
const ACTIONS = join(dataRoot, GAME, "actions.yaml");
const OUT = join(dataRoot, "dist/SpaceSims/everspace/macros.json");
const ORIGINAL_ACTIONS = readFileSync(ACTIONS, "utf8");

/** Two macro actions added to the scratch game: one trigger each, and a game key to type. */
function addActions(extra = ""): void {
  const added = `actions:\n  quick_heal: {label: Quick heal, key: F13, kbm: KeyM, pad: RB}\n  reload_all: {label: Reload all, key: F14, kbm: KeyR}\n${extra}`;
  writeFileSync(ACTIONS, ORIGINAL_ACTIONS.replace(/^actions:\n/m, added), "utf8");
}

const macros = (text: string): void => {
  writeFileSync(MACROS, text, "utf8");
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

describe("a game with no macros", () => {
  it("has none, builds no macros.json, and lints no macro findings", () => {
    const game = new Game(GAME);
    expect(game.macros).toEqual({ macros: {} });
    const result = buildAll([game]);
    expect(result.errors).toEqual([]);
    expect(existsSync(OUT)).toBe(false);
    expect(lintGame(game).live.filter((finding) => finding.rule.startsWith("macro"))).toEqual([]);
  });
});

describe("a game with macros", () => {
  const steps = `macros:
  quick_heal:
    repeat: true
    steps: [KeyH, {wait: 40}, {action: reload_all}]
`;

  it("reads macros.yaml and writes the program to dist, with every button that starts it", () => {
    addActions();
    macros(steps);
    const game = new Game(GAME);
    expect(Object.keys(game.macros.macros)).toEqual(["quick_heal"]);
    const result = buildAll([game]);
    expect(result.errors).toEqual([]);
    const program = JSON.parse(readFileSync(OUT, "utf8")) as {
      version: number;
      macros: { action: string; repeat: boolean; on: unknown[]; ops: unknown[] }[];
    };
    expect(program.version).toBe(2);
    expect(program.macros).toHaveLength(1);
    expect(program.macros[0]).toMatchObject({
      action: "quick_heal",
      repeat: true,
      on: [
        { device: "azeron", input: "F13" },
        { device: "keyboard", input: "KeyM" },
        { device: "pad", input: "RB" },
      ],
    });
    // Two taps (down, wait, up each), the wait between them, and the gap that closes a
    // repeating pass, since it ends and starts on a tap.
    expect(program.macros[0]?.ops).toHaveLength(8);
    expect(result.built.some((entry) => entry.output.endsWith("macros.json"))).toBe(true);
  });

  it("is a fixed point: building again changes nothing, and --check agrees", () => {
    addActions();
    macros(steps);
    buildAll([new Game(GAME)]);
    const again = buildAll([new Game(GAME)]);
    expect(again.built.find((entry) => entry.output.endsWith("macros.json"))?.changed).toBe(false);
    expect(buildAll([new Game(GAME)], true).errors).toEqual([]);
  });

  it("fails the check when the committed program is stale, and when a macro is gone", () => {
    addActions();
    macros(steps);
    buildAll([new Game(GAME)]);
    writeFileSync(OUT, `${readFileSync(OUT, "utf8")} `, "utf8");
    expect(buildAll([new Game(GAME)], true).errors).toEqual([
      expect.stringMatching(/^stale: .*macros\.json does not match .*macros\.yaml$/),
    ]);
    buildAll([new Game(GAME)]); // rebuilt
    rmSync(MACROS);
    expect(buildAll([new Game(GAME)], true).errors).toEqual([
      expect.stringMatching(/^stale: .*macros\.json has no macros in /),
    ]);
    // Building removes the file the macros left behind.
    buildAll([new Game(GAME)]);
    expect(existsSync(OUT)).toBe(false);
  });

  it("refuses to build a macro that does not resolve, and says which", () => {
    addActions();
    macros(`macros:
  quick_heal:
    steps:
      - {tap: {action: not_an_action}}
`);
    const result = buildAll([new Game(GAME)]);
    expect(result.errors).toEqual([
      expect.stringContaining("quick_heal: step 1: no action 'not_an_action'"),
    ]);
    expect(existsSync(OUT)).toBe(false);
  });

  it("raises macro-invalid and macro-trigger as errors that cannot be accepted", () => {
    addActions();
    macros(`macros:
  quick_heal:
    steps:
      - {tap: {action: not_an_action}}
  throttle_up:
    steps:
      - {tap: KeyH}
`);
    const found = lintGame(new Game(GAME)).live.filter((finding) =>
      finding.rule.startsWith("macro"),
    );
    expect(found).toEqual([
      {
        level: ERROR,
        rule: "macro-invalid",
        key: "quick_heal",
        message: "step 1: no action 'not_an_action'",
      },
      {
        level: ERROR,
        rule: "macro-trigger",
        key: "throttle_up",
        message: "keypad key KeyW is not an F13-F24 key",
      },
    ]);
    // No profile, so the page offers no Accept for them.
    expect(found.every((finding) => finding.profile === undefined)).toBe(true);
  });
});
