/**
 * The helper's bridge: what a Node process and the Windows process say to each other, and
 * the session that wires a `MacroRunner` to it. See docs/plans/macros.md.
 *
 * The Windows side is a thin I/O bridge and holds no macro logic: it reports the buttons
 * that start a macro and types the keys it is told to. Everything that decides what is
 * typed, and when, is the runner, here.
 *
 * Lines of JSON, one object per line:
 *
 *   Windows -> Node  {"ev":"ready"}
 *                    {"ev":"down"|"up","device":"azeron"|"keyboard"|"pad","input":"F13"}
 *                    {"ev":"error","message":"..."}
 *                    {"ev":"panic"}    the panic key was pressed; everything is released
 *                    {"ev":"stopped"}  the process is exiting
 *   Node -> Windows  {"cmd":"watch","triggers":[{"device":"azeron","input":"F13"}]}
 *                    {"cmd":"down"|"up","input":{"key":"KeyA"}|{"mouse":"left"}}
 *                    {"cmd":"stop"}
 *
 * Node-free: the transport is an interface, the clock is injected.
 */

import { MACRO_LIMITS, TRIGGER_KEYS } from "./macros.js";
import type { CompiledMacros, MacroInput, MacroTrigger, TriggerDevice } from "./macros.js";
import { MacroRunner } from "./macrorun.js";
import type { MacroIo } from "./macrorun.js";
import { isReadable, isReadablePad, isTypeable } from "./helper-keys.js";

export type HelperEvent =
  | { ev: "ready" }
  | { ev: "down" | "up"; device: TriggerDevice; input: string }
  | { ev: "error"; message: string }
  | { ev: "panic" }
  | { ev: "stopped" };

export type HelperCommand =
  | { cmd: "watch"; triggers: MacroTrigger[] }
  | { cmd: "down" | "up"; input: MacroInput }
  | { cmd: "stop" };

const DEVICES: readonly string[] = ["azeron", "keyboard", "pad"];

/** One command as the line the Windows process reads. */
export function encodeCommand(command: HelperCommand): string {
  return `${JSON.stringify(command)}\n`;
}

/** What a line from the Windows process is: an event, or text that is not one. */
export type Decoded = { kind: "event"; event: HelperEvent } | { kind: "text"; text: string };

/**
 * One line from the Windows process. PowerShell prints other things on stdout (a banner, a
 * warning) and a line may carry a byte-order mark, so anything that is not an event is
 * returned as text for the caller to log. Never throws.
 */
export function decodeEvent(line: string): Decoded {
  const text = line.replace(String.fromCharCode(0xfeff), "").trim();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "text", text };
  }
  if (typeof value !== "object" || value === null) return { kind: "text", text };
  const record = value as Record<string, unknown>;
  switch (record.ev) {
    case "ready":
    case "panic":
    case "stopped":
      return { kind: "event", event: { ev: record.ev } };
    case "error":
      return {
        kind: "event",
        event: {
          ev: "error",
          message: typeof record.message === "string" ? record.message : "unknown error",
        },
      };
    case "down":
    case "up":
      if (
        typeof record.device === "string" &&
        DEVICES.includes(record.device) &&
        typeof record.input === "string" &&
        record.input !== ""
      ) {
        return {
          kind: "event",
          event: { ev: record.ev, device: record.device as TriggerDevice, input: record.input },
        };
      }
      return { kind: "text", text };
    default:
      return { kind: "text", text };
  }
}

/** Splits a stream of text into lines, whatever the chunks and the line endings. */
export class LineDecoder {
  private pending = "";

  push(chunk: string): string[] {
    this.pending += chunk;
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    return lines.filter((line) => line.trim() !== "");
  }

  /** What is left when the stream ends without a final newline. */
  flush(): string[] {
    const rest = this.pending.trim();
    this.pending = "";
    return rest === "" ? [] : [rest];
  }
}

