// @vitest-environment happy-dom
/**
 * The Macros panel on the In-game tab: a macro's keys and the buttons that start it, added,
 * edited and deleted there, saved into macros.yaml with the rest of the layout, and shown in
 * the checks. And the wiring rule: a macro's action is given a trigger key, never a key from
 * the pool a game's own bindings could be on, and nothing fills in a button for it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { start } from "../../../src/editor/app.js";
import { buildPayload } from "../../../src/lib/editor/payload.js";
import type { MacroDef } from "../../../src/lib/macros.js";
import type { EditorPayload } from "../../../src/types/editor.js";
import type { ActionSpec } from "../../../src/types/profile.js";
import { showDockTab } from "../../helpers/editor.js";
import { LIVE_SET } from "../../helpers/fixtures.js";

const PAYLOAD = buildPayload();
const SERVED = window as unknown as { AZERON_SERVED?: boolean };
const TEXT = "# my macros\nmacros:\n  quick_heal: [KeyH, KeyJ]\n";

interface Call {
  path: string;
  body: Record<string, unknown>;
}

function served(findings: unknown[] = []): Call[] {
  SERVED.AZERON_SERVED = true;
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string, init: { body: string }) => {
      calls.push({ path, body: JSON.parse(init.body) as Call["body"] });
      return Promise.resolve({
        status: 200,
        json: () =>
          Promise.resolve({
            ok: true,
            saved: true,
            path: "p",
            check: { game: null, built: [], findings, buildErrors: [] },
          }),
      });
    }),
  );
  return calls;
}

/**
 * The fixture's game with one macro, Quick heal, which a keypad control (F13) and the M key
 * start, and an action to type by name (Reload).
 */
function payloadWith(
  macros: Record<string, MacroDef> = { quick_heal: { steps: [{ tap: "KeyH" }, { tap: "KeyJ" }] } },
  extra: Record<string, ActionSpec> = {},
  connected = true,
): EditorPayload {
  const payload = structuredClone(PAYLOAD);
  const game = payload.games.find((entry) => entry.slug === "everspace");
  if (!game) throw new Error("no everspace in the fixture");
  const actions = (game.actions.actions ??= {});
  actions.quick_heal = { label: "Quick heal", key: "F13", kbm: "KeyM" };
  actions.reload_it = { label: "Reload it", kbm: "KeyR" };
  Object.assign(actions, extra);
  game.macros = { macros };
  game.macrosText = Object.keys(macros).length === 0 ? "" : TEXT;
  if (!connected) {
    Reflect.deleteProperty(game, "ingameFile");
    for (const spec of Object.values(actions)) Reflect.deleteProperty(spec, "ingame");
  }
  return payload;
}

function mount(payload: EditorPayload = payloadWith()): void {
  document.body.innerHTML = '<div id="app"></div>';
  start(structuredClone(payload));
  const select = document.querySelectorAll<HTMLSelectElement>("header select")[0];
  if (select && select.value !== LIVE_SET) {
    select.value = LIVE_SET;
    select.dispatchEvent(new Event("change"));
  }
}

function tab(name: string): void {
  const found = [...document.querySelectorAll<HTMLButtonElement>("header .tabs button")].find(
    (button) => button.textContent === name,
  );
  if (!found) throw new Error(`no tab ${name}`);
  found.click();
}

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".macros .macro")];
const macroRow = (id: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`.macro[data-macro="${id}"]`);
  if (!found) throw new Error(`no macro ${id}`);
  return found;
};
/** An action's row on the In-game tab, by the name it shows. */
function actionRow(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>(".ingame-row")].find(
    (node) => node.querySelector(".who .rename")?.textContent === label,
  );
  if (!found) throw new Error(`no row for ${label}`);
  return found;
}
// The caller says what it expects to find, as querySelector does.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const field = <T extends HTMLElement>(root: ParentNode, selector: string): T => {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`no ${selector}`);
  return found;
};

function typeInto(input: HTMLInputElement, value: string, event = "change"): void {
  input.value = value;
  input.dispatchEvent(new Event("input"));
  input.dispatchEvent(new Event(event));
}

function keysOf(id: string): string {
  return field<HTMLInputElement>(macroRow(id), "[data-macro-keys]").value;
}

