/**
 * Running compiled macros. The runner decides what is typed and when; something else (the
 * helper's Windows process, or a fake in tests) does the typing, behind `MacroIo`.
 *
 * What it guarantees, so a macro cannot leave the keyboard stuck or run away:
 * - a macro runs once per press, however long the button is held, unless it repeats;
 * - a repeating macro runs again while the button is held, and stops cleanly on release;
 * - when a run ends, for any reason, every key it put down is lifted;
 * - a key two macros both hold goes down once and comes up when the last lets go, and a run
 *   never lifts a key it did not press.
 *
 * Node-free.
 */

import type {
  CompiledMacro,
  CompiledMacros,
  MacroInput,
  MacroTrigger,
  TriggerDevice,
} from "./macros.js";

/** What the helper does to the machine. */
export interface MacroIo {
  down(input: MacroInput): void;
  up(input: MacroInput): void;
  sleep(ms: number): Promise<void>;
}

const nameOf = (input: MacroInput): string =>
  "key" in input ? `key:${input.key}` : `mouse:${input.mouse}`;

const triggerName = (device: TriggerDevice, input: string): string => `${device}:${input}`;

interface Run {
  /** The button that started it. */
  by: string;
  held: boolean;
  stopped: boolean;
  done: Promise<void>;
}

export class MacroRunner {
  private readonly byTrigger = new Map<string, CompiledMacro>();
  private readonly running = new Map<string, Run>();
  /** How many runs hold each key, so one macro cannot lift a key another still needs. */
  private readonly holders = new Map<string, number>();

  constructor(
    program: CompiledMacros,
    private readonly io: MacroIo,
  ) {
    for (const macro of program.macros) {
      for (const trigger of macro.on)
        this.byTrigger.set(triggerName(trigger.device, trigger.input), macro);
    }
  }

  /** Whether this button starts a macro of the game. */
  isTrigger(device: TriggerDevice, input: string): boolean {
    return this.byTrigger.has(triggerName(device, input));
  }

  /** Every button that starts a macro, for a helper that has to watch for them. */
  triggers(): MacroTrigger[] {
    return [...new Set([...this.byTrigger.values()].flatMap((macro) => macro.on))];
  }

  /** The button went down. A press while its macro is already running does nothing. */
  press(device: TriggerDevice, input: string): void {
    const by = triggerName(device, input);
    const macro = this.byTrigger.get(by);
    if (macro === undefined || this.running.has(macro.action)) return;
    const run: Run = { by, held: true, stopped: false, done: Promise.resolve() };
    this.running.set(macro.action, run);
    run.done = this.run(macro, run).finally(() => {
      this.running.delete(macro.action);
    });
  }

  /** The button came up: a repeating macro finishes its pass and stops. */
  release(device: TriggerDevice, input: string): void {
    const by = triggerName(device, input);
    const macro = this.byTrigger.get(by);
    const run = macro === undefined ? undefined : this.running.get(macro.action);
    if (run?.by === by) run.held = false;
  }

  /** Stop every macro now, lift every key, and wait for them to finish. */
  async stopAll(): Promise<void> {
    const runs = [...this.running.values()];
    for (const run of runs) run.stopped = true;
    await Promise.all(runs.map((run) => run.done));
  }

  /** Resolves when nothing is running. */
  async idle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running.values()].map((run) => run.done));
    }
  }

  private async run(macro: CompiledMacro, run: Run): Promise<void> {
    const down = new Map<string, MacroInput>();
    try {
      do {
        for (const op of macro.ops) {
          if (run.stopped) return;
          if (op.op === "wait") {
            await this.io.sleep(op.ms);
          } else if (op.op === "down") {
            if (!down.has(nameOf(op.input))) {
              down.set(nameOf(op.input), op.input);
              this.holdKey(op.input);
            }
          } else if (down.delete(nameOf(op.input))) {
            this.liftKey(op.input);
          }
        }
      } while (macro.repeat && run.held && !run.stopped);
    } finally {
      // Whatever ended the run, nothing it pressed stays pressed.
      for (const input of [...down.values()].reverse()) this.liftKey(input);
    }
  }

  /** This run takes hold of a key: it goes down only if no other run already holds it. */
  private holdKey(input: MacroInput): void {
    const name = nameOf(input);
    const count = this.holders.get(name) ?? 0;
    this.holders.set(name, count + 1);
    if (count === 0) this.io.down(input);
  }

  /** This run lets go of a key: it comes up only when no other run still holds it. */
  private liftKey(input: MacroInput): void {
    const name = nameOf(input);
    const count = (this.holders.get(name) ?? 0) - 1;
    if (count > 0) {
      this.holders.set(name, count);
      return;
    }
    this.holders.delete(name);
    this.io.up(input);
  }
}
