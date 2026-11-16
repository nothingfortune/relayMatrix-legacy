/**
 * The Macros panel on the In-game tab: each macro's keys, which buttons start it, and what
 * the checks say of it. It draws and reads input; everything it changes goes through the
 * host, which owns the page's working copies, so the panel keeps only what is being typed.
 */

import type { Finding } from "../lib/lint.js";
import type { MacroDef } from "../lib/macros.js";
import { removeKey } from "../lib/object.js";
import type { ActionSpec } from "../types/profile.js";
import { stepsFromText, textFromSteps } from "./macros-model.js";

type Child = Node | string;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

/** What the panel needs of the page. Each change returns what is wrong, or null when taken. */
export interface MacrosHost {
  macros: Readonly<Record<string, MacroDef>>;
  actions: Readonly<Record<string, ActionSpec>>;
  /** The checks that are about macros (`macro-invalid`, `macro-trigger`). */
  findings: readonly Finding[];
  /** Where each action sits on the keypads, for those that are on a control. */
  placed(id: string): readonly string[];
  nameField(id: string, spec: ActionSpec): HTMLElement;
  kbmField(id: string, spec: ActionSpec): HTMLElement;
  padField(id: string, spec: ActionSpec): HTMLElement;
  /** A new macro and its action, started on the keypad. */
  add(name: string, def: MacroDef): string | null;
  update(id: string, def: MacroDef): string | null;
  /** Give the macro's action a trigger key, or take it off the keypad. */
  keypad(id: string, on: boolean): string | null;
  remove(id: string): void;
  /** Draw again without changing anything, to show what was typed and refused. */
  redraw(): void;
}

interface Draft {
  keys?: string;
  hold?: string;
  gap?: string;
  error?: string;
}

/** What is typed and not taken yet, per macro, so a redraw does not lose it. */
const drafts = new Map<string, Draft>();
const adding = { name: "", keys: "", error: "" };

/** Forget what was being typed: called with the page's other per-session state. */
export function resetMacroDrafts(): void {
  drafts.clear();
  adding.name = "";
  adding.keys = "";
  adding.error = "";
}

function draftOf(id: string): Draft {
  const found = drafts.get(id);
  if (found !== undefined) return found;
  const fresh: Draft = {};
  drafts.set(id, fresh);
  return fresh;
}

/** A setting kept out of the macro when it is not given, so the file stays a plain list. */
function withSetting(def: MacroDef, field: "repeat" | "hold" | "gap", value: unknown): MacroDef {
  const next: MacroDef = { ...def };
  removeKey(next, field);
  if (value === undefined) return next;
  if (field === "repeat") return { ...next, repeat: value === true };
  return field === "hold" ? { ...next, hold: Number(value) } : { ...next, gap: Number(value) };
}

function numberField(
  label: string,
  field: "hold" | "gap",
  id: string,
  def: MacroDef,
  host: MacrosHost,
): HTMLElement {
  const draft = drafts.get(id);
  const input = el("input", {
    type: "text",
    inputmode: "numeric",
    class: "macro-ms",
    "data-macro-field": field,
    placeholder: "30",
    "aria-label": `${label} (ms)`,
    value: draft?.[field] ?? (def[field] === undefined ? "" : String(def[field])),
  });
  input.addEventListener("input", () => {
    draftOf(id)[field] = input.value;
  });
  input.addEventListener("change", () => {
    const text = input.value.trim();
    if (text !== "" && !/^\d+$/.test(text)) {
      draftOf(id).error = `${label} is whole ms`;
      host.redraw();
      return;
    }
    commit(id, withSetting(def, field, text === "" ? undefined : text), host);
  });
  return el("label", { class: "macro-opt" }, [`${label} `, input, " ms"]);
}

/** Hand a changed macro to the page; on refusal, keep what was typed and say why. */
function commit(id: string, def: MacroDef, host: MacrosHost): void {
  // Cleared first: a change that is taken redraws, and must not draw what was typed again.
  const typed = drafts.get(id);
  drafts.delete(id);
  const error = host.update(id, def);
  if (error === null) return;
  drafts.set(id, { ...typed, error });
  host.redraw();
}

