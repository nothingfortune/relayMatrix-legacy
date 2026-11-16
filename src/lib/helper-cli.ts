/**
 * `azeron helper start | stop | status`, as a function of what it is given, so the smoke tests
 * and the unit tests reach the same code and a test never starts a Windows process.
 */

import { createInterface } from "node:readline/promises";

import { runHelper } from "./helper-node.js";
import type { RunOptions } from "./helper-node.js";
import {
  HELPER_WARNING,
  NO_HOST,
  helperHost,
  helperStatus,
  macroHelperOptIn,
  prepareHelper,
  stopHelper,
} from "./helper-tasks.js";
import type { HostInfo } from "./helper-tasks.js";
import type { Game } from "./model.js";

export interface HelperCli {
  out(line: string): void;
  /** A refusal or an error: stderr. */
  fail(line: string): void;
  /** The games matching a selector, or every game when there is none. Throws when none match. */
  games(selector?: string): Game[];
  host: HostInfo;
  /** Whether a person can be asked a question. */
  interactive: boolean;
  ask(question: string): Promise<boolean>;
  /** How the helper is run; a test replaces it. */
  run?: (options: RunOptions) => ReturnType<typeof runHelper>;
  /** Signals the run stops on. */
  signals?: RunOptions["signals"];
}

/** Ask a yes/no question on the terminal. */
export async function askOnTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export const HELPER_USAGE = "helper needs start [game] [--yes], stop or status";

/** The game `start` is for: the one named, or the only one that has turned the helper on. */
function pick(selector: string | undefined, cli: HelperCli): Game | string {
  if (selector !== undefined) {
    const found = cli.games(selector)[0];
    return found ?? `no game matches '${selector}'`;
  }
  const on = cli.games().filter((game) => macroHelperOptIn(game.config, `${game.rel}/game.yaml`));
  if (on.length === 0) {
    return "no game has the helper on: add macros: {helper: true} to a game.yaml";
  }
  if (on.length > 1) {
    return `several games have the helper on (${on.map((game) => game.slug).join(", ")}): name one`;
  }
  return on[0] ?? "no game has the helper on";
}

export async function helperCommand(
  sub: string | undefined,
  selector: string | undefined,
  flags: { yes: boolean },
  cli: HelperCli,
): Promise<number> {
  switch (sub) {
    case "start":
      return start(selector, flags.yes, cli);
    case "stop":
      return stop(cli);
    case "status":
      return status(cli);
    default:
      cli.fail(
        sub === undefined ? HELPER_USAGE : `unknown helper command '${sub}'. ${HELPER_USAGE}`,
      );
      return 1;
  }
}

async function start(selector: string | undefined, yes: boolean, cli: HelperCli): Promise<number> {
  const game = pick(selector, cli);
  if (typeof game === "string") {
    cli.fail(`error: ${game}`);
    return 1;
  }
  // Cheapest to fix first, and the same on every platform: the game, then the machine.
  const prepared = prepareHelper(game);
  if (!prepared.ok) {
    cli.fail(`error: ${prepared.reason}`);
    return 1;
  }
  const host = helperHost(cli.host);
  if (host === null) {
    cli.fail(`error: ${NO_HOST}`);
    return 1;
  }
  for (const line of HELPER_WARNING) cli.out(line);
  if (!yes) {
    if (!cli.interactive) {
      cli.fail("error: not started. Re-run with --yes to accept the warning above");
      return 1;
    }
    if (!(await cli.ask(`Start the helper for ${game.slug}?`))) {
      cli.out("not started");
      return 1;
    }
  }
  const run = cli.run ?? runHelper;
  const result = await run({
    plan: prepared.plan,
    host,
    out: (line) => {
      cli.out(line);
    },
    ...(cli.signals === undefined ? {} : { signals: cli.signals }),
  });
  return result.code;
}

async function stop(cli: HelperCli): Promise<number> {
  const result = await stopHelper();
  switch (result.kind) {
    case "stopped":
      cli.out(`stopped the helper for ${result.game}`);
      return 0;
    case "not-running":
      cli.out(
        result.leftover
          ? "no helper is running (cleared a leftover record)"
          : "no helper is running",
      );
      return 0;
    case "no-answer":
      cli.fail(
        `error: the helper for ${result.game} did not answer a stop. Ctrl-C in its terminal, or Ctrl+Alt+Pause`,
      );
      return 1;
  }
}

function status(cli: HelperCli): number {
  const now = helperStatus();
  if (now.running) {
    const { game, macros, startedAt } = now.state;
    cli.out(`running: ${game}, ${String(macros)} macro(s), since ${startedAt}`);
    return 0;
  }
  cli.out(
    now.stale === null
      ? "not running"
      : `not running (the helper for ${now.stale.game} has gone without stopping)`,
  );
  return 1;
}
