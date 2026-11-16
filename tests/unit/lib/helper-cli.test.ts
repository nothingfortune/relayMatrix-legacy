/**
 * `azeron helper ...` as a function: what it refuses and in what order, what it asks, and
 * what it says. The helper itself is replaced by a function that records what it was given,
 * so no process starts. The data root is a scratch copy of the fixture.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/paths.js")>();
  const root = mkdtempSync(join(tmpdir(), "azeron-helper-cli-"));
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
import { HELPER_USAGE, helperCommand } from "../../../src/lib/helper-cli.js";
import type { HelperCli } from "../../../src/lib/helper-cli.js";
import { HELPER_WARNING, writeHelperState } from "../../../src/lib/helper-tasks.js";
import { Game } from "../../../src/lib/model.js";
import { buildAll } from "../../../src/lib/tasks.js";

const GAME = "games/SpaceSims/everspace";
const GAME_YAML = join(dataRoot, GAME, "game.yaml");
const ACTIONS = join(dataRoot, GAME, "actions.yaml");
const MACROS = join(dataRoot, GAME, "macros.yaml");
const OUT = join(dataRoot, "dist/SpaceSims/everspace/macros.json");
const ORIGINAL_GAME = readFileSync(GAME_YAML, "utf8");
const ORIGINAL_ACTIONS = readFileSync(ACTIONS, "utf8");

/** The scratch everspace, with the helper on and one macro built. */
function turnOn(): void {
  writeFileSync(GAME_YAML, `${ORIGINAL_GAME}\nmacros:\n  helper: true\n`, "utf8");
  writeFileSync(
    ACTIONS,
    ORIGINAL_ACTIONS.replace(
      /^actions:\n/m,
      `actions:\n  quick_heal: {label: Quick heal, key: F13}\n`,
    ),
    "utf8",
  );
  writeFileSync(MACROS, `macros:\n  quick_heal: [KeyH, KeyJ]\n`, "utf8");
  buildAll([new Game(GAME)]);
}

let logs = "";
const savedLogs = process.env.AZERON_LOGS;

