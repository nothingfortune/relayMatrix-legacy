/**
 * A genre's defaults, drawn with nothing started: the Xbox pad with each control labelled by
 * its action, and the pair of units laid out the way a game of that kind starts.
 *
 * Read only. Nothing here touches the page's working copies, so looking at a default never
 * marks a layout unsaved. The data is `payload.genres[].defaults` (lib/defaults.ts), built
 * with the same `buildStyle` a new game is; the drawing reuses the pad board of the In-game
 * tab and the Edit board's own classes.
 */
import { describeDirection } from "../lib/binding.js";
import { handLayout, positionLabel, unitLabel } from "../lib/layout.js";
import { ROLE_TAGS } from "../lib/lint.js";
import { Device } from "../lib/model-core.js";
import { STICK_DIRECTIONS } from "../types/azeron.js";
import type { EditorGenre, EditorPayload } from "../types/editor.js";
import type { ActionSpec, DeviceData, PositionSpec } from "../types/profile.js";
import { padBoard } from "./device-boards.js";

export interface DefaultsEnv {
  payload: EditorPayload;
  /** Whether a game can be started from here: only the served editor can write one. */
  canStart: boolean;
  /** Fill the new-game form with this genre and layout and take the owner to it. */
  start: (genre: string, style: string) => void;
  /** Draw the page again after a choice. */
  redraw: () => void;
}

type Item = HTMLElement | string;

function el(tag: string, attrs: Record<string, string> = {}, children: Item[] = []): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

/** The genre and layout being looked at. Module state, because every render rebuilds the page. */
const looking = { genre: "", style: "" };

/** Forget the genre and layout looked at: the next draw opens on the first of each. */
export function resetDefaultsView(): void {
  looking.genre = "";
  looking.style = "";
}

/** Scoped to `.defaults`: the Edit board's classes at a size that fits the Setup page. */
export const DEFAULTS_CSS = `
.defaults { margin-bottom: 18px; }
.defaults .defaults-pick { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; margin: 8px 0 12px; }
.defaults .defaults-pick .field { margin: 0; min-width: 160px; }
.defaults .defaults-caption { font-size: 10.5px; font-weight: 700; color: var(--muted); text-transform: uppercase;
                              letter-spacing: .1em; margin: 12px 0 4px; }
.defaults .pad-cross { grid-template-columns: repeat(3, 108px); grid-auto-rows: 46px; }
.defaults .pad-cross .device-key { width: 108px; min-height: 46px; cursor: default; }
.defaults .device-row .device-key { width: 108px; min-height: 46px; cursor: default; }
.defaults .device-key-action { font-size: 10px; white-space: normal; line-height: 1.15;
                               display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.defaults .off-pad { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.defaults .off-pad .tag-chip { cursor: default; }
.defaults .workspace.board { padding: 0; }
.defaults .stage { --key-w: 76px; --key-h: 46px; flex-wrap: wrap; justify-content: center; }
.defaults .key { cursor: default; }
`;

function addStyles(): void {
  if (document.getElementById("azeron-defaults-styles")) return;
  const style = document.createElement("style");
  style.id = "azeron-defaults-styles";
  style.textContent = DEFAULTS_CSS;
  document.head.append(style);
}

/** A drawing with nothing to press: each button of it becomes a plain box of the same look. */
function readOnly(board: HTMLElement): HTMLElement {
  for (const button of board.querySelectorAll("button")) {
    const box = el("div", { class: button.className, style: button.getAttribute("style") ?? "" });
    box.title = button.title;
    box.append(...button.childNodes);
    button.replaceWith(box);
  }
  return board;
}

/** The pad's actions as `padBoard` reads them: each with its control as its `pad`. */
function padActions(genre: EditorGenre): Record<string, ActionSpec> {
  const actions: Record<string, ActionSpec> = {};
  for (const row of genre.defaults?.pad ?? []) {
    if (row.action !== null)
      actions[row.action] = { label: row.label ?? row.action, pad: row.control };
  }
  return actions;
}

