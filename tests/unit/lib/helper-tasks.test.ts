/**
 * Whether a game may start the helper, and how a running one is found and stopped. The data
 * root is a scratch copy of the fixture, and the state files are in a folder of their own:
 * nothing real is read or written, and no process is started.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/paths.js")>();
  const root = mkdtempSync(join(tmpdir(), "azeron-helper-"));
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
import {
  HEARTBEAT_MS,
  STALE_AFTER_MS,
  clearHelperState,
  helperHost,
  helperStatus,
  macroHelperOptIn,
  prepareHelper,
  readHelperState,
  stopHelper,
  stopRequested,
  writeHelperState,
} from "../../../src/lib/helper-tasks.js";
import type { Prepared } from "../../../src/lib/helper-tasks.js";
import { Game } from "../../../src/lib/model.js";
import { buildAll } from "../../../src/lib/tasks.js";

const GAME = "games/SpaceSims/everspace";
const GAME_YAML = join(dataRoot, GAME, "game.yaml");
const ACTIONS = join(dataRoot, GAME, "actions.yaml");
const MACROS = join(dataRoot, GAME, "macros.yaml");
const OUT = join(dataRoot, "dist/SpaceSims/everspace/macros.json");
const ORIGINAL_GAME = readFileSync(GAME_YAML, "utf8");
const ORIGINAL_ACTIONS = readFileSync(ACTIONS, "utf8");

const ON = `${ORIGINAL_GAME}\nmacros:\n  helper: true\n`;
const MACRO_ACTION = `actions:\n  quick_heal: {label: Quick heal, key: F13, kbm: Semicolon, pad: RB}\n`;
const STEPS = `macros:\n  quick_heal: [KeyH, KeyJ]\n`;

function setUp(options: { optIn?: boolean; macros?: boolean; build?: boolean }): Game {
  writeFileSync(GAME_YAML, options.optIn === false ? ORIGINAL_GAME : ON, "utf8");
  writeFileSync(ACTIONS, ORIGINAL_ACTIONS.replace(/^actions:\n/m, MACRO_ACTION), "utf8");
  if (options.macros !== false) writeFileSync(MACROS, STEPS, "utf8");
  if (options.build !== false) buildAll([new Game(GAME)]);
  return new Game(GAME);
}

let logs = "";
const savedLogs = process.env.AZERON_LOGS;

beforeEach(() => {
  logs = mkdtempSync(join(tmpdir(), "azeron-helper-logs-"));
  process.env.AZERON_LOGS = logs;
  rmSync(MACROS, { force: true });
  rmSync(OUT, { force: true });
});

afterEach(() => {
  writeFileSync(GAME_YAML, ORIGINAL_GAME, "utf8");
  writeFileSync(ACTIONS, ORIGINAL_ACTIONS, "utf8");
  rmSync(MACROS, { force: true });
  rmSync(OUT, { force: true });
  rmSync(logs, { recursive: true, force: true });
  if (savedLogs === undefined) delete process.env.AZERON_LOGS;
  else process.env.AZERON_LOGS = savedLogs;
});

describe("where the helper can run", () => {
  it("is Windows and WSL, and nowhere else", () => {
    expect(helperHost({ platform: "win32", wsl: false })).toBe("windows");
    expect(helperHost({ platform: "linux", wsl: true })).toBe("wsl");
    expect(helperHost({ platform: "linux", wsl: false })).toBeNull();
    expect(helperHost({ platform: "darwin", wsl: false })).toBeNull();
  });
});

describe("a game's opt-in", () => {
  it("is off unless game.yaml says macros: {helper: true}", () => {
    expect(macroHelperOptIn({})).toBe(false);
    expect(macroHelperOptIn({ macros: {} })).toBe(false);
    expect(macroHelperOptIn({ macros: { helper: false } })).toBe(false);
    expect(macroHelperOptIn({ macros: { helper: true } })).toBe(true);
  });

  it("fails loudly on a malformed section, naming the file", () => {
    const wrong = (value: unknown): Parameters<typeof macroHelperOptIn>[0] =>
      ({ macros: value }) as Parameters<typeof macroHelperOptIn>[0];
    expect(() => macroHelperOptIn(wrong(true), "x/game.yaml")).toThrow(
      "x/game.yaml: macros must be a mapping",
    );
    expect(() => macroHelperOptIn(wrong(["helper"]))).toThrow("must be a mapping");
    expect(() => macroHelperOptIn(wrong({ helper: "yes" }))).toThrow(
      "macros.helper must be true or false",
    );
  });

  it("is read from game.yaml", () => {
    expect(setUp({}).config.macros).toEqual({ helper: true });
    expect(new Game(GAME).config.macros).toEqual({ helper: true });
  });
});

/** Why a game was refused; fails the test when it was not. */
function refusal(prepared: Prepared): string {
  if (prepared.ok) throw new Error("expected a refusal");
  return prepared.reason;
}

