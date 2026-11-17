/**
 * Running the helper, against a process that is only a script in this file: no PowerShell,
 * no hook, no input. It speaks the protocol the way the Windows side does, including
 * releasing what is down when its stdin closes.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { realClock } from "../../../src/lib/helper.js";
import type { HelperClock } from "../../../src/lib/helper.js";
import {
  powershellArgs,
  processTransport,
  runHelper,
  windowsSpelling,
  writeHelperScript,
} from "../../../src/lib/helper-node.js";
import type { Spawned, Spawner } from "../../../src/lib/helper-node.js";
import { readHelperState, writeHelperState } from "../../../src/lib/helper-tasks.js";
import type { HelperPlan } from "../../../src/lib/helper-tasks.js";
import type { CompiledMacros, MacroOp } from "../../../src/lib/macros.js";

/** The process: its pipes, and what it was sent. */
class FakeProcess implements Spawned {
  received: string[] = [];
  killed = false;
  exited = false;
  private stdoutListeners: ((chunk: string) => void)[] = [];
  private stderrListeners: ((chunk: string) => void)[] = [];
  private exitListeners: ((code: number | null) => void)[] = [];
  private errorListeners: ((error: Error) => void)[] = [];
  private pending = "";
  /** Never exits on its own when its stdin closes, so the caller has to end it. */
  ignoreEnd = false;

  stdin = {
    write: (chunk: string): void => {
      if (this.exited) throw new Error("write EPIPE");
      this.pending += chunk;
      const lines = this.pending.split("\n");
      this.pending = lines.pop() ?? "";
      for (const line of lines) {
        this.received.push(line);
        if (line.includes('"cmd":"stop"')) this.say({ ev: "stopped" }, 0);
      }
    },
    end: (): void => {
      if (!this.ignoreEnd && !this.exited) this.say({ ev: "stopped" }, 0);
    },
    on: (): void => undefined,
  };
  stdout = {
    setEncoding: (): void => undefined,
    on: (_event: "data", listener: (chunk: string) => void): void => {
      this.stdoutListeners.push(listener);
    },
  };
  stderr = {
    setEncoding: (): void => undefined,
    on: (_event: "data", listener: (chunk: string) => void): void => {
      this.stderrListeners.push(listener);
    },
  };

  onExit(listener: (code: number | null) => void): void {
    this.exitListeners.push(listener);
  }
  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }
  kill(): void {
    this.killed = true;
    this.finish(1);
  }

  /** Print an event, and optionally exit afterwards. */
  say(event: object, exitCode?: number): void {
    this.print(`${JSON.stringify(event)}\n`);
    if (exitCode !== undefined) this.finish(exitCode);
  }
  print(text: string): void {
    for (const listener of this.stdoutListeners) listener(text);
  }
  complain(text: string): void {
    for (const listener of this.stderrListeners) listener(text);
  }
  failToStart(message: string): void {
    for (const listener of this.errorListeners) listener(new Error(message));
  }
  finish(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener(code);
  }

  /** What was typed: down and up lines. */
  get typed(): string[] {
    return this.received
      .map((line) => JSON.parse(line) as { cmd: string; input?: { key?: string } })
      .filter((command) => command.cmd === "down" || command.cmd === "up")
      .map((command) => `${command.cmd} ${command.input?.key ?? ""}`);
  }
}

const tap = (code: string, hold = 5): MacroOp[] => [
  { op: "down", input: { key: code } },
  { op: "wait", ms: hold },
  { op: "up", input: { key: code } },
];

const program: CompiledMacros = {
  version: 2,
  macros: [
    {
      action: "abc",
      label: "ABC",
      repeat: false,
      on: [{ device: "azeron", input: "F13" }],
      ops: [...tap("KeyA"), ...tap("KeyB")],
    },
  ],
};

const plan = {
  game: { slug: "everspace" },
  program,
  file: "dist/x/macros.json",
} as unknown as HelperPlan;

let logs = "";
const savedLogs = process.env.AZERON_LOGS;

beforeEach(() => {
  logs = mkdtempSync(join(tmpdir(), "azeron-helper-node-"));
  process.env.AZERON_LOGS = logs;
});

afterEach(() => {
  rmSync(logs, { recursive: true, force: true });
  if (savedLogs === undefined) delete process.env.AZERON_LOGS;
  else process.env.AZERON_LOGS = savedLogs;
});

