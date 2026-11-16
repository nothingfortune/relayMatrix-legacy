/**
 * The macro runner, against a fake keyboard and a fake clock: what is typed, in what order,
 * and that nothing is ever left pressed.
 */

import { describe, expect, it } from "vitest";

import type {
  CompiledMacros,
  MacroInput,
  MacroOp,
  TriggerDevice,
} from "../../../src/lib/macros.js";
import { MacroRunner } from "../../../src/lib/macrorun.js";
import type { MacroIo } from "../../../src/lib/macrorun.js";

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

/** A keyboard that logs, and a clock that only advances when it is asked to sleep. */
function fake(onSleep?: (ms: number, log: string[]) => void): { io: MacroIo; log: string[] } {
  const log: string[] = [];
  const name = (input: MacroInput): string => ("key" in input ? input.key : `mouse ${input.mouse}`);
  return {
    log,
    io: {
      down: (input) => log.push(`down ${name(input)}`),
      up: (input) => log.push(`up ${name(input)}`),
      sleep: (ms) => {
        log.push(`wait ${String(ms)}`);
        onSleep?.(ms, log);
        return Promise.resolve();
      },
    },
  };
}

describe("MacroRunner", () => {
  it("types the operations in order, and knows its buttons", async () => {
    const { io, log } = fake();
    const runner = new MacroRunner(
      program({
        abc: {
          on: [
            ["azeron", "F13"],
            ["keyboard", "KeyM"],
            ["pad", "RB"],
          ],
          ops: [...tap("KeyA"), ...tap("KeyB", 5)],
        },
      }),
      io,
    );
    expect(runner.isTrigger("azeron", "F13")).toBe(true);
    expect(runner.isTrigger("keyboard", "KeyM")).toBe(true);
    expect(runner.isTrigger("pad", "RB")).toBe(true);
    expect(runner.isTrigger("azeron", "F14")).toBe(false);
    expect(runner.isTrigger("keyboard", "F13")).toBe(false);
    expect(runner.triggers()).toHaveLength(3);
    runner.press("azeron", "F13");
    await runner.idle();
    expect(log).toEqual(["down KeyA", "wait 10", "up KeyA", "down KeyB", "wait 5", "up KeyB"]);
  });

  it("starts the same macro from any of its buttons", async () => {
    const { io, log } = fake();
    const runner = new MacroRunner(
      program({
        abc: {
          on: [
            ["azeron", "F13"],
            ["keyboard", "KeyM"],
            ["pad", "RB"],
          ],
          ops: tap("KeyA"),
        },
      }),
      io,
    );
    for (const [device, input] of [
      ["azeron", "F13"],
      ["keyboard", "KeyM"],
      ["pad", "RB"],
    ] as const) {
      runner.press(device, input);
      await runner.idle();
    }
    expect(log.filter((line) => line === "down KeyA")).toHaveLength(3);
  });

  it("ignores a button that starts nothing", async () => {
    const { io, log } = fake();
    const runner = new MacroRunner(
      program({ abc: { on: [["azeron", "F13"]], ops: tap("KeyH") } }),
      io,
    );
    runner.press("azeron", "F20");
    runner.press("keyboard", "F13");
    await runner.idle();
    expect(log).toEqual([]);
  });

  it("runs once per press however long the button is held", async () => {
    const { io, log } = fake();
    const runner = new MacroRunner(
      program({ abc: { on: [["azeron", "F13"]], ops: tap("KeyH") } }),
      io,
    );
    runner.press("azeron", "F13");
    runner.press("azeron", "F13"); // key repeat while it runs
    runner.press("azeron", "F13");
    await runner.idle();
    expect(log.filter((line) => line === "down KeyH")).toHaveLength(1);
    runner.press("azeron", "F13"); // a new press, after it finished
    await runner.idle();
    expect(log.filter((line) => line === "down KeyH")).toHaveLength(2);
  });

  it("does not start a macro twice because two of its buttons are pressed", async () => {
    const { io, log } = fake();
    const runner = new MacroRunner(
      program({
        abc: {
          on: [
            ["azeron", "F13"],
            ["pad", "RB"],
          ],
          ops: tap("KeyH"),
        },
      }),
      io,
    );
    runner.press("azeron", "F13");
    runner.press("pad", "RB");
    await runner.idle();
    expect(log.filter((line) => line === "down KeyH")).toHaveLength(1);
  });

  it("repeats while the button is held, finishes the pass it is in, and stops on release", async () => {
    const { io, log } = fake((_ms, lines) => {
      if (lines.filter((line) => line === "wait 10").length === 3) {
        runner.release("keyboard", "KeyM");
      }
    });
    const runner = new MacroRunner(
      program({ abc: { on: [["keyboard", "KeyM"]], repeat: true, ops: tap("KeyH") } }),
      io,
    );
    runner.press("keyboard", "KeyM");
    await runner.idle();
    expect(log.filter((line) => line === "down KeyH")).toHaveLength(3);
    expect(log.filter((line) => line === "up KeyH")).toHaveLength(3);
  });

  it("keeps repeating when a different button is released", async () => {
    const { io, log } = fake((_ms, lines) => {
      const passes = lines.filter((line) => line === "wait 10").length;
      if (passes === 2) runner.release("pad", "RB"); // not the one that started it
      if (passes === 4) runner.release("azeron", "F13");
    });
    const runner = new MacroRunner(
      program({
        abc: {
          on: [
            ["azeron", "F13"],
            ["pad", "RB"],
          ],
          repeat: true,
          ops: tap("KeyH"),
        },
      }),
      io,
    );
    runner.press("azeron", "F13");
    await runner.idle();
    expect(log.filter((line) => line === "down KeyH")).toHaveLength(4);
  });

  it("does not repeat a macro that does not say so, though the button stays held", async () => {
    const { io, log } = fake();
    const runner = new MacroRunner(
      program({ abc: { on: [["azeron", "F13"]], ops: tap("KeyH") } }),
      io,
    );
    runner.press("azeron", "F13");
    await runner.idle();
    expect(log.filter((line) => line === "down KeyH")).toHaveLength(1);
  });

  it("lifts what a macro left pressed when it ends", async () => {
    const { io, log } = fake();
    const ops: MacroOp[] = [
      { op: "down", input: key("ShiftLeft") },
      { op: "down", input: { mouse: "left" } },
      { op: "wait", ms: 10 },
    ];
    const runner = new MacroRunner(program({ abc: { on: [["azeron", "F13"]], ops } }), io);
    runner.press("azeron", "F13");
    await runner.idle();
    expect(log).toEqual([
      "down ShiftLeft",
      "down mouse left",
      "wait 10",
      "up mouse left",
      "up ShiftLeft",
    ]);
  });

  it("stops everything at once, lifts every key, and waits for it", async () => {
    const { io, log } = fake((ms) => {
      if (ms === 100) void runner.stopAll();
    });
    const ops: MacroOp[] = [
      { op: "down", input: key("KeyW") },
      { op: "wait", ms: 100 },
      { op: "down", input: key("KeyA") },
      { op: "wait", ms: 100 },
    ];
    const runner = new MacroRunner(program({ abc: { on: [["azeron", "F13"]], ops } }), io);
    runner.press("azeron", "F13");
    await runner.idle();
    // Stopped at the first wait: the second key never went down, and the first was lifted.
    expect(log).toEqual(["down KeyW", "wait 100", "up KeyW"]);
  });

  it("runs different macros side by side", async () => {
    const { io, log } = fake();
    const runner = new MacroRunner(
      program({
        a: { on: [["azeron", "F13"]], ops: tap("KeyA") },
        b: { on: [["azeron", "F14"]], ops: tap("KeyB") },
      }),
      io,
    );
    runner.press("azeron", "F13");
    runner.press("azeron", "F14");
    await runner.idle();
    expect(log).toContain("down KeyA");
    expect(log).toContain("down KeyB");
  });
});