beforeEach(() => {
  logs = mkdtempSync(join(tmpdir(), "azeron-helper-cli-logs-"));
  process.env.AZERON_LOGS = logs;
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

interface Harness {
  cli: HelperCli;
  out: string[];
  err: string[];
  asked: string[];
  runs: { slug: string; host: string; macros: number }[];
}

function harness(
  extra: {
    wsl?: boolean;
    platform?: NodeJS.Platform;
    interactive?: boolean;
    answer?: boolean;
    code?: number;
  } = {},
): Harness {
  const h: Harness = {
    out: [],
    err: [],
    asked: [],
    runs: [],
    cli: {
      out: (line) => h.out.push(line),
      fail: (line) => h.err.push(line),
      games: (selector) => {
        const all = Game.discover();
        if (selector === undefined) return all;
        const picked = all.filter((game) => game.slug === selector);
        if (picked.length === 0) throw new Error(`no game matches '${selector}'`);
        return picked;
      },
      host: { platform: extra.platform ?? "win32", wsl: extra.wsl ?? false },
      interactive: extra.interactive ?? false,
      ask: (question) => {
        h.asked.push(question);
        return Promise.resolve(extra.answer ?? false);
      },
      run: (options) => {
        h.runs.push({
          slug: options.plan.game.slug,
          host: options.host,
          macros: options.plan.program.macros.length,
        });
        return Promise.resolve({ code: extra.code ?? 0, end: null });
      },
    },
  };
  return h;
}

describe("azeron helper", () => {
  it("needs a subcommand, and knows only start, stop and status", async () => {
    const h = harness();
    expect(await helperCommand(undefined, undefined, { yes: false }, h.cli)).toBe(1);
    expect(await helperCommand("restart", undefined, { yes: false }, h.cli)).toBe(1);
    expect(h.err).toEqual([HELPER_USAGE, `unknown helper command 'restart'. ${HELPER_USAGE}`]);
  });

  describe("start", () => {
    it("refuses a game that has not turned the helper on, and starts nothing", async () => {
      const h = harness();
      expect(await helperCommand("start", "everspace", { yes: true }, h.cli)).toBe(1);
      expect(h.err[0]).toMatch(
        /everspace: the helper is off\. Turn it on with macros: \{helper: true\}/,
      );
      expect(h.runs).toEqual([]);
      expect(h.out).toEqual([]);
    });

    it("refuses with no game named when none has it on", async () => {
      const h = harness();
      expect(await helperCommand("start", undefined, { yes: true }, h.cli)).toBe(1);
      expect(h.err[0]).toMatch(/no game has the helper on: add macros: \{helper: true\}/);
    });

    it("refuses a game that does not exist", async () => {
      const h = harness();
      await expect(helperCommand("start", "nope", { yes: true }, h.cli)).rejects.toThrow(
        "no game matches 'nope'",
      );
    });

    it("refuses a game with no program, saying to build, before it looks at the machine", async () => {
      turnOn();
      rmSync(OUT);
      const h = harness({ platform: "linux", wsl: false });
      expect(await helperCommand("start", "everspace", { yes: true }, h.cli)).toBe(1);
      expect(h.err[0]).toMatch(/macros\.json is missing\. Run azeron build/);
    });

    it("refuses on a machine it cannot run on, in one line, with nothing printed first", async () => {
      turnOn();
      const h = harness({ platform: "linux", wsl: false });
      expect(await helperCommand("start", "everspace", { yes: true }, h.cli)).toBe(1);
      expect(h.err).toEqual(["error: the helper runs on Windows (or WSL) only"]);
      expect(h.out).toEqual([]);
      expect(h.runs).toEqual([]);
    });

    it("refuses without --yes when nobody can be asked, after the warning", async () => {
      turnOn();
      const h = harness();
      expect(await helperCommand("start", "everspace", { yes: false }, h.cli)).toBe(1);
      expect(h.out).toEqual([...HELPER_WARNING]);
      expect(h.err).toEqual(["error: not started. Re-run with --yes to accept the warning above"]);
      expect(h.runs).toEqual([]);
    });

    it("asks when it can, and starts nothing on a no", async () => {
      turnOn();
      const h = harness({ interactive: true, answer: false });
      expect(await helperCommand("start", "everspace", { yes: false }, h.cli)).toBe(1);
      expect(h.asked).toEqual(["Start the helper for everspace?"]);
      expect(h.out.at(-1)).toBe("not started");
      expect(h.runs).toEqual([]);
    });

    it("starts on a yes, warning once", async () => {
      turnOn();
      const h = harness({ interactive: true, answer: true });
      expect(await helperCommand("start", "everspace", { yes: false }, h.cli)).toBe(0);
      expect(h.runs).toEqual([{ slug: "everspace", host: "windows", macros: 1 }]);
      expect(h.out.filter((line) => line === HELPER_WARNING[0])).toHaveLength(1);
    });

    it("starts with --yes and no question, and names the game itself when it is the only one on", async () => {
      turnOn();
      const h = harness();
      expect(await helperCommand("start", undefined, { yes: true }, h.cli)).toBe(0);
      expect(h.asked).toEqual([]);
      expect(h.runs).toEqual([{ slug: "everspace", host: "windows", macros: 1 }]);
    });

    it("runs through WSL as the wsl host, and passes the run's exit code on", async () => {
      turnOn();
      const h = harness({ platform: "linux", wsl: true, code: 1 });
      expect(await helperCommand("start", "everspace", { yes: true }, h.cli)).toBe(1);
      expect(h.runs[0]?.host).toBe("wsl");
    });
  });

  describe("status and stop", () => {
    it("says none runs, and exits non-zero so a script can ask", async () => {
      const h = harness();
      expect(await helperCommand("status", undefined, { yes: false }, h.cli)).toBe(1);
      expect(h.out).toEqual(["not running"]);
    });

    it("says what runs", async () => {
      writeHelperState({
        game: "everspace",
        macros: 2,
        startedAt: "2026-11-15T10:00:00.000Z",
        beat: Date.now(),
      });
      const h = harness();
      expect(await helperCommand("status", undefined, { yes: false }, h.cli)).toBe(0);
      expect(h.out).toEqual(["running: everspace, 2 macro(s), since 2026-11-15T10:00:00.000Z"]);
    });

    it("says one that has gone without stopping is gone", async () => {
      writeHelperState({ game: "everspace", macros: 2, startedAt: "x", beat: Date.now() - 60_000 });
      const h = harness();
      expect(await helperCommand("status", undefined, { yes: false }, h.cli)).toBe(1);
      expect(h.out[0]).toBe("not running (the helper for everspace has gone without stopping)");
    });

    it("says when there is nothing to stop", async () => {
      const h = harness();
      expect(await helperCommand("stop", undefined, { yes: false }, h.cli)).toBe(0);
      expect(h.out).toEqual(["no helper is running"]);
    });
  });
});
