/**
 * The helper's bridge: the protocol, and a session that wires a runner to a transport. The
 * transport and the clock are fakes, so there is no process and no waiting.
 */

import { describe, expect, it } from "vitest";

import {
  HelperSession,
  LineDecoder,
  decodeEvent,
  encodeCommand,
  validateProgram,
} from "../../../src/lib/helper.js";
import type {
  HelperClock,
  HelperCommand,
  HelperEvent,
  HelperTransport,
} from "../../../src/lib/helper.js";
import type {
  CompiledMacros,
  MacroInput,
  MacroOp,
  TriggerDevice,
} from "../../../src/lib/macros.js";

const key = (code: string): MacroInput => ({ key: code });
const tap = (code: string, hold = 10): MacroOp[] => [
  { op: "down", input: key(code) },
  { op: "wait", ms: hold },
  { op: "up", input: key(code) },
];

const program = (
  macros: Record<string, { on: [TriggerDevice, string][]; repeat?: boolean; ops: MacroOp[] }>,
): CompiledMacros => ({
  version: 2,
  macros: Object.entries(macros).map(([action, macro]) => ({
    action,
    label: action,
    repeat: macro.repeat === true,
    on: macro.on.map(([device, input]) => ({ device, input })),
    ops: macro.ops,
  })),
});

/** A clock that moves only when told, and runs what is due in order. */
class FakeClock implements HelperClock {
  time = 0;
  private timers: { at: number; wake: () => void }[] = [];

