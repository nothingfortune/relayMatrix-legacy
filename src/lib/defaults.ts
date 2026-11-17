/**
 * A genre's defaults, drawn from its files: the Xbox pad (which action is on which control)
 * and each style's layout of the pair, with nothing started.
 *
 * One source drives both. The pad is the `xbox:` column of the genre's actions.yaml; a
 * `controller` style places every action on the pair by that same control (xbox.ts) and
 * adds only what no control carries. The styles are built with `buildStyle`, as a new game
 * builds them, so what is shown is what a new game starts with. A style that cannot be built
 * comes back as `error`, so one bad genre does not take the others with it.
 *
 * Node-free and pure: the files are read by the caller. The CLI prints it
 * (`azeron defaults`) and the editor's payload carries it.
 */

import type { StickDirection } from "../types/azeron.js";
import type { ActionSpec, PositionSpec } from "../types/profile.js";
import { positionLabel, unitLabel } from "./layout.js";
import { StyleError, buildStyle, styleNames } from "./styles.js";
import type { StyleSpec } from "./styles.js";
import type { StickModeSet } from "./stickmodes.js";
import { XBOX_CONTROLS, xboxLabel } from "./xbox.js";

/** The name of the one-unit layout, which is not a style of layouts.yaml. */
export const SINGLE_UNIT = "default";

export interface PadRow {
  /** The control, as actions.yaml names it: `A`, `LeftStickUp`. */
  control: string;
  /** The action on it, or null for a control nothing uses. */
  action: string | null;
  label: string | null;
}

export interface StyleDefaults {
  /** `controller`, `keyboard`, or `default` for the genre's one-unit layout. */
  name: string;
  label: string;
  note: string;
  left: Record<string, PositionSpec>;
  right: Record<string, PositionSpec>;
  /** Why the style cannot be built; the hands are empty then. */
  error: string | null;
}

export interface GenreDefaults {
  genre: string;
  /** Every control of the pad, in the order a pad is read. */
  pad: PadRow[];
  /** Actions on no pad control, in the vocabulary's order. */
  offPad: { id: string; label: string }[];
  styles: StyleDefaults[];
}

export interface DefaultsInput {
  genre: string;
  /** The genre's vocabulary. */
  actions: Readonly<Record<string, ActionSpec>>;
  /** The genre's single-unit default.yaml positions. */
  defaults: Readonly<Record<string, PositionSpec>>;
  styles: Readonly<Record<string, StyleSpec>>;
  modes?: StickModeSet | undefined;
}

/** The pad as the vocabulary has it. The first action on a control keeps it. */
export function padRows(actions: Readonly<Record<string, ActionSpec>>): PadRow[] {
  const byControl = new Map<string, string>();
  for (const [id, spec] of Object.entries(actions)) {
    if (typeof spec.xbox === "string" && !byControl.has(spec.xbox)) byControl.set(spec.xbox, id);
  }
  return Object.keys(XBOX_CONTROLS).map((control) => {
    const action = byControl.get(control) ?? null;
    return {
      control,
      action,
      label: action === null ? null : (actions[action]?.label ?? action),
    };
  });
}

/**
 * Actions the pad has no control for. An action the mouse supplies and the pad has no use
 * for (looking, the pointer's axes) is not one the pad is missing.
 */
export function offPad(actions: Readonly<Record<string, ActionSpec>>): GenreDefaults["offPad"] {
  return Object.entries(actions)
    .filter(([, spec]) => spec.xbox === undefined && !spec.provided_by)
    .map(([id, spec]) => ({ id, label: spec.label ?? id }));
}

/** One style, built as a new game builds it; an error is data. */
export function styleDefaults(
  input: DefaultsInput,
  name: string,
  withPedals = false,
): StyleDefaults {
  if (name === SINGLE_UNIT) {
    return {
      name,
      label: "One unit",
      note: "The genre's one-unit layout; the other hand has the mouse.",
      left: structuredClone(input.defaults),
      right: {},
      error: null,
    };
  }
  const style = input.styles[name];
  if (style === undefined) {
    return { name, label: name, note: "", left: {}, right: {}, error: `no style '${name}'` };
  }
  try {
    const built = buildStyle(name, style, {
      actions: input.actions,
      defaults: input.defaults,
      modes: input.modes,
      withPedals,
    });
    return {
      name,
      label: style.label,
      note: style.note ?? "",
      left: built.left,
      right: built.right,
      error: null,
    };
  } catch (error) {
    if (!(error instanceof StyleError)) throw error;
    return {
      name,
      label: style.label,
      note: style.note ?? "",
      left: {},
      right: {},
      error: error.message,
    };
  }
}

/** A genre's pad and every layout it offers: its styles, then the one-unit default. */
export function genreDefaults(input: DefaultsInput): GenreDefaults {
  return {
    genre: input.genre,
    pad: padRows(input.actions),
    offPad: offPad(input.actions),
    styles: [...styleNames(input.styles), SINGLE_UNIT].map((name) => styleDefaults(input, name)),
  };
}