/** The unit of a hand: the first device map that says it is that hand's. */
function unitFor(payload: EditorPayload, hand: "left" | "right"): DeviceData | undefined {
  return Object.values(payload.devices).find((device) => device.hand === hand);
}

function handBoard(
  hand: "left" | "right",
  positions: Readonly<Record<string, PositionSpec>>,
  device: DeviceData,
  genre: EditorGenre,
): HTMLElement {
  const actions = genre.actions.actions ?? {};
  const nameOf = (id: string): string => actions[id]?.label ?? id;
  const layout = handLayout(new Device(device));

  const key = (position: string, extra = ""): HTMLElement => {
    const spec = positions[position];
    const tap = spec?.tap;
    const role =
      typeof tap === "string"
        ? (ROLE_TAGS.find((tag) => (actions[tap]?.tags ?? []).includes(tag)) ?? "")
        : "";
    const name =
      spec === undefined ? null : (spec.label ?? (typeof tap === "string" ? nameOf(tap) : null));
    const card = el(
      "div",
      { class: ["key", extra, role, name === null ? "empty" : ""].filter(Boolean).join(" ") },
      [el("span", { class: "pos" }, [positionLabel(position)])],
    );
    if (name !== null) {
      card.append(el("span", { class: "name" }, [name]));
      card.title = name;
    }
    card.setAttribute("data-position", position);
    return card;
  };

  const stickDial = (position: string, press: string | null): HTMLElement => {
    const spec = positions[position];
    const dial = el("div", { class: "stick-dial" });
    for (const direction of STICK_DIRECTIONS) {
      const label = describeDirection(nameOf, spec?.directions?.[direction]);
      const cell = el("div", { class: `dir ${direction}${label === null ? " empty" : ""}` }, [
        el("span", { class: "glyph" }, [{ up: "↑", right: "→", down: "↓", left: "←" }[direction]]),
      ]);
      if (label !== null) cell.append(el("span", { class: "name" }, [label]));
      dial.append(cell);
    }
    const pressSpec = press === null ? undefined : positions[press];
    const pressName =
      pressSpec?.label ?? (typeof pressSpec?.tap === "string" ? nameOf(pressSpec.tap) : null);
    const mouse = spec?.mode === "mouse";
    const hubName = pressName ?? (mouse ? "pointer" : "click");
    const hub = el("div", { class: `dir hub${pressName === null && !mouse ? " empty" : ""}` }, [
      el("span", { class: "wheel" }),
      el("span", { class: "name" }, [hubName]),
    ]);
    hub.setAttribute("data-position", press ?? position);
    dial.append(hub);
    return dial;
  };

  const wrap = el("div", { class: "hand" }, [
    el("div", { class: "title" }, [el("b", {}, [`${unitLabel(hand)} unit`])]),
  ]);
  const columns = layout.columns.map((entry) =>
    el("div", { class: `col ${entry.kind}` }, [
      el("div", { class: "head" }, [entry.name]),
      ...entry.positions.map((position) => key(position)),
    ]),
  );
  const groups: HTMLElement[] = [];
  if (layout.stick !== null) {
    const mode = positions[layout.stick]?.mode;
    groups.push(
      el("div", { class: "thumb-group" }, [
        el("div", { class: "head" }, [`thumbstick · ${mode ?? "unbound"}`]),
        stickDial(layout.stick, layout.stickPress),
      ]),
    );
  }
  if (layout.dpad.length > 0) {
    const pad = el("div", { class: "dpad" });
    for (const [position, cell] of layout.dpad) pad.append(key(position, cell));
    groups.push(
      el("div", { class: "thumb-group" }, [el("div", { class: "head" }, ["d-pad"]), pad]),
    );
  }
  if (layout.aux.length > 0) {
    groups.push(
      el("div", { class: "thumb-group" }, [
        el("div", { class: "head" }, ["aux"]),
        el(
          "div",
          { class: "aux" },
          layout.aux.map((position) => key(position)),
        ),
      ]),
    );
  }
  const thumb = el("div", { class: "thumb-row" }, [
    el("div", { class: "head" }, ["thumb"]),
    el("div", { class: "thumb-cluster" }, layout.thumbSide === "left" ? groups.reverse() : groups),
  ]);
  wrap.append(
    el("div", { class: `hand-body thumb-${layout.thumbSide}` }, [
      el("div", { class: "fingers" }, columns),
      thumb,
    ]),
  );
  return wrap;
}