function addMacroNamed(name: string, keys: string): void {
  typeInto(field(document, '[data-macro-new="name"]'), name, "input");
  typeInto(field(document, '[data-macro-new="keys"]'), keys, "input");
  field<HTMLButtonElement>(document, "[data-macro-add]").click();
}

const saveButton = (): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>("header button")].find(
    (node) => node.textContent === "Save" || node.textContent === "Saved",
  );

const press = (code: string, type: "keydown" | "keyup"): void => {
  window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
};

function dropOnKey(label: string, position: string): void {
  tab("Edit");
  const source = [...document.querySelectorAll<HTMLElement>(".action")].find(
    (node) => node.querySelector("b")?.textContent === label,
  );
  const target = document
    .querySelectorAll(".hand")[0]
    ?.querySelector<HTMLElement>(`.key[data-position="${position}"]`);
  if (!source || !target) throw new Error(`cannot drop ${label} on ${position}`);
  source.dispatchEvent(new Event("dragstart", { bubbles: true }));
  target.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
}

afterEach(() => {
  SERVED.AZERON_SERVED = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Macros panel", () => {
  it("lists each macro with its keys and the buttons that start it, in the In-game tab only", () => {
    mount();
    expect(document.querySelector(".macros")).toBeNull();
    tab("In-game");
    expect(rows()).toHaveLength(1);
    const row = macroRow("quick_heal");
    expect(row.querySelector(".who b")?.textContent).toBe("Quick heal");
    expect(keysOf("quick_heal")).toBe("H J");
    expect(field<HTMLInputElement>(row, "[data-macro-keypad]").checked).toBe(true);
    expect(row.querySelector(".macro-trigger")?.textContent.trim()).toBe("F13");
    expect(row.querySelector("[data-kbm]")?.textContent).toBe("M");
    expect(row.querySelector("[data-pad]")).not.toBeNull();
    // One home: the macro's action is not also a row of the list of actions.
    const listed = [...document.querySelectorAll(".ingame-row .who b")].map((b) => b.textContent);
    expect(listed).not.toContain("Quick heal");
    expect(listed).toContain("Reload it");
  });

  it("is only the add row for a game with no macros", () => {
    mount(payloadWith({}));
    tab("In-game");
    expect(rows()).toHaveLength(0);
    expect(document.querySelector('[data-macro-new="name"]')).not.toBeNull();
    expect(document.querySelector("[data-macro-add]")).not.toBeNull();
  });

  it("adds a macro from a name and its keys, on the keypad from the start", () => {
    served();
    mount();
    tab("In-game");
    addMacroNamed("Burst fire", "a b, 1");
    expect(rows()).toHaveLength(2);
    const row = macroRow("burst_fire");
    expect(row.querySelector(".who b")?.textContent).toBe("Burst fire");
    expect(keysOf("burst_fire")).toBe("A B 1");
    // The first trigger not taken: F13 is Quick heal's.
    expect(row.querySelector(".macro-trigger")?.textContent.trim()).toBe("F14");
    expect(saveButton()?.title).toBe("Unsaved: Action names, Macros");
    // The form is empty again.
    expect(field<HTMLInputElement>(document, '[data-macro-new="name"]').value).toBe("");
  });

  it("never reuses the id of a macro whose action is missing", () => {
    mount(payloadWith({ ghost: { steps: [{ tap: "KeyA" }] } }));
    tab("In-game");
    addMacroNamed("Ghost", "B");
    expect(keysOf("ghost")).toBe("A");
    expect(keysOf("ghost_2")).toBe("B");
  });

  it("adds with Enter in either box", () => {
    mount();
    tab("In-game");
    typeInto(field(document, '[data-macro-new="name"]'), "Dash", "input");
    const keys = field<HTMLInputElement>(document, '[data-macro-new="keys"]');
    typeInto(keys, "D D", "input");
    keys.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    expect(keysOf("dash")).toBe("D D");
  });

  it("refuses a missing name, a bad key and keys the game cannot type, creating nothing", () => {
    mount();
    tab("In-game");
    addMacroNamed("", "A");
    expect(document.querySelector("[data-macro-error]")?.textContent).toBe("Give it a name");
    addMacroNamed("Oops", "A +");
    expect(document.querySelector("[data-macro-error]")?.textContent).toBe("Not a key: +");
    addMacroNamed("Oops", "A Nonsense");
    expect(document.querySelector("[data-macro-error]")?.textContent).toContain("step 2");
    addMacroNamed("Oops", "");
    expect(document.querySelector("[data-macro-error]")?.textContent).toBe("has no steps");
    expect(rows()).toHaveLength(1);
    expect(saveButton()?.textContent).not.toBe("Save");
    // What was typed is kept, to be corrected.
    expect(field<HTMLInputElement>(document, '[data-macro-new="name"]').value).toBe("Oops");
  });

  it("refuses a macro when every trigger key is taken", () => {
    const taken: Record<string, ActionSpec> = {};
    for (let n = 14; n <= 24; n += 1)
      taken[`t${String(n)}`] = { label: `T${String(n)}`, key: `F${String(n)}` };
    mount(payloadWith(undefined, taken));
    tab("In-game");
    addMacroNamed("One more", "A");
    expect(document.querySelector("[data-macro-error]")?.textContent).toBe("No free trigger key");
    expect(rows()).toHaveLength(1);
  });

  it("edits the keys in place, on change, and the page is then unsaved", () => {
    served();
    mount();
    tab("In-game");
    expect(saveButton()?.textContent).toBe("Saved");
    typeInto(field(macroRow("quick_heal"), "[data-macro-keys]"), "h  j,K", "change");
    expect(keysOf("quick_heal")).toBe("H J K");
    expect(saveButton()?.title).toBe("Unsaved: Macros");
    // Typed back to what it was: nothing to save.
    typeInto(field(macroRow("quick_heal"), "[data-macro-keys]"), "H J", "change");
    expect(saveButton()?.textContent).toBe("Saved");
  });

  it("keeps what was typed and says why when it is not taken", () => {
    served();
    mount();
    tab("In-game");
    const keys = field<HTMLInputElement>(macroRow("quick_heal"), "[data-macro-keys]");
    typeInto(keys, "H wait:soon", "change");
    expect(field<HTMLInputElement>(macroRow("quick_heal"), "[data-macro-keys]").value).toBe(
      "H wait:soon",
    );
    expect(macroRow("quick_heal").querySelector("[data-macro-error]")?.textContent).toBe(
      "Wait is whole ms: wait:soon",
    );
    expect(saveButton()?.textContent).toBe("Saved");
    typeInto(field(macroRow("quick_heal"), "[data-macro-keys]"), "H Bogus", "change");
    expect(macroRow("quick_heal").querySelector("[data-macro-error]")?.textContent).toContain(
      "step 2",
    );
    expect(saveButton()?.textContent).toBe("Saved");
    // Corrected, it goes through and the message goes.
    typeInto(field(macroRow("quick_heal"), "[data-macro-keys]"), "H Digit2", "change");
    expect(macroRow("quick_heal").querySelector("[data-macro-error]")).toBeNull();
    expect(keysOf("quick_heal")).toBe("H 2");
  });

  it("sets repeat, hold and gap, and a blank one is the default again", () => {
    served();
    mount();
    tab("In-game");
    const repeat = field<HTMLInputElement>(macroRow("quick_heal"), '[data-macro-field="repeat"]');
    repeat.checked = true;
    repeat.dispatchEvent(new Event("change"));
    typeInto(field(macroRow("quick_heal"), '[data-macro-field="hold"]'), "45");
    typeInto(field(macroRow("quick_heal"), '[data-macro-field="gap"]'), "15");
    const row = macroRow("quick_heal");
    expect(field<HTMLInputElement>(row, '[data-macro-field="repeat"]').checked).toBe(true);
    expect(field<HTMLInputElement>(row, '[data-macro-field="hold"]').value).toBe("45");
    expect(field<HTMLInputElement>(row, '[data-macro-field="gap"]').value).toBe("15");
    typeInto(field(macroRow("quick_heal"), '[data-macro-field="hold"]'), "");
    expect(field<HTMLInputElement>(macroRow("quick_heal"), '[data-macro-field="hold"]').value).toBe(
      "",
    );
    typeInto(field(macroRow("quick_heal"), '[data-macro-field="gap"]'), "soon");
    expect(macroRow("quick_heal").querySelector("[data-macro-error]")?.textContent).toBe(
      "Gap is whole ms",
    );
  });

  it("takes the keypad trigger off and gives one back, from the trigger keys", () => {
    mount();
    tab("In-game");
    const box = (): HTMLInputElement =>
      field<HTMLInputElement>(macroRow("quick_heal"), "[data-macro-keypad]");
    box().checked = false;
    box().dispatchEvent(new Event("change"));
    expect(box().checked).toBe(false);
    expect(macroRow("quick_heal").querySelector(".macro-trigger")).toBeNull();
    box().checked = true;
    box().dispatchEvent(new Event("change"));
    expect(box().checked).toBe(true);
    expect(macroRow("quick_heal").querySelector(".macro-trigger")?.textContent.trim()).toBe("F13");
  });

  it("binds a keyboard key by capture, as any action's key is", async () => {
    const calls = served();
    mount();
    tab("In-game");
    field<HTMLButtonElement>(macroRow("quick_heal"), "[data-kbm]").click();
    press("KeyN", "keydown");
    press("KeyN", "keyup");
    expect(field(macroRow("quick_heal"), "[data-kbm]").textContent).toBe("N");
    saveButton()?.click();
    await vi.waitFor(() => {
      expect(calls.some((call) => call.path === "/api/actions")).toBe(true);
    });
    expect(calls.find((call) => call.path === "/api/actions")?.body.changes).toEqual({
      quick_heal: { kbm: "KeyN" },
    });
  });

  it("deletes the macro and its action together, when nothing else uses it", async () => {
    const calls = served();
    mount();
    tab("In-game");
    field<HTMLButtonElement>(macroRow("quick_heal"), "[data-macro-remove]").click();
    expect(rows()).toHaveLength(0);
    saveButton()?.click();
    await vi.waitFor(() => {
      expect(calls.some((call) => call.path === "/api/save")).toBe(true);
    });
    expect(calls.find((call) => call.path === "/api/actions")?.body.remove).toEqual(["quick_heal"]);
    const saved = calls.find((call) => call.path === "/api/save")?.body;
    expect(saved?.path).toBe("games/SpaceSims/everspace/macros.yaml");
    expect(saved?.content).toContain("# my macros");
    expect(saved?.content).toContain("macros: {}");
  });

  it("keeps the action when a keypad control sends it, and says so", () => {
    mount();
    dropOnKey("Quick heal", "pinky_5");
    tab("In-game");
    const box = field<HTMLInputElement>(macroRow("quick_heal"), "[data-macro-keypad]");
    // Left sending nothing otherwise: the trigger stays while a control carries it.
    expect(box.disabled).toBe(true);
    field<HTMLButtonElement>(macroRow("quick_heal"), "[data-macro-remove]").click();
    expect(rows()).toHaveLength(0);
    expect(document.querySelector(".ingame-row .who b")?.textContent).not.toBeUndefined();
    const listed = [...document.querySelectorAll(".ingame-row .who b")].map((b) => b.textContent);
    expect(listed).toContain("Quick heal");
  });

  it("offers no Delete for an action a macro types by name, and does for one nothing uses", () => {
    mount(
      payloadWith(
        { quick_heal: { steps: [{ tap: { action: "reload_it" } }] } },
        { spare: { label: "Spare", kbm: "KeyX" } },
      ),
    );
    tab("In-game");
    expect(actionRow("Spare").querySelector(".delete-action")).not.toBeNull();
    expect(actionRow("Reload it").querySelector(".delete-action")).toBeNull();
  });

  it("offers Delete again once the macro no longer types it", () => {
    mount(payloadWith({ quick_heal: { steps: [{ tap: { action: "reload_it" } }] } }));
    tab("In-game");
    expect(actionRow("Reload it").querySelector(".delete-action")).toBeNull();
    typeInto(field<HTMLInputElement>(macroRow("quick_heal"), "[data-macro-keys]"), "H J");
    expect(actionRow("Reload it").querySelector(".delete-action")).not.toBeNull();
  });

  it("keeps the action of a macro another macro types by name, and says why", async () => {
    const calls = served();
    mount(
      payloadWith(
        {
          quick_heal: { steps: [{ tap: { action: "second" } }] },
          second: { steps: [{ tap: "KeyA" }] },
        },
        { second: { label: "Second", key: "F14" } },
      ),
    );
    tab("In-game");
    field<HTMLButtonElement>(macroRow("second"), "[data-macro-remove]").click();
    expect(rows()).toHaveLength(1);
    expect(document.body.textContent).toContain("The action stays: quick_heal types it.");
    saveButton()?.click();
    await vi.waitFor(() => {
      expect(calls.some((call) => call.path === "/api/save")).toBe(true);
    });
    const removed = calls.find((call) => call.path === "/api/actions")?.body.remove;
    expect(removed ?? []).not.toContain("second");
  });

  it("undoes an add", () => {
    served();
    mount();
    tab("In-game");
    addMacroNamed("Burst", "A B");
    expect(rows()).toHaveLength(2);
    field<HTMLButtonElement>(document, "[data-undo]").click();
    expect(rows()).toHaveLength(1);
    expect(saveButton()?.textContent).toBe("Saved");
  });
});