const STICK_ORDER: readonly StickDirection[] = ["up", "right", "down", "left"];

const POSITION_ORDER = [
  "stick",
  "stick_press",
  "dpad_up",
  "dpad_left",
  "dpad_press",
  "dpad_right",
  "dpad_down",
  "thumb_aux_upper",
  "thumb_aux_lower",
  "pinky_side",
  "index_side",
];

/** Where a position sits in a listing: the thumb first, then the fingers by column and row. */
function orderOf(position: string): number {
  const known = POSITION_ORDER.indexOf(position);
  if (known !== -1) return known;
  const finger = /^(pinky|ring|middle|index)_(\d+)$/.exec(position);
  if (finger?.[1] && finger[2]) {
    const column = ["pinky", "ring", "middle", "index"].indexOf(finger[1]);
    return POSITION_ORDER.length + column * 10 + Number(finger[2]);
  }
  return 1000;
}

export interface PositionRow {
  /** "Stick up", "Pinky 1", "Pinky 1 long". */
  where: string;
  /** What is on it, as the page would name it. */
  what: string;
}

/** What a position holds, one row per thing on it, in the order a unit is read. */
export function positionRows(
  actions: Readonly<Record<string, ActionSpec>>,
  positions: Readonly<Record<string, PositionSpec>>,
): PositionRow[] {
  const name = (value: unknown): string =>
    typeof value === "string" ? (actions[value]?.label ?? value) : "(a key of its own)";
  const rows: PositionRow[] = [];
  const ordered = Object.entries(positions).sort(
    ([a], [b]) => orderOf(a) - orderOf(b) || a.localeCompare(b),
  );
  for (const [position, spec] of ordered) {
    const where = positionLabel(position);
    if (spec.mode !== undefined || spec.directions !== undefined) {
      if (spec.mode !== undefined && spec.mode !== "keyboard") {
        rows.push({ where, what: `${spec.mode} mode` });
      }
      for (const direction of STICK_ORDER) {
        const value = spec.directions?.[direction];
        if (value !== undefined) rows.push({ where: `${where} ${direction}`, what: name(value) });
      }
      continue;
    }
    for (const [slot, value] of [
      ["", spec.tap],
      [" long", spec.long],
      [" double", spec.double],
    ] as const) {
      if (value !== undefined) rows.push({ where: `${where}${slot}`, what: name(value) });
    }
  }
  return rows;
}

function table(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(0, ...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`);
}

/** The pad as a plain table: each control and its action. */
export function padText(defaults: GenreDefaults): string {
  const lines = [`${defaults.genre}: the Xbox pad`];
  lines.push(
    ...table(defaults.pad.map((row) => [xboxLabel(row.control), row.label ?? "-"] as const)),
  );
  if (defaults.offPad.length > 0) {
    lines.push("", `On no control: ${defaults.offPad.map((entry) => entry.label).join(", ")}`);
  }
  return lines.join("\n");
}

/** A style as plain tables: each unit's controls and what is on them. */
export function styleText(
  actions: Readonly<Record<string, ActionSpec>>,
  style: StyleDefaults,
): string {
  const lines = [`${style.label} (${style.name})`];
  if (style.error !== null) return [...lines, `  cannot be built: ${style.error}`].join("\n");
  for (const hand of ["left", "right"] as const) {
    const rows = positionRows(actions, style[hand]);
    lines.push("", `${unitLabel(hand)} unit`);
    lines.push(...(rows.length === 0 ? ["  (empty)"] : table(rows.map((r) => [r.where, r.what]))));
  }
  return lines.join("\n");
}

/**
 * What `azeron defaults` prints. With no genre, the genres and the layouts each offers; with
 * one, its pad and one layout of the pair (the genre's first unless `style` names another).
 * Throws on a name that is not there, saying what is.
 */
export function defaultsReport(
  all: readonly DefaultsInput[],
  genre?: string,
  style?: string,
): string {
  if (genre === undefined) {
    const rows = all.map((input) => {
      const names = genreDefaults(input).styles.map((entry) => entry.name);
      return [input.genre, names.join(", ")] as const;
    });
    return ["Genres and the layouts each starts a game with:", ...table(rows)].join("\n");
  }
  const input = all.find((entry) => entry.genre.toLowerCase() === genre.toLowerCase());
  if (input === undefined) {
    throw new Error(`no genre '${genre}' (have: ${all.map((entry) => entry.genre).join(", ")})`);
  }
  const defaults = genreDefaults(input);
  const names = defaults.styles.map((entry) => entry.name);
  const chosen = defaults.styles.find((entry) => entry.name === (style ?? names[0]));
  if (chosen === undefined) {
    throw new Error(`${input.genre} has no '${style ?? ""}' layout (have: ${names.join(", ")})`);
  }
  const others = names.filter((name) => name !== chosen.name);
  return [
    padText(defaults),
    "",
    styleText(input.actions, chosen),
    ...(others.length === 0 ? [] : ["", `Other layouts: ${others.join(", ")} (--style)`]),
  ].join("\n");
}
