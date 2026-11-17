/**
 * Macros: press one button, and the game receives a sequence of keys. See
 * docs/plans/macros.md.
 *
 * A macro is an action of the game, and what starts it is any of three buttons: the keypad
 * control it is placed on (which sends a trigger key, F13-F24), a keyboard key (`kbm`), or a
 * controller button (`pad`). What the game receives is its list of keys, in macros.yaml.
 * This module reads that list, turns it into concrete down / up / wait operations, and
 * compiles the lot into what the helper runs.
 *
 * Node-free, because the editor imports it.
 */

import type { ActionSpec } from "../types/profile.js";
import { isPadControl, parseKbm } from "./controls.js";
import { isModifier } from "./keys.js";

/** Limits, so a typo cannot lock the keyboard. */
export const MACRO_LIMITS = {
  steps: 64,
  waitMs: 10_000,
  holdMs: 5_000,
  ops: 512,
} as const;

/** How long a key is held down, and the pause before the next key, unless a macro says. */
export const DEFAULT_HOLD_MS = 30;
export const DEFAULT_GAP_MS = 30;

/** A repeating macro must wait at least this long in all, or it would spin. */
export const MIN_REPEAT_WAIT_MS = 10;

/** The keys a keypad's trigger may be: on no keyboard sold, so no game binds them. */
export const TRIGGER_KEYS: readonly string[] = [
  "F13",
  "F14",
  "F15",
  "F16",
  "F17",
  "F18",
  "F19",
  "F20",
  "F21",
  "F22",
  "F23",
  "F24",
];

/** A key or mouse button the helper can type. */
export type MacroInput = { key: string } | { mouse: "left" | "middle" | "right" };

export type MacroOp = { op: "down" | "up"; input: MacroInput } | { op: "wait"; ms: number };

/** What a step points at: a binding (`KeyH`, `ControlLeft+KeyR`) or an action of the game. */
export type MacroTarget = string | { action: string };

/** One step, as read. Exactly one of tap, down, up and wait. */
export interface MacroStep {
  tap?: MacroTarget;
  /** How long this tap holds the key down, in ms. */
  hold?: number;
  down?: MacroTarget;
  up?: MacroTarget;
  /** Milliseconds to wait. */
  wait?: number;
}

export interface MacroDef {
  /** Run again for as long as the button is held. */
  repeat?: boolean;
  /** How long each tap holds its key, and the pause between taps. */
  hold?: number;
  gap?: number;
  steps: MacroStep[];
}

export interface MacrosData {
  macros: Record<string, MacroDef>;
}

export class MacroError extends Error {}

const MOUSE: Readonly<Record<string, "left" | "middle" | "right">> = {
  MouseLeft: "left",
  MouseMiddle: "middle",
  MouseRight: "right",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTarget(value: unknown, where: string): MacroTarget {
  if (typeof value === "string" && value !== "") return value;
  if (isObject(value) && typeof value.action === "string" && Object.keys(value).length === 1) {
    return { action: value.action };
  }
  throw new MacroError(`${where}: a key like KeyH, or {action: id}`);
}

function wholeMs(value: unknown, field: string, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new MacroError(`${where}: ${field} is whole milliseconds`);
  }
  return value;
}

/**
 * One step. A bare key (`KeyA`) or `{action: id}` is a tap, so a macro can be written as the
 * list of keys the game should get.
 */
function parseStep(value: unknown, where: string): MacroStep {
  if (typeof value === "string") return { tap: parseTarget(value, where) };
  if (!isObject(value)) throw new MacroError(`${where}: a key, or a mapping`);
  if (Object.keys(value).length === 1 && "action" in value) {
    return { tap: parseTarget(value, where) };
  }
  const fields = ["tap", "down", "up", "wait"].filter((field) => field in value);
  if (fields.length !== 1) {
    throw new MacroError(`${where}: exactly one of tap, down, up, wait`);
  }
  const extra = Object.keys(value).filter(
    (key) => !fields.includes(key) && !(key === "hold" && fields[0] === "tap"),
  );
  if (extra.length > 0) {
    throw new MacroError(`${where}: '${extra.join("', '")}' is not allowed here`);
  }
  const step: MacroStep = {};
  if ("tap" in value) {
    step.tap = parseTarget(value.tap, where);
    if ("hold" in value) step.hold = wholeMs(value.hold, "hold", where);
  }
  if ("down" in value) step.down = parseTarget(value.down, where);
  if ("up" in value) step.up = parseTarget(value.up, where);
  if ("wait" in value) step.wait = wholeMs(value.wait, "wait", where);
  return step;
}