function macroRow(id: string, def: MacroDef, host: MacrosHost): HTMLElement {
  const spec = host.actions[id] ?? {};
  const draft = drafts.get(id);
  const row = el("div", { class: "macro", "data-macro": id });

  const where = host.placed(id);
  const head = el("div", { class: "macro-head" }, [
    el("div", { class: "who" }, [
      host.nameField(id, spec),
      el("small", {}, [where.length > 0 ? where.join(", ") : "not on a keypad control"]),
    ]),
  ]);
  const remove = el("button", { class: "btn small", type: "button", "data-macro-remove": id }, [
    "Delete",
  ]);
  remove.addEventListener("click", () => {
    host.remove(id);
  });
  head.append(remove);
  row.append(head);

  const keys = el("input", {
    type: "text",
    class: "macro-keys",
    "data-macro-keys": id,
    placeholder: "A B C",
    "aria-label": `Keys of ${spec.label ?? id}`,
    spellcheck: "false",
    value: draft?.keys ?? textFromSteps(def.steps),
  });
  keys.addEventListener("input", () => {
    draftOf(id).keys = keys.value;
  });
  keys.addEventListener("keydown", (event) => {
    if (event.key === "Enter") keys.blur();
  });
  keys.addEventListener("change", () => {
    const read = stepsFromText(keys.value);
    if ("error" in read) {
      draftOf(id).error = read.error;
      host.redraw();
      return;
    }
    commit(id, { ...def, steps: read.steps }, host);
  });
  row.append(keys);

  const repeat = el("input", { type: "checkbox", "data-macro-field": "repeat" });
  repeat.checked = def.repeat === true;
  repeat.addEventListener("change", () => {
    commit(id, withSetting(def, "repeat", repeat.checked ? true : undefined), host);
  });
  row.append(
    el("div", { class: "macro-opts" }, [
      el("label", { class: "macro-opt" }, [repeat, " Repeat"]),
      numberField("Hold", "hold", id, def, host),
      numberField("Gap", "gap", id, def, host),
    ]),
  );

  // What starts it: any of the three.
  const keypad = el("input", { type: "checkbox", "data-macro-keypad": id });
  const trigger = typeof spec.key === "string" ? spec.key : null;
  keypad.checked = trigger !== null;
  // A control that carries the action would be left sending nothing.
  if (where.length > 0) {
    keypad.disabled = true;
    keypad.title = "On a keypad control";
  }
  keypad.addEventListener("change", () => {
    const error = host.keypad(id, keypad.checked);
    if (error !== null) {
      draftOf(id).error = error;
      host.redraw();
    }
  });
  row.append(
    el("div", { class: "macro-starts" }, [
      el("label", { class: "macro-opt macro-keypad" }, [
        keypad,
        " Keypad",
        ...(trigger === null ? [] : [el("span", { class: "macro-trigger" }, [` ${trigger}`])]),
      ]),
      host.kbmField(id, spec),
      host.padField(id, spec),
    ]),
  );

  const problems = host.findings.filter((finding) => finding.key === id);
  for (const finding of problems) {
    row.append(
      el("div", { class: "finding error macro-finding" }, [
        el("small", { class: "rule" }, [finding.rule]),
        finding.message,
      ]),
    );
  }
  if (draft?.error !== undefined) {
    row.append(el("div", { class: "keybind-note bad", "data-macro-error": id }, [draft.error]));
  }
  return row;
}

/** Name and keys together, so a macro is whole from the start. */
function addRow(host: MacrosHost): HTMLElement {
  const name = el("input", {
    type: "text",
    class: "macro-name",
    "data-macro-new": "name",
    placeholder: "Name",
    "aria-label": "Macro name",
    value: adding.name,
  });
  const keys = el("input", {
    type: "text",
    class: "macro-keys",
    "data-macro-new": "keys",
    placeholder: "A B C",
    spellcheck: "false",
    "aria-label": "Macro keys",
    value: adding.keys,
  });
  name.addEventListener("input", () => {
    adding.name = name.value;
  });
  keys.addEventListener("input", () => {
    adding.keys = keys.value;
  });
  const add = el("button", { class: "btn small primary", type: "button", "data-macro-add": "" }, [
    "Add",
  ]);
  const submit = (): void => {
    adding.name = name.value;
    adding.keys = keys.value;
    const label = adding.name.trim();
    if (label === "") {
      adding.error = "Give it a name";
    } else {
      const read = stepsFromText(adding.keys);
      if ("error" in read) adding.error = read.error;
      else {
        // Cleared first: a macro that is added redraws, and must not draw the form as it was.
        adding.name = "";
        adding.keys = "";
        adding.error = "";
        const error = host.add(label, { steps: read.steps });
        if (error === null) return;
        adding.name = label;
        adding.keys = keys.value;
        adding.error = error;
      }
    }
    host.redraw();
  };
  add.addEventListener("click", submit);
  for (const input of [name, keys]) {
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      submit();
    });
  }
  const row = el("div", { class: "macro-add" }, [name, keys, add]);
  if (adding.error === "") return row;
  return el("div", {}, [
    row,
    el("div", { class: "keybind-note bad", "data-macro-error": "" }, [adding.error]),
  ]);
}

/** The panel: every macro of the game, and the row that adds one. */
export function renderMacros(host: MacrosHost): HTMLElement {
  const panel = el("div", { class: "macros", "data-macros": "" }, [el("h3", {}, ["Macros"])]);
  for (const [id, def] of Object.entries(host.macros)) panel.append(macroRow(id, def, host));
  panel.append(addRow(host));
  return panel;
}