describe("saving macros", () => {
  it("writes the whole patched file through /api/save, after the actions it names", async () => {
    const calls = served();
    mount();
    tab("In-game");
    addMacroNamed("Burst", "A B");
    saveButton()?.click();
    await vi.waitFor(() => {
      expect(calls.some((call) => call.path === "/api/save")).toBe(true);
    });
    expect(calls.map((call) => call.path)).toEqual(["/api/actions", "/api/save"]);
    const add = (calls[0]?.body.add ?? {}) as Record<string, ActionSpec>;
    expect(add.burst).toEqual({ label: "Burst", key: "F14" });
    const saved = calls[1]?.body;
    expect(saved?.path).toBe("games/SpaceSims/everspace/macros.yaml");
    const content = String(saved?.content);
    expect(content).toContain("# my macros");
    expect(content).toContain("quick_heal: [KeyH, KeyJ]");
    expect(content).toContain("burst: [KeyA, KeyB]");
    await vi.waitFor(() => {
      expect(saveButton()?.textContent).toBe("Saved");
    });
  });

  it("saves only what changed: a macros edit alone writes macros.yaml and not the actions", async () => {
    const calls = served();
    mount();
    tab("In-game");
    typeInto(field(macroRow("quick_heal"), "[data-macro-keys]"), "H K", "change");
    saveButton()?.click();
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.path).toBe("/api/save");
    expect(String(calls[0]?.body.content)).toContain("quick_heal: [KeyH, KeyK]");
  });

  it("offers no game update for a macro's trigger: the game is never told it", async () => {
    served();
    mount();
    tab("In-game");
    addMacroNamed("Burst", "A B");
    saveButton()?.click();
    await vi.waitFor(() => {
      expect(saveButton()?.textContent).toBe("Saved");
    });
    expect(document.querySelector(".game-step")).toBeNull();
  });
});