/**
 * `macros.yaml` as data. A macro is a list of keys, or a mapping with `steps` and the
 * settings `repeat`, `hold` and `gap`. A file that is not that shape throws.
 */
export function parseMacros(data: unknown, where: string): MacrosData {
  if (data === null || data === undefined) return { macros: {} };
  if (!isObject(data)) throw new MacroError(`${where} must be a mapping`);
  const section = data.macros;
  if (section === undefined || section === null) return { macros: {} };
  if (!isObject(section)) throw new MacroError(`${where}: macros must be a mapping`);
  const macros: Record<string, MacroDef> = {};
  for (const [id, entry] of Object.entries(section)) {
    const here = `${where}: macros.${id}`;
    const parseSteps = (list: unknown): MacroStep[] => {
      if (!Array.isArray(list)) throw new MacroError(`${here} must be a list of keys`);
      return list.map((step, index) => parseStep(step, `${here}[${String(index + 1)}]`));
    };
    if (Array.isArray(entry)) {
      macros[id] = { steps: parseSteps(entry) };
      continue;
    }
    if (!isObject(entry)) throw new MacroError(`${here} must be a list of keys or a mapping`);
    const unknown = Object.keys(entry).filter(
      (key) => !["steps", "repeat", "hold", "gap"].includes(key),
    );
    if (unknown.length > 0) {
      throw new MacroError(`${here}: '${unknown.join("', '")}' is not a setting`);
    }
    if (entry.repeat !== undefined && typeof entry.repeat !== "boolean") {
      throw new MacroError(`${here}.repeat must be true or false`);
    }
    macros[id] = {
      ...(entry.repeat === undefined ? {} : { repeat: entry.repeat }),
      ...(entry.hold === undefined ? {} : { hold: wholeMs(entry.hold, "hold", here) }),
      ...(entry.gap === undefined ? {} : { gap: wholeMs(entry.gap, "gap", here) }),
      steps: parseSteps(entry.steps),
    };
  }
  return { macros };
}

/** The resolved form of one macro, or what stopped it resolving. */
export interface ResolvedMacro {
  ops: MacroOp[];
  problems: string[];
}

interface Chord {
  modifiers: MacroInput[];
  input: MacroInput;
}

/** A binding as inputs the helper can type, or the reason it cannot. */
function chordOf(
  target: MacroTarget,
  actions: Readonly<Record<string, ActionSpec>>,
): Chord | string {
  let token: unknown;
  let name: string;
  if (typeof target === "string") {
    token = target;
    name = `'${target}'`;
  } else {
    const spec = actions[target.action];
    if (spec === undefined) return `no action '${target.action}'`;
    name = `'${target.action}'`;
    if (spec.kbm === undefined) return `${name} has no keyboard key (kbm) in this game`;
    token = spec.kbm;
  }
  const parsed = parseKbm(token);
  if (parsed === null) return `${name} is not a key or mouse button`;
  let input: MacroInput;
  if (parsed.input in MOUSE) input = { mouse: MOUSE[parsed.input] ?? "left" };
  else if (/^(Mouse|Wheel)/.test(parsed.input)) {
    return `${name}: the wheel and the side buttons cannot be typed`;
  } else input = { key: parsed.input };
  return { modifiers: parsed.modifiers.map((value) => ({ key: value })), input };
}