/**
 * The defaults view, or null when the page has none (a payload from before they were in it).
 * One genre at a time, in one of its layouts: Xbox pad above, the units below.
 */
export function renderDefaults(env: DefaultsEnv): HTMLElement | null {
  const genres = env.payload.genres.filter((genre) => genre.defaults !== undefined);
  const first = genres[0];
  if (first === undefined) return null;
  addStyles();
  const genre = genres.find((entry) => entry.name === looking.genre) ?? first;
  looking.genre = genre.name;
  const layouts = genre.defaults?.styles ?? [];
  const layout = layouts.find((entry) => entry.name === looking.style) ?? layouts[0];
  looking.style = layout?.name ?? "";

  const genreSelect = el("select", { "data-defaults": "genre" });
  for (const entry of genres) {
    const option = el("option", { value: entry.name }, [entry.name]);
    if (entry.name === genre.name) option.setAttribute("selected", "selected");
    genreSelect.append(option);
  }
  genreSelect.addEventListener("change", () => {
    looking.genre = (genreSelect as HTMLSelectElement).value;
    looking.style = "";
    env.redraw();
  });
  const styleSelect = el("select", { "data-defaults": "style" });
  for (const entry of layouts) {
    const option = el("option", { value: entry.name, title: entry.note }, [entry.label]);
    if (entry.name === layout?.name) option.setAttribute("selected", "selected");
    styleSelect.append(option);
  }
  styleSelect.addEventListener("change", () => {
    looking.style = (styleSelect as HTMLSelectElement).value;
    env.redraw();
  });

  const pick = el("div", { class: "defaults-pick" }, [
    el("div", { class: "field" }, [el("label", {}, ["Kind of game"]), genreSelect]),
    el("div", { class: "field" }, [el("label", {}, ["Layout"]), styleSelect]),
  ]);
  // Only a pair is laid out in a style, and only the served editor can write a game.
  if (env.canStart && layout !== undefined && layout.name !== "default") {
    const start = el("button", { class: "btn primary", type: "button", "data-defaults": "start" }, [
      "Start a game from this",
    ]);
    start.addEventListener("click", () => {
      env.start(genre.name, layout.name);
    });
    pick.append(start);
  }

  const box = el("div", { class: "defaults", "data-defaults": "view" }, [
    el("h3", {}, ["Defaults"]),
    pick,
    el("div", { class: "defaults-caption" }, ["Xbox pad"]),
    readOnly(padBoard(padActions(genre), () => undefined)),
  ]);
  const off = genre.defaults?.offPad ?? [];
  if (off.length > 0) {
    box.append(
      el("div", { class: "defaults-caption" }, ["Not on the pad"]),
      el(
        "div",
        { class: "off-pad", "data-defaults": "off-pad" },
        off.map((entry) => el("span", { class: "tag-chip" }, [entry.label])),
      ),
    );
  }

  box.append(el("div", { class: "defaults-caption" }, ["Units"]));
  if (layout === undefined) return box;
  if (layout.error !== null) {
    box.append(el("div", { class: "note bad", "data-defaults": "error" }, [layout.error]));
    return box;
  }
  const stage = el("div", { class: "stage" });
  const hands: ("left" | "right")[] = layout.name === "default" ? ["left"] : ["left", "right"];
  for (const hand of hands) {
    const device = unitFor(env.payload, hand);
    if (device === undefined) continue;
    stage.append(handBoard(hand, layout[hand], device, genre));
  }
  box.append(el("div", { class: "workspace board" }, [stage]));
  return box;
}