describe("the checks", () => {
  const broken = (): EditorPayload =>
    payloadWith({ quick_heal: { steps: [{ tap: "KeyH" }, { tap: { action: "nope" } }] } });

  it("show a macro's findings in the Checks panel, named for the macro, with no Accept", () => {
    served();
    mount(broken());
    showDockTab("checks");
    const found = [...document.querySelectorAll(".checks .finding")].filter(
      (node) => node.querySelector(".rule")?.textContent === "macro-invalid",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.querySelector("b")?.textContent).toBe("Macro: Quick heal");
    expect(found[0]?.textContent).toContain("no action 'nope'");
    expect(found[0]?.querySelector(".accept-finding")).toBeNull();
    expect(document.querySelector("header .pill.lint")?.classList.contains("bad")).toBe(true);
  });

  it("show the same under the macro on the In-game tab", () => {
    mount(broken());
    tab("In-game");
    expect(macroRow("quick_heal").querySelector(".macro-finding")?.textContent).toContain(
      "no action 'nope'",
    );
  });

  it("find a macro whose action has no button, as it is edited", () => {
    mount();
    tab("In-game");
    const box = field<HTMLInputElement>(macroRow("quick_heal"), "[data-macro-keypad]");
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    // Still started by M: sound.
    expect(macroRow("quick_heal").querySelector(".macro-finding")).toBeNull();
    field<HTMLButtonElement>(
      macroRow("quick_heal"),
      "[data-kbm] + button, .player-bind .btn",
    ).click();
    expect(macroRow("quick_heal").querySelector(".macro-finding")?.textContent).toContain(
      "has no button",
    );
  });

  it("are clean for a sound macro", () => {
    mount();
    showDockTab("checks");
    expect(
      [...document.querySelectorAll(".checks .rule")].filter((node) =>
        node.textContent.startsWith("macro"),
      ),
    ).toEqual([]);
  });
});