describe("whether a game may start the helper", () => {
  it("may, when it has opted in and its program is built, and returns the program", () => {
    const prepared = prepareHelper(setUp({}));
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(prepared.plan.program.macros.map((macro) => macro.action)).toEqual(["quick_heal"]);
    expect(prepared.plan.file).toMatch(/macros\.json$/);
  });

  it("refuses a game that has not turned it on, before anything else", () => {
    const prepared = prepareHelper(setUp({ optIn: false, build: false }));
    expect(refusal(prepared)).toMatch(
      /everspace: the helper is off\. Turn it on with macros: \{helper: true\}/,
    );
  });

  it("refuses a game with no macros", () => {
    const prepared = prepareHelper(setUp({ macros: false, build: false }));
    expect(refusal(prepared)).toMatch(/no macros/);
  });

  it("refuses a program that was never built, and says to build", () => {
    const prepared = prepareHelper(setUp({ build: false }));
    expect(refusal(prepared)).toMatch(/macros\.json is missing\. Run azeron build/);
  });

  it("refuses a program that is out of date", () => {
    const game = setUp({});
    writeFileSync(MACROS, `macros:\n  quick_heal: [KeyH, KeyJ, KeyK]\n`, "utf8");
    const prepared = prepareHelper(new Game(GAME));
    expect(game.macros.macros.quick_heal?.steps).toHaveLength(2);
    expect(refusal(prepared)).toMatch(/is out of date\. Run azeron build/);
  });

  it("refuses macros that do not compile, and says which", () => {
    const game = setUp({});
    writeFileSync(MACROS, `macros:\n  quick_heal: [{action: not_an_action}]\n`, "utf8");
    expect(game.slug).toBe("everspace");
    const prepared = prepareHelper(new Game(GAME));
    expect(refusal(prepared)).toMatch(/'quick_heal': .*not_an_action.*azeron lint/);
  });

  it("refuses a program with a key the helper cannot type, naming the key", () => {
    setUp({});
    writeFileSync(MACROS, `macros:\n  quick_heal: [Pause]\n`, "utf8");
    // Pause is a key the game could bind, and the helper cannot type.
    writeFileSync(
      ACTIONS,
      ORIGINAL_ACTIONS.replace(
        /^actions:\n/m,
        `actions:\n  quick_heal: {label: Quick heal, key: F13}\n`,
      ),
      "utf8",
    );
    buildAll([new Game(GAME)]);
    const prepared = prepareHelper(new Game(GAME));
    expect(refusal(prepared)).toMatch(/cannot run it: 'quick_heal' types Pause/);
  });
});

describe("finding a running helper", () => {
  const state = (beat: number) => ({
    game: "everspace",
    macros: 2,
    startedAt: "2026-11-15T10:00:00.000Z",
    beat,
  });

  it("says none runs when nothing has been written", () => {
    expect(helperStatus(1_000)).toEqual({ running: false, stale: null });
    expect(readHelperState()).toBeNull();
  });

  it("says one runs while it keeps saying so, and that it is gone when it stops", () => {
    writeHelperState(state(10_000));
    expect(helperStatus(10_000 + HEARTBEAT_MS)).toEqual({ running: true, state: state(10_000) });
    const gone = helperStatus(10_000 + STALE_AFTER_MS + 1);
    expect(gone).toEqual({ running: false, stale: state(10_000) });
  });

  it("reads a damaged record as none", () => {
    writeFileSync(join(logs, "helper.json"), "{not json", "utf8");
    expect(readHelperState()).toBeNull();
    writeFileSync(join(logs, "helper.json"), '{"game":1}', "utf8");
    expect(readHelperState()).toBeNull();
  });

  it("clears the record and the stop request", () => {
    writeHelperState(state(1));
    writeFileSync(join(logs, "helper.stop"), "x", "utf8");
    clearHelperState();
    expect(readHelperState()).toBeNull();
    expect(stopRequested()).toBe(false);
  });
});

describe("stopping it", () => {
  /** A clock that moves when asked to sleep. */
  const clock = (start = 100_000) => {
    let time = start;
    return {
      now: () => time,
      sleep: (ms: number) => {
        time += ms;
        return Promise.resolve();
      },
    };
  };

  it("says so when nothing runs", async () => {
    const { now, sleep } = clock();
    expect(await stopHelper({ now, sleep })).toEqual({ kind: "not-running", leftover: false });
  });

  it("clears the record of one that has gone without stopping", async () => {
    const { now, sleep } = clock();
    writeHelperState({ game: "everspace", macros: 1, startedAt: "x", beat: now() - 60_000 });
    expect(await stopHelper({ now, sleep })).toEqual({ kind: "not-running", leftover: true });
    expect(readHelperState()).toBeNull();
  });

  it("asks a running one, and waits for it to go", async () => {
    const { now, sleep } = clock();
    writeHelperState({ game: "everspace", macros: 1, startedAt: "x", beat: now() });
    let polls = 0;
    const result = await stopHelper({
      now,
      sleep: (ms) => {
        polls++;
        // The helper sees the request on its second look and removes its record.
        if (polls === 2) {
          expect(stopRequested()).toBe(true);
          clearHelperState();
        }
        return sleep(ms);
      },
    });
    expect(result).toEqual({ kind: "stopped", game: "everspace" });
    expect(existsSync(join(logs, "helper.stop"))).toBe(false);
  });

  it("says when a running one does not answer, and kills nothing", async () => {
    const { now, sleep } = clock();
    writeHelperState({ game: "everspace", macros: 1, startedAt: "x", beat: now() });
    const result = await stopHelper({
      now,
      sleep: (ms) => {
        // It keeps saying it is there.
        writeHelperState({ game: "everspace", macros: 1, startedAt: "x", beat: now() });
        return sleep(ms);
      },
      waitMs: 1_000,
    });
    expect(result).toEqual({ kind: "no-answer", game: "everspace" });
  });
});
