/**
 * What the Macros panel does, apart from drawing it: the key list as text and back, which
 * macros differ from the file, and adding or taking out a macro and its action. Plain data
 * in and out, so the rules are tested without a page.
 */

import { patchMacro } from "../lib/macros-file.js";
import { resolveMacro } from "../lib/macros.js";
import type { MacroDef, MacroStep, MacroTarget } from "../lib/macros.js";
import { removeKey } from "../lib/object.js";
import { wireTrigger } from "../lib/wiring.js";
import type { ActionSpec } from "../types/profile.js";

/** A key as a person types it, as the code the game's file and the helper use. */
export function keyFromWord(word: string): string {
  if (/^[A-Za-z]$/.test(word)) return `Key${word.toUpperCase()}`;
  if (/^\d$/.test(word)) return `Digit${word}`;
  return word;
}

/** The short way to say a key: `KeyA` is A, `Digit1` is 1, anything else as it is. */
export function wordFromKey(code: string): string {
  return /^Key([A-Z])$/.exec(code)?.[1] ?? /^Digit(\d)$/.exec(code)?.[1] ?? code;
}

function targetFrom(word: string): MacroTarget | null {
  if (word.startsWith("@")) return /^@\w+$/.test(word) ? { action: word.slice(1) } : null;
  if (word === "" || word.includes(":")) return null;
  const parts = word.split("+");
  return parts.some((part) => part === "") ? null : parts.map(keyFromWord).join("+");
}

const targetWord = (target: MacroTarget): string =>
  typeof target === "string" ? target.split("+").map(wordFromKey).join("+") : `@${target.action}`;

/**
 * The key list as typed: words separated by spaces or commas. `A` is KeyA and `1` is Digit1;
 * `ControlLeft+R` holds a modifier; `KeyA:100` holds a tap 100 ms; `down:ShiftLeft`,
 * `up:ShiftLeft` and `wait:50` are the other steps; `@reload` is the key the game has
 * reload on.
 */
export function stepsFromText(text: string): { steps: MacroStep[] } | { error: string } {
  const steps: MacroStep[] = [];
  for (const word of text.split(/[\s,]+/)) {
    if (word === "") continue;
    const bad = { error: `Not a key: ${word}` };
    const prefixed = /^(down|up|wait):(.*)$/.exec(word);
    if (prefixed !== null) {
      const [, kind, rest = ""] = prefixed;
      if (kind === "wait") {
        if (!/^\d+$/.test(rest)) return { error: `Wait is whole ms: ${word}` };
        steps.push({ wait: Number(rest) });
        continue;
      }
      const target = targetFrom(rest);
      if (target === null) return bad;
      steps.push(kind === "down" ? { down: target } : { up: target });
      continue;
    }
    const held = /^(.+):(\d+)$/.exec(word);
    const target = targetFrom(held?.[1] ?? word);
    if (target === null) return bad;
    steps.push(held === null ? { tap: target } : { tap: target, hold: Number(held[2]) });
  }
  return { steps };
}

/** The key list as it is shown, so what was typed reads back the way it was typed. */
export function textFromSteps(steps: readonly MacroStep[]): string {
  return steps
    .map((step) => {
      if (step.wait !== undefined) return `wait:${String(step.wait)}`;
      if (step.down !== undefined) return `down:${targetWord(step.down)}`;
      if (step.up !== undefined) return `up:${targetWord(step.up)}`;
      if (step.tap === undefined) return "";
      return step.hold === undefined
        ? targetWord(step.tap)
        : `${targetWord(step.tap)}:${String(step.hold)}`;
    })
    .filter((word) => word !== "")
    .join(" ");
}

/** A macro with its fields in one order, so two that say the same thing compare equal. */
export function canonicalMacro(def: MacroDef): MacroDef {
  return {
    ...(def.repeat === undefined ? {} : { repeat: def.repeat }),
    ...(def.hold === undefined ? {} : { hold: def.hold }),
    ...(def.gap === undefined ? {} : { gap: def.gap }),
    steps: def.steps.map((step) => ({
      ...(step.tap === undefined ? {} : { tap: step.tap }),
      ...(step.hold === undefined ? {} : { hold: step.hold }),
      ...(step.down === undefined ? {} : { down: step.down }),
      ...(step.up === undefined ? {} : { up: step.up }),
      ...(step.wait === undefined ? {} : { wait: step.wait }),
    })),
  };
}

/** The macros that differ between the file as loaded and the page now: added, edited, gone. */
export function changedMacros(
  loaded: Readonly<Record<string, MacroDef>>,
  working: Readonly<Record<string, MacroDef>>,
): string[] {
  const ids = [...new Set([...Object.keys(loaded), ...Object.keys(working)])];
  return ids.filter((id) => {
    const before = loaded[id];
    const now = working[id];
    if (before === undefined || now === undefined) return before !== now;
    return JSON.stringify(canonicalMacro(before)) !== JSON.stringify(canonicalMacro(now));
  });
}

/** The file's text with every change written in, and nothing else touched. */
export function patchedMacros(
  text: string,
  loaded: Readonly<Record<string, MacroDef>>,
  working: Readonly<Record<string, MacroDef>>,
): string {
  let patched = text;
  for (const id of changedMacros(loaded, working)) {
    patched = patchMacro(patched, id, working[id] ?? null);
  }
  return patched;
}

/** What is wrong with a macro as it would be saved, in a line, or null when it is sound. */
export function macroProblem(
  def: MacroDef,
  actions: Readonly<Record<string, ActionSpec>>,
): string | null {
  return resolveMacro(def, actions).problems[0] ?? null;
}

/**
 * A new macro and its action, started on the keypad: the action is given a trigger key
 * (F13-F24) from `wireTrigger`, never one from the pool a game's own keys come from, so it
 * is sound the moment it exists. Returns the trigger, or null when none was left.
 */
export function addMacro(
  actions: Record<string, ActionSpec>,
  macros: Record<string, MacroDef>,
  id: string,
  label: string,
  def: MacroDef,
): string | null {
  actions[id] = { label };
  macros[id] = def;
  return wireTrigger(actions, id);
}

/**
 * Take a macro out. Its action goes with it when `removeAction` says nothing else uses it;
 * otherwise the action stays, and this says so.
 */
export function removeMacro(
  actions: Record<string, ActionSpec>,
  macros: Record<string, MacroDef>,
  id: string,
  removeAction: boolean,
): { actionKept: boolean } {
  removeKey(macros, id);
  if (removeAction) removeKey(actions, id);
  return { actionKept: !removeAction && id in actions };
}
