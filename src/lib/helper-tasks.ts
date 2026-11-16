/**
 * The helper as operations, which the CLI and the served editor both call: whether a game may
 * start one and with what, and how a running one is found and stopped.
 *
 * A running helper is a foreground process, so `status` and `stop` have nothing to ask but a
 * file: a state file under `logs/` that the helper rewrites every couple of seconds (its
 * heartbeat), and a stop-request file it looks for. Nothing is killed by process id (a pid can
 * be another program's by the time it is used, and a pid from PowerShell means nothing in
 * WSL). A state file that has not been touched for a few seconds is a helper that is gone.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { posixJoin, repoPath } from "../config/paths.js";
import type { GameConfig } from "../types/profile.js";
import { validateProgram } from "./helper.js";
import { logPath } from "./io.js";
import { compileMacros, dumpMacros } from "./macros.js";
import type { CompiledMacros } from "./macros.js";
import type { Game } from "./model.js";

/** What a person is told once, before the helper is started. */
export const HELPER_WARNING: readonly string[] = [
  "Anti-cheat: the helper types keys with SendInput. Windows marks that input as injected,",
  "and some anti-cheat reads it as cheating. Check the game's rules first: a ban is on you.",
  "It swallows the keys that start a macro (F13-F24 from a keypad, a plain key) and types the macro's keys.",
  "Ctrl+Alt+Pause releases everything and stops it.",
];

/** Where the helper can run. */
export type HelperHost = "windows" | "wsl";

export interface HostInfo {
  platform: NodeJS.Platform;
  wsl: boolean;
}

/** Where this process is, as far as the helper goes: Windows, WSL, or neither. */
export function helperHost(info: HostInfo): HelperHost | null {
  if (info.platform === "win32") return "windows";
  if (info.platform === "linux" && info.wsl) return "wsl";
  return null;
}

/** The one line for a machine the helper cannot run on. */
export const NO_HOST = "the helper runs on Windows (or WSL) only";

/** Whether game.yaml turns the helper on. A malformed `macros:` throws, saying where. */
export function macroHelperOptIn(config: GameConfig, where = "game.yaml"): boolean {
  const section: unknown = config.macros;
  if (section === undefined || section === null) return false;
  if (typeof section !== "object" || Array.isArray(section)) {
    throw new Error(`${where}: macros must be a mapping, like {helper: true}`);
  }
  const helper = (section as Record<string, unknown>).helper;
  if (helper === undefined) return false;
  if (typeof helper !== "boolean") throw new Error(`${where}: macros.helper must be true or false`);
  return helper;
}

/** A game the helper may run, and the program it runs. */
export interface HelperPlan {
  game: Game;
  program: CompiledMacros;
  /** Repo-relative path of the compiled program. */
  file: string;
}

export type Prepared = { ok: true; plan: HelperPlan } | { ok: false; reason: string };

/**
 * Whether the helper may start for this game, in the order that is cheapest to fix: the game
 * has turned it on, it has macros, the compiled program is there and is what the macros say
 * now, and the helper can type all of it. Says why not, in one line.
 */
export function prepareHelper(game: Game): Prepared {
  const name = game.slug;
  if (!macroHelperOptIn(game.config, `${game.rel}/game.yaml`)) {
    return {
      ok: false,
      reason: `${name}: the helper is off. Turn it on with macros: {helper: true} in its game.yaml`,
    };
  }
  if (Object.keys(game.macros.macros).length === 0) {
    return { ok: false, reason: `${name}: no macros. Add some to its macros.yaml` };
  }
  const { program, problems } = compileMacros(game.macros, game.actions.actions);
  if (problems.length > 0) {
    const first = problems[0];
    return {
      ok: false,
      reason: `${name}: macros.yaml has ${String(problems.length)} problem(s), first '${first?.macro ?? ""}': ${first?.message ?? ""}. See azeron lint`,
    };
  }
  const file = posixJoin(game.distDir(), "macros.json");
  if (!existsSync(repoPath(file))) {
    return { ok: false, reason: `${name}: ${file} is missing. Run azeron build` };
  }
  if (readFileSync(repoPath(file), "utf8") !== dumpMacros(program)) {
    return { ok: false, reason: `${name}: ${file} is out of date. Run azeron build` };
  }
  const cannot = validateProgram(program);
  if (cannot.length > 0) {
    return { ok: false, reason: `${name}: the helper cannot run it: ${cannot[0] ?? ""}` };
  }
  return { ok: true, plan: { game, program, file } };
}

// ---------------------------------------------------------------------------------------
// A running helper, found through a file.

const STATE = "helper.json";
const STOP = "helper.stop";

/** How often a running helper says it is there, and how long without that means it is not. */
export const HEARTBEAT_MS = 2_000;
export const STALE_AFTER_MS = 7_000;

export interface HelperState {
  game: string;
  macros: number;
  startedAt: string;
  /** When the helper last said it was there, in ms since 1970. */
  beat: number;
}

export type HelperStatus =
  { running: true; state: HelperState } | { running: false; stale: HelperState | null };

export function readHelperState(): HelperState | null {
  try {
    const value: unknown = JSON.parse(readFileSync(logPath(STATE), "utf8"));
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record.game !== "string" ||
      typeof record.macros !== "number" ||
      typeof record.startedAt !== "string" ||
      typeof record.beat !== "number"
    ) {
      return null;
    }
    return {
      game: record.game,
      macros: record.macros,
      startedAt: record.startedAt,
      beat: record.beat,
    };
  } catch {
    return null;
  }
}

export function writeHelperState(state: HelperState): void {
  const file = logPath(STATE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state)}\n`, "utf8");
}

/** Forget the helper: it has ended, or it was found to be gone. */
export function clearHelperState(): void {
  rmSync(logPath(STATE), { force: true });
  rmSync(logPath(STOP), { force: true });
}

/** Whether a helper is running, by whether it has said so lately. */
export function helperStatus(now: number = Date.now()): HelperStatus {
  const state = readHelperState();
  if (state === null) return { running: false, stale: null };
  if (now - state.beat > STALE_AFTER_MS) return { running: false, stale: state };
  return { running: true, state };
}

/** Whether someone has asked the running helper to stop. */
export function stopRequested(): boolean {
  return existsSync(logPath(STOP));
}

export type StopResult =
  | { kind: "stopped"; game: string }
  | { kind: "not-running"; leftover: boolean }
  | { kind: "no-answer"; game: string };

/**
 * Ask a running helper to stop and wait for it to go. It looks for the request every half
 * second, so a few seconds is long enough; past that it is not answering and is not killed.
 */
export async function stopHelper(
  options: {
    waitMs?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<StopResult> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const status = helperStatus(now());
  if (!status.running) {
    const leftover = status.stale !== null;
    if (leftover) clearHelperState();
    return { kind: "not-running", leftover };
  }
  mkdirSync(dirname(logPath(STOP)), { recursive: true });
  writeFileSync(logPath(STOP), `${new Date(now()).toISOString()}\n`, "utf8");
  const until = now() + (options.waitMs ?? 8_000);
  while (now() < until) {
    await sleep(options.pollMs ?? 200);
    if (readHelperState() === null) {
      rmSync(logPath(STOP), { force: true });
      return { kind: "stopped", game: status.state.game };
    }
  }
  return { kind: "no-answer", game: status.state.game };
}