describe("a macro's action is never given a game key", () => {
  const padOnly: Record<string, ActionSpec> = {
    pad_macro: { label: "Pad macro", pad: "RB", kbm: "KeyQ" },
    plain: { label: "Plain", kbm: "Enter" },
  };
  const macros: Record<string, MacroDef> = {
    pad_macro: { steps: [{ tap: "KeyA" }] },
  };

  it("takes a trigger when put on a control, where another action takes a pool key", async () => {
    const calls = served();
    mount(payloadWith(macros, padOnly));
    dropOnKey("Pad macro", "pinky_5");
    dropOnKey("Plain", "pinky_4");
    saveButton()?.click();
    await vi.waitFor(() => {
      expect(calls.some((call) => call.path === "/api/actions")).toBe(true);
    });
    const changes = calls.find((call) => call.path === "/api/actions")?.body.changes as Record<
      string,
      Record<string, unknown>
    >;
    // A trigger key, not Insert, the pool's first, and not the KeyQ it is started by.
    expect(changes.pad_macro).toEqual({ key: "F14" });
    expect(changes.plain?.key).toBe("Insert");
  });

  it("takes a trigger in a game the editor cannot write to, where another is sent the game's key", () => {
    served();
    mount(payloadWith(macros, padOnly, false));
    dropOnKey("Pad macro", "pinky_5");
    dropOnKey("Plain", "pinky_4");
    tab("In-game");
    const sent = (label: string): string | null | undefined =>
      [...document.querySelectorAll<HTMLElement>(".ingame-row")]
        .find((node) => node.querySelector(".who b")?.textContent === label)
        ?.querySelector(".key-chip")?.textContent;
    expect(sent("Plain")).toBe("Enter");
    // The macro is not in the list; its trigger is on its own row.
    expect(sent("Pad macro")).toBeUndefined();
    expect(macroRow("pad_macro").querySelector(".macro-trigger")?.textContent.trim()).toBe("F14");
  });

  it("is left on its trigger by Send the game's keys, which moves the others", () => {
    // Quick heal sends F13 and has Enter in the game: as an ordinary action it would be moved.
    const onEnter: Record<string, ActionSpec> = {
      quick_heal: { label: "Quick heal", key: "F13", kbm: "Enter" },
    };
    mount(payloadWith({ quick_heal: { steps: [{ tap: "KeyA" }] } }, onEnter, false));
    dropOnKey("Quick heal", "pinky_5");
    tab("In-game");
    expect(document.querySelector("[data-game-keys]")).toBeNull();
    // The same layout with no macro entry is offered the move.
    mount(payloadWith({}, onEnter, false));
    dropOnKey("Quick heal", "pinky_5");
    tab("In-game");
    expect(document.querySelector("[data-game-keys]")).not.toBeNull();
  });

  it("is not given a usual keyboard key or controller button, and holds none back", () => {
    // Both suggest the same key; the macro comes first, and is skipped (the pad half is in usual.test).
    const usual: Record<string, ActionSpec> = {
      macro_usual: { label: "Macro usual", key: "F14", keyboard: "Enter", xbox: "X" },
      plain_usual: { label: "Plain usual", keyboard: "Enter", xbox: "X" },
    };
    mount(payloadWith({ macro_usual: { steps: [{ tap: "KeyA" }] } }, usual));
    tab("In-game");
    field<HTMLButtonElement>(document, '[data-usual="fill"]').click();
    const macro = macroRow("macro_usual");
    expect(macro.querySelector("[data-kbm]")?.textContent).toBe("—");
    expect(macro.querySelector("[data-pad]")?.textContent).toBe("—");
    const plain = [...document.querySelectorAll<HTMLElement>(".ingame-row")].find(
      (node) => node.querySelector(".who b")?.textContent === "Plain usual",
    );
    expect(plain?.querySelector("[data-kbm]")?.textContent).toBe("Enter");
  });
});
