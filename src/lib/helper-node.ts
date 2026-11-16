/**
 * Running the helper: the node side that starts the Windows process and holds it. Spawning,
 * the temp file and signals are here, and nowhere a browser would import.
 *
 * The process is a child of this one, in the foreground, and Ctrl-C ends both. Its stdin is
 * the lifeline: when this process ends, however it ends, the pipe closes and the child
 * releases every key and exits.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { localPath } from "../config/paths.js";
import { HelperSession, LineDecoder, decodeEvent, encodeCommand, realClock } from "./helper.js";
import type {
  HelperClock,
  HelperCommand,
  HelperEvent,
  HelperTransport,
  SessionEnd,
} from "./helper.js";
import { helperScript } from "./helper-script.js";
import {
  HEARTBEAT_MS,
  clearHelperState,
  helperStatus,
  stopRequested,
  writeHelperState,
} from "./helper-tasks.js";
import type { HelperHost, HelperPlan } from "./helper-tasks.js";
import { PANIC_KEY_TEXT } from "./helper-keys.js";

/** What the node side needs of a process: pipes, an exit, a kill. A test supplies its own. */
export interface ReadableLike {
  setEncoding(encoding: "utf8"): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
}

export interface WritableLike {
  write(chunk: string): unknown;
  end(): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface Spawned {
  stdin: WritableLike;
  stdout: ReadableLike;
  stderr: ReadableLike;
  onExit(listener: (code: number | null) => void): void;
  onError(listener: (error: Error) => void): void;
  kill(): void;
}

export type Spawner = (command: string, args: readonly string[]) => Spawned;

export const spawnProcess: Spawner = (command, args) => {
  const child = spawn(command, [...args], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    onExit: (listener) => {
      child.on("exit", listener);
    },
    onError: (listener) => {
      child.on("error", listener);
    },
    kill: () => {
      child.kill();
    },
  };
};

/** The process behind a `HelperTransport`, and what it printed that was not an event. */
export interface ProcessTransport extends HelperTransport {
  /** The last lines it printed that were not events: a PowerShell error, mostly. */
  notes(): string[];
  /** Resolves when the process has exited. */
  readonly exited: Promise<void>;
}

const NOTES = 20;

export function processTransport(child: Spawned): ProcessTransport {
  let eventListener: (event: HelperEvent) => void = () => undefined;
  let closeListener: (reason: string) => void = () => undefined;
  let gone = false;
  const notes: string[] = [];
  const note = (text: string): void => {
    if (text === "") return;
    notes.push(text);
    if (notes.length > NOTES) notes.shift();
  };
  let finished: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const end = (reason: string): void => {
    if (gone) return;
    gone = true;
    closeListener(reason);
    finished();
  };

  const lines = new LineDecoder();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const line of lines.push(chunk)) {
      const decoded = decodeEvent(line);
      if (decoded.kind === "event") eventListener(decoded.event);
      else note(decoded.text);
    }
  });
  const errors = new LineDecoder();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    for (const line of errors.push(chunk)) note(line.trim());
  });
  // A write to a process that has gone is EPIPE; the exit says so.
  child.stdin.on("error", () => undefined);
  child.onExit((code) => {
    for (const line of lines.flush()) {
      const decoded = decodeEvent(line);
      if (decoded.kind === "event") eventListener(decoded.event);
      else note(decoded.text);
    }
    end(`the helper process exited${code === null ? "" : ` (code ${String(code)})`}`);
  });
  child.onError((error) => {
    note(error.message);
    end(`the helper process could not start: ${error.message}`);
  });

  return {
    send(command: HelperCommand): void {
      if (gone) throw new Error("the helper process has gone");
      child.stdin.write(encodeCommand(command));
    },
    onEvent(listener) {
      eventListener = listener;
    },
    onClose(listener) {
      closeListener = listener;
    },
    close(): void {
      try {
        child.stdin.end();
      } catch {
        // Already closed.
      }
    },
    notes: () => [...notes],
    exited,
  };
}

// ---------------------------------------------------------------------------------------
// The script on disk, where PowerShell can read it.

export interface ScriptFile {
  /** The path as PowerShell is told it. */
  forPowerShell: string;
  remove(): void;
}

/** The Windows temp folder, asked of PowerShell; from WSL, `/tmp` is not somewhere it can read. */
function windowsTemp(): string {
  const text = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "[System.IO.Path]::GetTempPath()"],
    { encoding: "utf8", timeout: 30_000 },
  );
  return text.trim();
}

/**
 * Write the helper's script to a temp folder of its own. On Windows that is the temp folder;
 * from WSL it is the Windows one, reached through /mnt, and PowerShell is given the
 * Windows spelling of the path.
 */