/** Options a test run uses: tight timers, no signals, and a script that is nothing. */
function options(child: FakeProcess, extra: Partial<Parameters<typeof runHelper>[0]> = {}) {
  const lines: string[] = [];
  let removed = 0;
  const spawned: { command: string; args: readonly string[] }[] = [];
  const spawner: Spawner = (command, args) => {
    spawned.push({ command, args });
    return child;
  };
  return {
    lines,
    spawned,
    removed: () => removed,
    options: {
      plan,
      host: "windows" as const,
      out: (line: string) => lines.push(line),
      spawner,
      writeScript: () => ({
        forPowerShell: "C:\\temp\\helper.ps1",
        remove: () => {
          removed++;
        },
      }),
      heartbeatMs: 20,
      stopPollMs: 10,
      startupMs: 2_000,
      ...extra,
    },
  };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("the process behind a transport", () => {
  it("reads events whatever the chunks, and keeps what is not an event", () => {
    const child = new FakeProcess();
    const transport = processTransport(child);
    const events: unknown[] = [];
    transport.onEvent((event) => events.push(event));
    child.print('\uFEFF{"ev":"re');
    child.print('ady"}\r\nWARNING: a thing\r\n{"ev":"down","device":"pad","input":"A"}\n');
    child.complain("At line:1 char:1\n+ Add-Type failed\n");
    expect(events).toEqual([{ ev: "ready" }, { ev: "down", device: "pad", input: "A" }]);
    expect(transport.notes()).toEqual([
      "WARNING: a thing",
      "At line:1 char:1",
      "+ Add-Type failed",
    ]);
  });

  it("says once when the process is gone, and refuses to send to it", () => {
    const child = new FakeProcess();
    const transport = processTransport(child);
    const closes: string[] = [];
    transport.onClose((reason) => closes.push(reason));
    child.finish(3);
    child.finish(4);
    child.failToStart("late");
    expect(closes).toEqual(["the helper process exited (code 3)"]);
    expect(() => {
      transport.send({ cmd: "stop" });
    }).toThrow("has gone");
  });

  it("says when the process could not start", async () => {
    const child = new FakeProcess();
    const transport = processTransport(child);
    const closes: string[] = [];
    transport.onClose((reason) => closes.push(reason));
    child.failToStart("spawn powershell.exe ENOENT");
    expect(closes).toEqual(["the helper process could not start: spawn powershell.exe ENOENT"]);
    await transport.exited;
  });
});

describe("the script on disk", () => {
  it("is written ASCII to a folder of its own, and removed", () => {
    const script = writeHelperScript("windows");
    try {
      const text = readFileSync(script.forPowerShell, "utf8");
      expect(text).toContain("[RelayMatrix.Helper]::Run()");
      expect(script.forPowerShell).toMatch(/relaymatrix-helper-.*helper\.ps1$/);
    } finally {
      script.remove();
    }
    expect(existsSync(script.forPowerShell)).toBe(false);
  });

  it("is told to PowerShell by its Windows spelling from WSL", () => {
    expect(windowsSpelling("/mnt/c/Users/me/AppData/Local/Temp/x/helper.ps1")).toBe(
      "C:\\Users\\me\\AppData\\Local\\Temp\\x\\helper.ps1",
    );
    expect(windowsSpelling("/mnt/d/t/h.ps1")).toBe("D:\\t\\h.ps1");
  });

  it("runs PowerShell with no profile, no prompt, and the script as a file", () => {
    expect(powershellArgs("C:\\h.ps1")).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\h.ps1",
    ]);
  });
});