/** What the Windows process is, as far as the session is concerned. */
export interface HelperTransport {
  /** Send a command. May throw when the process is gone: the session treats that as closed. */
  send(command: HelperCommand): void;
  onEvent(listener: (event: HelperEvent) => void): void;
  /** Called once, when the process has gone. */
  onClose(listener: (reason: string) => void): void;
  /** Ask it to go: it releases every key and exits. */
  close(): void;
}

/** Time, injected so a test never waits. `sleep` ends early when `signal` aborts. */
export interface HelperClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: HelperClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
    }),
};

/**
 * Whether a program can be typed, before anything is started: the version, the limits, and
 * every key and button named, so a refusal names the key rather than failing in the middle
 * of a macro.
 */
export function validateProgram(program: CompiledMacros): string[] {
  const problems: string[] = [];
  if ((program.version as number) !== 2) {
    problems.push(`macros.json is version ${String(program.version)}; this helper reads 2`);
    return problems;
  }
  for (const macro of program.macros) {
    const at = `'${macro.action}'`;
    if (macro.ops.length > MACRO_LIMITS.ops) {
      problems.push(
        `${at} has ${String(macro.ops.length)} operations; the most is ${String(MACRO_LIMITS.ops)}`,
      );
    }
    for (const op of macro.ops) {
      if (op.op === "wait") {
        if (op.ms > MACRO_LIMITS.waitMs) problems.push(`${at} waits ${String(op.ms)} ms`);
      } else if ("key" in op.input) {
        if (!isTypeable(op.input.key)) {
          problems.push(`${at} types ${op.input.key}, which the helper cannot type`);
        }
      } else if (!["left", "middle", "right"].includes(op.input.mouse)) {
        problems.push(
          `${at} types mouse ${op.input.mouse as string}, which the helper cannot type`,
        );
      }
    }
    for (const trigger of macro.on) {
      if (trigger.device === "azeron") {
        if (!TRIGGER_KEYS.includes(trigger.input)) {
          problems.push(`${at} is started by ${trigger.input}, which is not an F13-F24 key`);
        }
      } else if (trigger.device === "keyboard") {
        if (!isReadable(trigger.input)) {
          problems.push(`${at} is started by ${trigger.input}, which the helper cannot read`);
        }
      } else if (!isReadablePad(trigger.input)) {
        problems.push(`${at} is started by ${trigger.input}, which the helper cannot read`);
      }
    }
  }
  return problems;
}

/** Why a session ended. */
export interface SessionEnd {
  reason: "stopped" | "panic" | "closed" | "runaway" | "error";
  message?: string;
}

export interface SessionOptions {
  clock: HelperClock;
  /** Something to say: a macro that ran, a stray line, an error. */
  log?: (line: string) => void;
  /** Each press of a trigger that starts a macro, for someone testing by hand. */
  trace?: (line: string) => void;
  /**
   * The runaway guard: more key-downs than this in one second end the session. A macro never
   * types more than its compiled operations, so this only trips on a fault.
   */
  maxDownsPerSecond?: number;
}

/** The most key-downs a second a session allows by default. */
export const MAX_DOWNS_PER_SECOND = 1000;

type State = "waiting" | "running" | "ending" | "ended";

/**
 * A running helper: the Windows process behind a transport, and the runner that decides
 * what it types. Events from the process start and release macros; the runner's keys go out
 * as commands.
 */
export class HelperSession {
  /** Resolves when the process is ready and has been told what to watch for. */
  readonly ready: Promise<void>;
  /** Resolves when the session is over, after every key is released. */
  readonly ended: Promise<SessionEnd>;

  private readonly runner: MacroRunner;
  private readonly held = new Set<string>();
  private readonly downs: number[] = [];
  private readonly aborter = new AbortController();
  private readonly log: (line: string) => void;
  private readonly maxDowns: number;
  private state: State = "waiting";
  private dead = false;
  private resolveReady: () => void = () => undefined;
  private rejectReady: (error: Error) => void = () => undefined;
  private resolveEnded: (end: SessionEnd) => void = () => undefined;
  private finishing: Promise<void> | null = null;