/** Turn one macro's steps into operations, and say what is wrong with it. */
export function resolveMacro(
  def: MacroDef,
  actions: Readonly<Record<string, ActionSpec>>,
): ResolvedMacro {
  const ops: MacroOp[] = [];
  const problems: string[] = [];
  if (def.steps.length === 0) problems.push("has no steps");
  if (def.steps.length > MACRO_LIMITS.steps) {
    problems.push(
      `has ${String(def.steps.length)} steps; the most is ${String(MACRO_LIMITS.steps)}`,
    );
  }
  const holdDefault = def.hold ?? DEFAULT_HOLD_MS;
  const gap = def.gap ?? DEFAULT_GAP_MS;
  if (holdDefault > MACRO_LIMITS.holdMs) {
    problems.push(`hold is over ${String(MACRO_LIMITS.holdMs)} ms`);
  }
  if (gap > MACRO_LIMITS.waitMs) problems.push(`gap is over ${String(MACRO_LIMITS.waitMs)} ms`);
  let waited = 0;
  // What an explicit `down` step is holding, so a tap that shares a key with it leaves that
  // key as it is: lifting a held Shift at the end of a Shift+A tap would type the next key bare.
  const held = new Set<string>();
  const inputName = (input: MacroInput): string =>
    "key" in input ? `key:${input.key}` : `mouse:${input.mouse}`;
  def.steps.forEach((step, index) => {
    const at = `step ${String(index + 1)}`;
    if (step.wait !== undefined) {
      if (step.wait > MACRO_LIMITS.waitMs) {
        problems.push(`${at}: wait is over ${String(MACRO_LIMITS.waitMs)} ms`);
        return;
      }
      waited += step.wait;
      ops.push({ op: "wait", ms: step.wait });
      return;
    }
    const target = step.tap ?? step.down ?? step.up;
    if (target === undefined) {
      problems.push(`${at}: nothing to do`);
      return;
    }
    const chord = chordOf(target, actions);
    if (typeof chord === "string") {
      problems.push(`${at}: ${chord}`);
      return;
    }
    const pressed = [...chord.modifiers, chord.input];
    const downs: MacroOp[] = pressed.map((input) => ({ op: "down", input }));
    const ups: MacroOp[] = [...pressed].reverse().map((input) => ({ op: "up", input }));
    if (step.tap === undefined) {
      for (const input of pressed) {
        if (step.down === undefined) held.delete(inputName(input));
        else held.add(inputName(input));
      }
      ops.push(...(step.down === undefined ? ups : downs));
      return;
    }
    // A tap presses and lifts only what is not already held.
    const free = pressed.filter((input) => !held.has(inputName(input)));
    const tapDowns: MacroOp[] = free.map((input) => ({ op: "down", input }));
    const tapUps: MacroOp[] = [...free].reverse().map((input) => ({ op: "up", input }));
    const hold = step.hold ?? holdDefault;
    if (step.hold !== undefined && hold > MACRO_LIMITS.holdMs) {
      problems.push(`${at}: hold is over ${String(MACRO_LIMITS.holdMs)} ms`);
      return;
    }
    waited += hold;
    ops.push(...tapDowns, { op: "wait", ms: hold }, ...tapUps);
    // A pause before the next key, when the next step is a key too: the game reads each. A
    // repeating macro's last step is followed by its first, so a pass ends with the pause too.
    const next = def.steps[index + 1] ?? (def.repeat === true ? def.steps[0] : undefined);
    if (next?.tap !== undefined && gap > 0) {
      waited += gap;
      ops.push({ op: "wait", ms: gap });
    }
  });
  if (ops.length > MACRO_LIMITS.ops) {
    problems.push(
      `is ${String(ops.length)} operations long; the most is ${String(MACRO_LIMITS.ops)}`,
    );
  }
  if (def.repeat === true && waited < MIN_REPEAT_WAIT_MS) {
    problems.push(`repeats, so it must wait at least ${String(MIN_REPEAT_WAIT_MS)} ms in all`);
  }
  return { ops, problems };
}

/**
 * The macros whose steps type an action by name (`tap`, `down` or `up` of `{action: id}`),
 * by id. Deleting that action would leave each of them pointing at nothing.
 */
export function macrosTyping(data: MacrosData, id: string): string[] {
  return Object.entries(data.macros)
    .filter(([, def]) =>
      def.steps.some((step) =>
        [step.tap, step.down, step.up].some(
          (target) => typeof target === "object" && target.action === id,
        ),
      ),
    )
    .map(([name]) => name);
}

/** Which kind of button starts a macro. */
export type TriggerDevice = "azeron" | "keyboard" | "pad";

export interface MacroTrigger {
  device: TriggerDevice;
  /** The key sent, the key pressed, or the pad control. */
  input: string;
}

/** A pad control that is a button or a trigger, not a stick direction. */
export function isPadButton(control: unknown): boolean {
  return isPadControl(control) && !/Stick(Up|Down|Left|Right)$/.test(String(control));
}

/**
 * The buttons that start an action's macro, and what is wrong with them. An action needs at
 * least one: a keypad key (`key`, F13-F24), a keyboard key (`kbm`, one plain key) or a pad
 * button (`pad`).
 */