  now(): number {
    return this.time;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const timer = { at: this.time + ms, wake: resolve };
      this.timers.push(timer);
      signal?.addEventListener(
        "abort",
        () => {
          this.timers = this.timers.filter((entry) => entry !== timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  /** Let promises settle. */
  async settle(): Promise<void> {
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
  }

  async advance(ms: number): Promise<void> {
    const until = this.time + ms;
    await this.settle();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (next === undefined || next.at > until) break;
      this.timers.shift();
      this.time = next.at;
      next.wake();
      await this.settle();
    }
    this.time = until;
  }

  get pending(): number {
    return this.timers.length;
  }
}

/** A process that is only a list of what was sent, and a way to say what it reported. */
class FakeTransport implements HelperTransport {
  sent: HelperCommand[] = [];
  closed = false;
  failSends = false;
  private listener: (event: HelperEvent) => void = () => undefined;
  private closeListener: (reason: string) => void = () => undefined;

  send(command: HelperCommand): void {
    if (this.failSends) throw new Error("EPIPE");
    this.sent.push(command);
  }
  onEvent(listener: (event: HelperEvent) => void): void {
    this.listener = listener;
  }
  onClose(listener: (reason: string) => void): void {
    this.closeListener = listener;
  }
  close(): void {
    this.closed = true;
  }

  emit(event: HelperEvent): void {
    this.listener(event);
  }
  die(reason = "exited"): void {
    this.closeListener(reason);
  }
  /** What was typed, as a log. */
  get typed(): string[] {
    return this.sent
      .filter((command) => command.cmd === "down" || command.cmd === "up")
      .map((command) => {
        const input = (command as { input: MacroInput }).input;
        return `${command.cmd} ${"key" in input ? input.key : `mouse ${input.mouse}`}`;
      });
  }
}

const press = (device: TriggerDevice, input: string): HelperEvent => ({
  ev: "down",
  device,
  input,
});
const release = (device: TriggerDevice, input: string): HelperEvent => ({
  ev: "up",
  device,
  input,
});

function start(
  macros: CompiledMacros,
  options: { maxDownsPerSecond?: number } = {},
): { session: HelperSession; transport: FakeTransport; clock: FakeClock; log: string[] } {
  const transport = new FakeTransport();
  const clock = new FakeClock();
  const log: string[] = [];
  const session = new HelperSession(macros, transport, {
    clock,
    log: (line) => log.push(line),
    ...options,
  });
  return { session, transport, clock, log };
}

const abc = program({
  abc: {
    on: [
      ["azeron", "F13"],
      ["keyboard", "KeyM"],
      ["pad", "RB"],
    ],
    ops: [...tap("KeyA"), ...tap("KeyB"), ...tap("KeyC")],
  },
});

describe("the protocol", () => {
  it("writes a command as one line of JSON", () => {
    expect(encodeCommand({ cmd: "down", input: { key: "KeyA" } })).toBe(
      '{"cmd":"down","input":{"key":"KeyA"}}\n',
    );
    expect(encodeCommand({ cmd: "stop" })).toBe('{"cmd":"stop"}\n');
    expect(encodeCommand({ cmd: "watch", triggers: [{ device: "azeron", input: "F13" }] })).toBe(
      '{"cmd":"watch","triggers":[{"device":"azeron","input":"F13"}]}\n',
    );
  });

  it("reads each event", () => {
    expect(decodeEvent('{"ev":"ready"}')).toEqual({ kind: "event", event: { ev: "ready" } });
    expect(decodeEvent('{"ev":"down","device":"pad","input":"RB"}')).toEqual({
      kind: "event",
      event: { ev: "down", device: "pad", input: "RB" },
    });
    expect(decodeEvent('{"ev":"error","message":"no hook"}')).toEqual({
      kind: "event",
      event: { ev: "error", message: "no hook" },
    });
    expect(decodeEvent('{"ev":"panic"}').kind).toBe("event");
    expect(decodeEvent('{"ev":"stopped"}').kind).toBe("event");
  });

  it("never throws on what PowerShell prints that is not an event", () => {
    for (const line of [
      "",
      "WARNING: something",
      "{not json",
      "42",
      "null",
      '"text"',
      '{"ev":"down"}',
      '{"ev":"down","device":"gamepad","input":"A"}',
      '{"ev":"down","device":"pad","input":""}',
      '{"ev":"mystery"}',
      "[1,2]",
    ]) {
      expect(decodeEvent(line).kind, line).toBe("text");
    }
  });

  it("strips a byte-order mark", () => {
    expect(decodeEvent('﻿{"ev":"ready"}')).toEqual({
      kind: "event",
      event: { ev: "ready" },
    });
  });

  it("splits lines whatever the chunks and the endings", () => {
    const lines = new LineDecoder();
    expect(lines.push('{"ev":"re')).toEqual([]);
    expect(lines.push('ady"}\r\n{"ev":"pan')).toEqual(['{"ev":"ready"}']);
    expect(lines.push('ic"}\n\n\nrest')).toEqual(['{"ev":"panic"}']);
    expect(lines.flush()).toEqual(["rest"]);
    expect(lines.flush()).toEqual([]);
  });
});

describe("validating a program", () => {
  it("accepts a program the helper can type", () => {
    expect(validateProgram(abc)).toEqual([]);
  });

  it("names a key it cannot type, a trigger it cannot read, and a version it does not know", () => {
    const bad = program({
      one: {
        on: [
          ["azeron", "KeyM"],
          ["keyboard", "Nonsense"],
          ["pad", "LeftStickUp"],
        ],
        ops: [
          { op: "down", input: key("Pause") },
          { op: "down", input: { mouse: "left" } },
          { op: "wait", ms: 20_000 },
        ],
      },
    });
    const problems = validateProgram(bad);
    expect(problems.join("\n")).toContain("types Pause");
    expect(problems.join("\n")).toContain("KeyM, which is not an F13-F24 key");
    expect(problems.join("\n")).toContain("Nonsense, which the helper cannot read");
    expect(problems.join("\n")).toContain("LeftStickUp, which the helper cannot read");
    expect(problems.join("\n")).toContain("waits 20000 ms");
    expect(validateProgram({ ...abc, version: 3 as unknown as 2 })[0]).toContain("version 3");
  });

  it("refuses more operations than the limit", () => {
    const long = program({
      long: {
        on: [["azeron", "F13"]],
        ops: Array.from({ length: 600 }, () => tap("KeyA")[0] ?? { op: "wait", ms: 0 }),
      },
    });
    expect(validateProgram(long).join("\n")).toContain("600 operations");
  });
});

describe("a session", () => {
  it("tells the process what to watch once it is ready", async () => {
    const { session, transport } = start(abc);
    expect(transport.sent).toEqual([]);
    transport.emit({ ev: "ready" });
    await session.ready;
    expect(transport.sent).toEqual([
      {
        cmd: "watch",
        triggers: [
          { device: "azeron", input: "F13" },
          { device: "keyboard", input: "KeyM" },
          { device: "pad", input: "RB" },
        ],
      },
    ]);
  });

  it("types a macro when its button goes down, with the clock it was given", async () => {
    const { session, transport, clock } = start(abc);
    transport.emit({ ev: "ready" });
    await session.ready;
    transport.emit(press("azeron", "F13"));
    await clock.settle();
    expect(transport.typed).toEqual(["down KeyA"]);
    await clock.advance(10);
    expect(transport.typed).toEqual(["down KeyA", "up KeyA", "down KeyB"]);
    await clock.advance(30);
    expect(transport.typed).toEqual([
      "down KeyA",
      "up KeyA",
      "down KeyB",
      "up KeyB",
      "down KeyC",
      "up KeyC",
    ]);
    expect(clock.pending).toBe(0);
  });

  it("starts a macro from a keyboard key and from a controller button as well", async () => {
    for (const [device, input] of [
      ["keyboard", "KeyM"],
      ["pad", "RB"],
    ] as const) {
      const { session, transport, clock } = start(abc);
      transport.emit({ ev: "ready" });
      await session.ready;
      transport.emit(press(device, input));
      await clock.advance(100);
      expect(transport.typed.filter((line) => line.startsWith("down")).length).toBe(3);
    }
  });

  it("runs once however long the button is held, repeats of its down included", async () => {
    const { session, transport, clock } = start(abc);
    transport.emit({ ev: "ready" });
    await session.ready;
    transport.emit(press("keyboard", "KeyM"));
    await clock.advance(20);
    // Windows repeats the down of a held key; they are not new presses.
    transport.emit(press("keyboard", "KeyM"));
    transport.emit(press("keyboard", "KeyM"));
    await clock.advance(500);
    // Held on after the macro finished: still one run.
    transport.emit(press("keyboard", "KeyM"));
    await clock.advance(500);
    expect(transport.typed.filter((line) => line.startsWith("down"))).toHaveLength(3);
    // Let go and press again: a second run.
    transport.emit(release("keyboard", "KeyM"));
    transport.emit(press("keyboard", "KeyM"));
    await clock.advance(500);
    expect(transport.typed.filter((line) => line.startsWith("down"))).toHaveLength(6);
  });

  it("repeats a repeating macro while held, and stops on release", async () => {
    const { session, transport, clock } = start(
      program({ spam: { on: [["azeron", "F14"]], repeat: true, ops: tap("KeyX", 20) } }),
    );
    transport.emit({ ev: "ready" });
    await session.ready;
    transport.emit(press("azeron", "F14"));
    await clock.advance(100);
    const downs = (): number => transport.typed.filter((line) => line === "down KeyX").length;
    expect(downs()).toBeGreaterThanOrEqual(4);
    transport.emit(release("azeron", "F14"));
    await clock.advance(100);
    const after = downs();
    await clock.advance(200);
    expect(downs()).toBe(after);
    expect(transport.typed.at(-1)).toBe("up KeyX");
  });

  it("ignores a button that starts nothing", async () => {
    const { session, transport, clock, log } = start(abc);
    transport.emit({ ev: "ready" });
    await session.ready;
    transport.emit(press("azeron", "F20"));
    await clock.advance(100);
    expect(transport.typed).toEqual([]);
    expect(log.join("\n")).toContain("azeron F20 is not a trigger");
  });

  it("does nothing before the process is ready", async () => {
    const { transport, clock } = start(abc);
    transport.emit(press("azeron", "F13"));
    await clock.advance(100);
    expect(transport.sent).toEqual([]);
  });

  it("on stop lifts what a macro had down, sleeps no longer, and asks the process to exit", async () => {
    const { session, transport, clock } = start(
      program({
        held: {
          on: [["azeron", "F15"]],
          ops: [
            { op: "down", input: key("ShiftLeft") },
            { op: "wait", ms: 9_000 },
            { op: "up", input: key("ShiftLeft") },
          ],
        },
      }),
    );
    transport.emit({ ev: "ready" });
    await session.ready;
    transport.emit(press("azeron", "F15"));
    await clock.advance(50);
    expect(transport.typed).toEqual(["down ShiftLeft"]);
    // Nine seconds of waiting are cut short: the clock does not move.
    await session.stop();
    expect(transport.typed).toEqual(["down ShiftLeft", "up ShiftLeft"]);
    expect(transport.sent.at(-1)).toEqual({ cmd: "stop" });
    expect(transport.closed).toBe(true);
    expect(await session.ended).toEqual({ reason: "stopped" });
    expect(clock.pending).toBe(0);
  });

  it("is over when the panic key is pressed, and sends nothing more", async () => {
    const { session, transport, clock } = start(abc);
    transport.emit({ ev: "ready" });
    await session.ready;
    transport.emit(press("azeron", "F13"));
    await clock.advance(15);
    const before = transport.sent.length;
    transport.emit({ ev: "panic" });
    await clock.advance(1_000);
    expect(await session.ended).toEqual({ reason: "panic" });
    // The process released everything itself and has gone: nothing is sent to it.
    expect(transport.sent.length).toBe(before);
    expect(transport.closed).toBe(true);
    // A late press does nothing.
    transport.emit(press("azeron", "F13"));
    await clock.advance(100);
    expect(transport.sent.length).toBe(before);
  });

  it("stops every macro when the process dies, and types nothing after", async () => {
    const { session, transport, clock } = start(abc);
    transport.emit({ ev: "ready" });
    await session.ready;
    transport.emit(press("azeron", "F13"));
    await clock.advance(5);
    const before = transport.sent.length;
    transport.die("exit code 1");
    await clock.advance(1_000);
    expect(await session.ended).toEqual({ reason: "closed", message: "exit code 1" });
    expect(transport.sent.length).toBe(before);
    expect(clock.pending).toBe(0);
  });

  it("treats a send that throws as a dead process", async () => {
    const { session, transport, clock, log } = start(abc);
    transport.emit({ ev: "ready" });
    await session.ready;
    transport.failSends = true;
    transport.emit(press("azeron", "F13"));
    await clock.advance(100);
    expect(log.join("\n")).toContain("could not send to the process: EPIPE");
    transport.failSends = false;
    transport.emit(press("keyboard", "KeyM"));
    await clock.advance(100);
    expect(transport.typed).toEqual([]);
  });

  it("ends by itself when the runaway guard trips, with its keys up", async () => {
    const { session, transport, clock } = start(
      program({ fast: { on: [["azeron", "F16"]], repeat: true, ops: tap("KeyX", 10) } }),
      { maxDownsPerSecond: 5 },
    );
    transport.emit({ ev: "ready" });
    await session.ready;
    transport.emit(press("azeron", "F16"));
    await clock.advance(1_000);
    const end = await session.ended;
    expect(end.reason).toBe("runaway");
    expect(end.message).toContain("more than 5 key presses");
    expect(transport.typed.filter((line) => line.startsWith("down"))).toHaveLength(5);
    expect(transport.sent.at(-1)).toEqual({ cmd: "stop" });
    expect(transport.typed.at(-1)?.startsWith("up")).toBe(true);
  });

  it("does not trip on a macro of any length, only on a rate", async () => {
    // 512 operations, the most one macro may have, all at once is not a runaway at the default.
    const ops: MacroOp[] = Array.from({ length: 80 }, () => tap("KeyA", 1)).flat();
    const { session, transport, clock } = start(program({ big: { on: [["azeron", "F17"]], ops } }));
    transport.emit({ ev: "ready" });
    await session.ready;
    transport.emit(press("azeron", "F17"));
    await clock.advance(1_000);
    transport.emit({ ev: "stopped" });
    expect(transport.typed.filter((line) => line.startsWith("down"))).toHaveLength(80);
  });

  it("fails ready when the process reports an error before it is ready", async () => {
    const { session, transport } = start(abc);
    transport.emit({ ev: "error", message: "the keyboard hook could not be installed" });
    await expect(session.ready).rejects.toThrow("keyboard hook");
    expect((await session.ended).reason).toBe("error");
    expect(transport.closed).toBe(true);
  });

  it("only logs an error once it is running", async () => {
    const { session, transport, clock, log } = start(abc);
    transport.emit({ ev: "ready" });
    await session.ready;
    transport.emit({ ev: "error", message: "cannot type key Pause" });
    transport.emit(press("azeron", "F13"));
    await clock.advance(100);
    expect(log).toContain("helper: cannot type key Pause");
    expect(transport.typed.length).toBeGreaterThan(0);
  });

  it("is over when the process says it has stopped", async () => {
    const { session, transport } = start(abc);
    transport.emit({ ev: "ready" });
    await session.ready;
    transport.emit({ ev: "stopped" });
    expect((await session.ended).reason).toBe("closed");
  });
});
