/**
 * The genre defaults on the Setup tab: the Xbox pad and the pair of units, drawn without
 * starting a game.
 *
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from "vitest";

import { start } from "../../../src/editor/app.js";
import { resetDefaultsView } from "../../../src/editor/defaults-view.js";
import { buildPayload } from "../../../src/lib/editor/payload.js";

const PAYLOAD = buildPayload();
const SERVED = window as unknown as { AZERON_SERVED?: boolean };

function mount(served = false): void {
  SERVED.AZERON_SERVED = served;
  document.body.innerHTML = '<div id="app"></div>';
  start(structuredClone(PAYLOAD));
  tab("Setup");
}

function tab(name: string): void {
  const found = [...document.querySelectorAll<HTMLButtonElement>("header .tabs button")].find(
    (button) => button.textContent === name,
  );
  if (!found) throw new Error(`no tab ${name}`);
  found.click();
}

function choose(which: "genre" | "style", value: string): void {
  const select = document.querySelector<HTMLSelectElement>(`[data-defaults="${which}"]`);
  if (!select) throw new Error(`no ${which} select`);
  select.value = value;
  select.dispatchEvent(new Event("change"));
}

const view = (): Element | null => document.querySelector('[data-defaults="view"]');
/** What the pad's control says is on it: its action's label. */
const onPad = (control: string): string | null => {
  const key = [...document.querySelectorAll(".pad-board .device-key")].find(
    (node) => node.querySelector(".device-key-name")?.textContent === control,
  );
  return key?.querySelector(".device-key-action")?.textContent ?? null;
};

afterEach(() => {
  SERVED.AZERON_SERVED = false;
  resetDefaultsView();
});

describe("the defaults on the Setup tab", () => {
  it("draws the genre's Xbox pad with each control labelled by its action", () => {
    mount();
    expect(view()).not.toBeNull();
    const genre = PAYLOAD.genres[0];
    expect(genre?.defaults?.genre).toBe(genre?.name);
    expect(onPad("A")).toBe("Jump");
    expect(onPad("RT")).toBe("Fire");
    expect(onPad("Left stick up")).toBe("Move forward");
  });

  it("draws the pair of units in the layout chosen, with the genre's actions placed", () => {
    mount();
    expect(view()?.querySelectorAll(".hand")).toHaveLength(2);
    const keys = [...(view()?.querySelectorAll(".hand .key .name") ?? [])].map(
      (node) => node.textContent,
    );
    expect(keys).toContain("Jump");
    expect(keys).toContain("Fire");
    // The stick is drawn as a dial, each direction with its action.
    const dirs = [...(view()?.querySelectorAll(".stick-dial .dir .name") ?? [])].map(
      (node) => node.textContent,
    );
    expect(dirs).toContain("Move forward");
  });

  it("draws one unit for the one-unit layout, and changes with the genre", () => {
    mount();
    choose("style", "default");
    expect(view()?.querySelectorAll(".hand")).toHaveLength(1);
    const other = PAYLOAD.genres[1]?.name ?? "";
    choose("genre", other);
    expect(document.querySelector<HTMLSelectElement>('[data-defaults="genre"]')?.value).toBe(other);
    // A new genre opens on its first layout again.
    expect(view()?.querySelectorAll(".hand")).toHaveLength(2);
  });

  it("lists what the pad has no control for", () => {
    mount();
    const off = document.querySelector('[data-defaults="off-pad"]')?.textContent ?? "";
    expect(off).toContain("Prone");
  });

  it("is read only: there is nothing to edit and the page is not marked unsaved", () => {
    mount();
    expect(view()?.querySelector("input, textarea")).toBeNull();
    expect(view()?.querySelectorAll("button")).toHaveLength(0);
    expect(document.querySelector(".unsaved, [data-unsaved]")).toBeNull();
  });

  it("offers no way to start a game when the editor cannot save", () => {
    mount(false);
    expect(view()).not.toBeNull();
    expect(document.querySelector('[data-defaults="start"]')).toBeNull();
  });

  it("starts the new-game form on this genre and layout when served", () => {
    mount(true);
    const genre = PAYLOAD.genres[1]?.name ?? "";
    choose("genre", genre);
    document.querySelector<HTMLButtonElement>('[data-defaults="start"]')?.click();
    expect(document.querySelector<HTMLSelectElement>('[data-new-game="genre"]')?.value).toBe(genre);
    const style = PAYLOAD.genres[1]?.styles?.[0]?.name ?? "";
    expect(
      document.querySelector<HTMLInputElement>(`[data-new-game-style="${style}"]`)?.checked,
    ).toBe(true);
  });

  it("has no start button for the one-unit layout, which is not a style", () => {
    mount(true);
    choose("style", "default");
    expect(document.querySelector('[data-defaults="start"]')).toBeNull();
  });

  it("says why a layout cannot be drawn, and draws the rest of the page", () => {
    SERVED.AZERON_SERVED = false;
    const payload = structuredClone(PAYLOAD);
    const defaults = payload.genres[0]?.defaults;
    const controller = defaults?.styles.find((style) => style.name === "controller");
    if (controller) controller.error = "A and B are both on X";
    document.body.innerHTML = '<div id="app"></div>';
    start(payload);
    tab("Setup");
    expect(document.querySelector('[data-defaults="error"]')?.textContent).toBe(
      "A and B are both on X",
    );
    expect(view()?.querySelector(".pad-board")).not.toBeNull();
  });
});

describe("the games gallery", () => {
  it("has a Defaults card that opens the Setup tab on the view", () => {
    SERVED.AZERON_SERVED = false;
    document.body.innerHTML = '<div id="app"></div>';
    start(structuredClone(PAYLOAD), { firstScreen: "games" });
    document.querySelector<HTMLButtonElement>("[data-defaults-card]")?.click();
    expect(view()).not.toBeNull();
  });
});