export function triggersOf(spec: ActionSpec | undefined): {
  triggers: MacroTrigger[];
  problems: string[];
} {
  const triggers: MacroTrigger[] = [];
  const problems: string[] = [];
  if (spec === undefined) return { triggers, problems: ["is not an action of this game"] };
  if (spec.key !== undefined && spec.key !== null) {
    if (spec.meta !== undefined && spec.meta !== null) {
      problems.push("keypad key is sent with a modifier");
    } else if (!TRIGGER_KEYS.includes(spec.key)) {
      problems.push(`keypad key ${spec.key} is not an F13-F24 key`);
    } else triggers.push({ device: "azeron", input: spec.key });
  }
  if (spec.kbm !== undefined) {
    const parsed = parseKbm(spec.kbm);
    if (
      parsed === null ||
      parsed.modifiers.length > 0 ||
      /^(Mouse|Wheel)/.test(parsed.input) ||
      isModifier(parsed.input)
    ) {
      problems.push(`keyboard key ${spec.kbm} must be one plain key`);
    } else triggers.push({ device: "keyboard", input: parsed.input });
  }
  if (spec.pad !== undefined) {
    if (!isPadButton(spec.pad)) problems.push(`controller control ${spec.pad} is not a button`);
    else triggers.push({ device: "pad", input: spec.pad });
  }
  if (triggers.length === 0 && problems.length === 0) {
    problems.push("has no button: give it a keypad key, a keyboard key or a controller button");
  }
  return { triggers, problems };
}

/**
 * Where a button comes from. A keypad's trigger key and a keyboard key are the same physical
 * key to the helper's hook, which cannot tell them apart, so they share one name: F13 on the
 * keypad and F13 on the keyboard collide. A pad button is its own.
 */
function sourceOf(trigger: MacroTrigger): string {
  return trigger.device === "pad" ? `pad:${trigger.input}` : `key:${trigger.input}`;
}

/** One macro as the helper runs it. */
export interface CompiledMacro {
  action: string;
  label: string;
  repeat: boolean;
  /** Any of these starts it. */
  on: MacroTrigger[];
  ops: MacroOp[];
}

/** What `dist/<game>/macros.json` holds. */
export interface CompiledMacros {
  version: 2;
  macros: CompiledMacro[];
}

export interface MacroProblem {
  macro: string;
  /** The check this is: the buttons, or the macro itself. */
  rule: "macro-trigger" | "macro-invalid";
  message: string;
}

/**
 * Every macro of a game compiled, by action id, with every problem found. A macro with a
 * problem is left out of the program.
 */
export function compileMacros(
  data: MacrosData,
  actions: Readonly<Record<string, ActionSpec>>,
): { program: CompiledMacros; problems: MacroProblem[] } {
  const problems: MacroProblem[] = [];
  const found: CompiledMacro[] = [];
  const owners = new Map<string, string>();
  for (const [id, def] of Object.entries(data.macros)) {
    const spec = actions[id];
    const { triggers, problems: triggerProblems } = triggersOf(spec);
    for (const message of triggerProblems) {
      problems.push({ macro: id, rule: "macro-trigger", message });
    }
    const resolved = resolveMacro(def, actions);
    for (const message of resolved.problems) {
      problems.push({ macro: id, rule: "macro-invalid", message });
    }
    if (triggerProblems.length > 0 || resolved.problems.length > 0) continue;
    let clash = false;
    for (const trigger of triggers) {
      const other = owners.get(sourceOf(trigger));
      if (other !== undefined) {
        problems.push({
          macro: id,
          rule: "macro-trigger",
          message: `${trigger.input} also starts '${other}'`,
        });
        clash = true;
      }
    }
    if (clash) continue;
    for (const trigger of triggers) owners.set(sourceOf(trigger), id);
    found.push({
      action: id,
      label: spec?.label ?? id,
      repeat: def.repeat === true,
      on: triggers,
      ops: resolved.ops,
    });
  }
  found.sort((a, b) => a.action.localeCompare(b.action));
  return { program: { version: 2, macros: found }, problems };
}

/** The file `dist/<game>/macros.json` holds, one spelling. */
export function dumpMacros(program: CompiledMacros): string {
  return `${JSON.stringify(program, null, 2)}\n`;
}