export function writeHelperScript(host: HelperHost, temp: () => string = windowsTemp): ScriptFile {
  const base = host === "wsl" ? localPath(temp()) : tmpdir();
  const dir = mkdtempSync(join(base, "relaymatrix-helper-"));
  const file = join(dir, "helper.ps1");
  writeFileSync(file, helperScript(), "utf8");
  return {
    forPowerShell: host === "wsl" ? windowsSpelling(file) : file,
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** `/mnt/c/Users/x/y` as `C:\Users\x\y`. */
export function windowsSpelling(path: string): string {
  const mounted = /^\/mnt\/([a-z])\/(.*)$/.exec(path);
  if (mounted === null) return path;
  return `${(mounted[1] ?? "c").toUpperCase()}:\\${(mounted[2] ?? "").replace(/\//g, "\\")}`;
}

export function powershellArgs(script: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script];
}

// ---------------------------------------------------------------------------------------

export interface RunOptions {
  plan: HelperPlan;
  host: HelperHost;
  out: (line: string) => void;
  /** How the process is started; a test supplies one that is not Windows. */
  spawner?: Spawner;
  clock?: HelperClock;
  /** Where the script is written. */
  writeScript?: (host: HelperHost) => ScriptFile;
  /** How long to wait for the process to report ready (it compiles its C# first). */
  startupMs?: number;
  /** Signals to stop on. A test passes none. */
  signals?: readonly NodeJS.Signals[];
  /** How often the heartbeat is written and the stop request looked for. */
  heartbeatMs?: number;
  stopPollMs?: number;
}

export interface RunResult {
  code: number;
  end: SessionEnd | null;
}

/**
 * Start the helper for a plan and hold it until it ends: Ctrl-C, `azeron helper stop`, the
 * panic key, or the process going. The exit code says whether that was a clean stop.
 */
export async function runHelper(options: RunOptions): Promise<RunResult> {
  const { plan, host, out } = options;
  const clock = options.clock ?? realClock;
  const already = helperStatus(clock.now());
  if (already.running) {
    out(`a helper is already running (${already.state.game}); azeron helper stop ends it`);
    return { code: 1, end: null };
  }

  const script = (options.writeScript ?? ((h) => writeHelperScript(h)))(host);
  const child = (options.spawner ?? spawnProcess)(
    "powershell.exe",
    powershellArgs(script.forPowerShell),
  );
  const transport = processTransport(child);
  const session = new HelperSession(plan.program, transport, {
    clock,
    log: out,
    trace: out,
  });

  const timers: NodeJS.Timeout[] = [];
  const handlers: [NodeJS.Signals, () => void][] = [];
  const cleanUp = (): void => {
    for (const timer of timers) clearInterval(timer);
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    clearHelperState();
    script.remove();
  };

  try {
    // Ctrl-C ends this process and the child alike; stopping the session first lets the
    // child release its keys on the way out.
    for (const signal of options.signals ?? []) {
      const handler = (): void => {
        void session.stop();
      };
      process.on(signal, handler);
      handlers.push([signal, handler]);
    }

    const startup = new AbortController();
    const timeout = clock
      .sleep(options.startupMs ?? 30_000, startup.signal)
      .then(() => (startup.signal.aborted ? undefined : ("timeout" as const)));
    const first = await Promise.race([
      session.ready.then(() => "ready" as const).catch(() => "ended" as const),
      timeout,
    ]);
    startup.abort();
    if (first !== "ready") {
      if (first === "timeout") await session.stop();
      const end = await session.ended;
      const detail = [end.message, ...transport.notes().slice(-3)].filter(Boolean).join(" | ");
      out(`the helper did not start${detail === "" ? "" : `: ${detail}`}`);
      await settle(transport, child, clock);
      return { code: 1, end };
    }

    const beat = (): void => {
      writeHelperState({
        game: plan.game.slug,
        macros: plan.program.macros.length,
        startedAt: new Date(clock.now()).toISOString(),
        beat: clock.now(),
      });
    };
    beat();
    timers.push(setInterval(beat, options.heartbeatMs ?? HEARTBEAT_MS));
    timers.push(
      setInterval(() => {
        if (stopRequested()) void session.stop();
      }, options.stopPollMs ?? 500),
    );
    out(
      `helper on: ${plan.game.slug}, ${String(plan.program.macros.length)} macro(s). ` +
        `${PANIC_KEY_TEXT} stops it, as does Ctrl-C.`,
    );

    const end = await session.ended;
    await settle(transport, child, clock);
    switch (end.reason) {
      case "stopped":
        out("helper stopped");
        return { code: 0, end };
      case "panic":
        out(`helper stopped by ${PANIC_KEY_TEXT}`);
        return { code: 0, end };
      default:
        out(`helper ended: ${end.message ?? end.reason}`);
        return { code: 1, end };
    }
  } finally {
    cleanUp();
  }
}

/** Give the process a moment to exit on its own; past that, end it. */
async function settle(
  transport: ProcessTransport,
  child: Spawned,
  clock: HelperClock,
): Promise<void> {
  const wait = new AbortController();
  const gone = await Promise.race([
    transport.exited.then(() => true),
    clock.sleep(3_000, wait.signal).then(() => false),
  ]);
  wait.abort();
  if (!gone) child.kill();
}