describe("running the helper", () => {
  it("starts powershell.exe with the script, types a macro, and stops on a request", async () => {
    const child = new FakeProcess();
    const run = options(child);
    const result = runHelper(run.options);
    expect(run.spawned).toEqual([
      { command: "powershell.exe", args: powershellArgs("C:\\temp\\helper.ps1") },
    ]);
    child.say({ ev: "ready" });
    await wait(50);
    // It was told what to watch, and says it is running.
    expect(JSON.parse(child.received[0] ?? "{}")).toEqual({
      cmd: "watch",
      triggers: [{ device: "azeron", input: "F13" }],
    });
    expect(run.lines.join("\n")).toContain("helper on: everspace, 1 macro(s). Ctrl+Alt+Pause");
    expect(readHelperState()?.game).toBe("everspace");
    // The heartbeat moves; the time it started does not.
    const first = readHelperState();
    await wait(70);
    const later = readHelperState();
    expect(later?.startedAt).toBe(first?.startedAt);
    expect(later?.beat).toBeGreaterThan(first?.beat ?? Infinity);

    child.say({ ev: "down", device: "azeron", input: "F13" });
    child.say({ ev: "down", device: "azeron", input: "F13" });
    await wait(80);
    child.say({ ev: "up", device: "azeron", input: "F13" });
    expect(child.typed).toEqual(["down KeyA", "up KeyA", "down KeyB", "up KeyB"]);
    expect(run.lines).toContain("azeron F13");

    // `azeron helper stop` from another terminal: a request in the logs folder.
    writeFileSync(join(logs, "helper.stop"), "x", "utf8");
    const end = await result;
    expect(end.code).toBe(0);
    expect(end.end).toEqual({ reason: "stopped" });
    expect(run.lines.at(-1)).toBe("helper stopped");
    expect(child.exited).toBe(true);
    expect(child.killed).toBe(false);
    // Nothing is left behind: no record, no request, no script.
    expect(readHelperState()).toBeNull();
    expect(existsSync(join(logs, "helper.stop"))).toBe(false);
    expect(run.removed()).toBe(1);
  });

  it("is over when the panic key is pressed", async () => {
    const child = new FakeProcess();
    const run = options(child);
    const result = runHelper(run.options);
    child.say({ ev: "ready" });
    await wait(30);
    child.say({ ev: "panic" });
    child.finish(0);
    expect((await result).code).toBe(0);
    expect(run.lines.at(-1)).toBe("helper stopped by Ctrl+Alt+Pause");
    expect(readHelperState()).toBeNull();
  });

  it("is over, and says so, when the process dies", async () => {
    const child = new FakeProcess();
    const run = options(child);
    const result = runHelper(run.options);
    child.say({ ev: "ready" });
    await wait(30);
    child.finish(5);
    const end = await result;
    expect(end.code).toBe(1);
    expect(run.lines.at(-1)).toContain("helper ended: the helper process exited (code 5)");
    expect(readHelperState()).toBeNull();
  });

  it("says what PowerShell said when the process never gets ready", async () => {
    const child = new FakeProcess();
    const run = options(child);
    const result = runHelper(run.options);
    child.complain("Add-Type : error CS1002: ; expected\n");
    child.finish(1);
    expect((await result).code).toBe(1);
    expect(run.lines.at(-1)).toContain("the helper did not start");
    expect(run.lines.at(-1)).toContain("CS1002");
    expect(run.removed()).toBe(1);
    expect(readHelperState()).toBeNull();
  });

  it("says when the hook could not be installed", async () => {
    const child = new FakeProcess();
    const run = options(child);
    const result = runHelper(run.options);
    child.say({ ev: "error", message: "the keyboard hook could not be installed" }, 2);
    expect((await result).code).toBe(1);
    expect(run.lines.at(-1)).toContain("keyboard hook could not be installed");
  });

  it("gives up on a process that never gets ready, and asks it to go", async () => {
    const child = new FakeProcess();
    const run = options(child, { startupMs: 40 });
    const result = await runHelper(run.options);
    expect(result.code).toBe(1);
    expect(run.lines.at(-1)).toContain("the helper did not start");
    expect(child.received.at(-1)).toBe('{"cmd":"stop"}');
    expect(child.exited).toBe(true);
  });

  it("can be found, and is not started twice, while it is still compiling", async () => {
    const child = new FakeProcess();
    const first = options(child);
    const running = runHelper(first.options);
    await wait(30);
    // Not ready yet: the record is already there.
    expect(readHelperState()?.game).toBe("everspace");
    const second = options(new FakeProcess());
    expect((await runHelper(second.options)).code).toBe(1);
    expect(second.spawned).toEqual([]);
    expect(readHelperState()?.game).toBe("everspace");
    child.say({ ev: "ready" });
    await wait(30);
    writeFileSync(join(logs, "helper.stop"), "x", "utf8");
    expect((await running).code).toBe(0);
    expect(readHelperState()).toBeNull();
  });

  it("starts clean over a request left by a run that crashed", async () => {
    writeFileSync(join(logs, "helper.stop"), "x", "utf8");
    const child = new FakeProcess();
    const run = options(child);
    const result = runHelper(run.options);
    child.say({ ev: "ready" });
    await wait(60);
    expect(child.exited).toBe(false);
    writeFileSync(join(logs, "helper.stop"), "x", "utf8");
    expect((await result).code).toBe(0);
  });

  it("does not start a second helper beside a running one", async () => {
    writeHelperState({ game: "elite", macros: 3, startedAt: "x", beat: Date.now() });
    const child = new FakeProcess();
    const run = options(child);
    const result = await runHelper(run.options);
    expect(result.code).toBe(1);
    expect(run.lines).toEqual(["a helper is already running (elite); azeron helper stop ends it"]);
    expect(run.spawned).toEqual([]);
    // It is not the other helper's record to clear.
    expect(readHelperState()?.game).toBe("elite");
  });

  it("ends a process that ignores its stdin closing", async () => {
    const child = new FakeProcess();
    child.ignoreEnd = true;
    // The 3-second wait for a process to go is not one a test waits out.
    const clock: HelperClock = {
      now: () => realClock.now(),
      sleep: (ms, signal) => realClock.sleep(ms >= 3_000 ? 20 : ms, signal),
    };
    const run = options(child, { clock });
    const result = runHelper(run.options);
    child.say({ ev: "ready" });
    await wait(30);
    writeFileSync(join(logs, "helper.stop"), "x", "utf8");
    // `stop` is also sent, so the fake exits on that; make it not.
    child.stdin.write = (): void => undefined;
    expect((await result).code).toBe(0);
    expect(child.killed).toBe(true);
  });
});