  constructor(
    program: CompiledMacros,
    private readonly transport: HelperTransport,
    private readonly options: SessionOptions,
  ) {
    this.log = options.log ?? (() => undefined);
    this.maxDowns = options.maxDownsPerSecond ?? MAX_DOWNS_PER_SECOND;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A session that ends before it is ready rejects `ready`; nobody awaiting it is not an error.
    this.ready.catch(() => undefined);
    this.ended = new Promise<SessionEnd>((resolve) => {
      this.resolveEnded = resolve;
    });
    this.runner = new MacroRunner(program, this.io());
    transport.onEvent((event) => {
      this.handle(event);
    });
    transport.onClose((reason) => {
      this.dead = true;
      void this.finish({ reason: "closed", message: reason });
    });
  }

  /** The buttons that start a macro of the program. */
  triggers(): MacroTrigger[] {
    return this.runner.triggers();
  }

  /** End the session: stop every macro, release every key, and ask the process to exit. */
  stop(): Promise<void> {
    return this.finish({ reason: "stopped" });
  }

  private io(): MacroIo {
    return {
      down: (input) => {
        if (this.state !== "running" || this.dead || !this.allowDown()) return;
        this.send({ cmd: "down", input });
      },
      // A release always goes, even while ending: that is what the end is for.
      up: (input) => {
        this.send({ cmd: "up", input });
      },
      sleep: (ms) => this.options.clock.sleep(ms, this.aborter.signal),
    };
  }

  private send(command: HelperCommand): void {
    if (this.dead) return;
    try {
      this.transport.send(command);
    } catch (error) {
      this.dead = true;
      this.log(
        `helper: could not send to the process: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Counts a key-down, and ends the session when there are too many. */
  private allowDown(): boolean {
    const now = this.options.clock.now();
    this.downs.push(now);
    while (this.downs.length > 0 && now - (this.downs[0] ?? now) >= 1000) this.downs.shift();
    if (this.downs.length <= this.maxDowns) return true;
    void this.finish({
      reason: "runaway",
      message: `more than ${String(this.maxDowns)} key presses in a second`,
    });
    return false;
  }

  private handle(event: HelperEvent): void {
    switch (event.ev) {
      case "ready":
        if (this.state !== "waiting") return;
        this.state = "running";
        this.send({ cmd: "watch", triggers: this.runner.triggers() });
        this.resolveReady();
        return;
      case "down":
      case "up": {
        if (this.state !== "running") return;
        if (!this.runner.isTrigger(event.device, event.input)) {
          this.log(`helper: ${event.device} ${event.input} is not a trigger of this game`);
          return;
        }
        const name = `${event.device}:${event.input}`;
        if (event.ev === "down") {
          // A held key repeats its down; a macro runs once per press, so the repeats are not presses.
          if (this.held.has(name)) return;
          this.held.add(name);
          this.options.trace?.(`${event.device} ${event.input}`);
          this.runner.press(event.device, event.input);
        } else {
          this.held.delete(name);
          this.runner.release(event.device, event.input);
        }
        return;
      }
      case "error":
        this.log(`helper: ${event.message}`);
        if (this.state === "waiting") void this.finish({ reason: "error", message: event.message });
        return;
      case "panic":
        this.log("helper: panic key, everything released");
        this.dead = true;
        void this.finish({ reason: "panic" });
        return;
      case "stopped":
        this.dead = true;
        void this.finish(
          this.state === "ending"
            ? { reason: "stopped" }
            : { reason: "closed", message: "the helper exited" },
        );
        return;
    }
  }

  private finish(end: SessionEnd): Promise<void> {
    if (this.finishing !== null) return this.finishing;
    this.state = "ending";
    this.finishing = (async () => {
      // Sleeps end now, so no macro waits out a ten-second pause before its keys are lifted.
      this.aborter.abort();
      await this.runner.stopAll();
      if (!this.dead && end.reason !== "closed") this.send({ cmd: "stop" });
      try {
        this.transport.close();
      } catch {
        // Already gone.
      }
      this.state = "ended";
      this.rejectReady(new Error(end.message ?? `the helper ended (${end.reason})`));
      this.resolveEnded(end);
    })();
    return this.finishing;
  }
}
