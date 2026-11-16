// @vitest-environment happy-dom
/**
 * The Key panel's Tuning section for a stick: the Azeron app's Configurator, setting by
 * setting. Each shows what the stick holds now (the layout, else the device's map, else the
 * template) and writes only what the owner changes. The fixture's right unit says its
 * pointer and Xbox sticks are written with X not inverted; its template inverts X.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { start } from "../../../src/editor/app.js";
import { buildPayload } from "../../../src/lib/editor/payload.js";
import { LIVE_SET } from "../../helpers/fixtures.js";

const PAYLOAD = buildPayload();

function mount(): void {
  const payload = structuredClone(PAYLOAD);
  const game = payload.games[0];
  if (game === undefined) throw new Error("no game");
  // Everspace 2 requires a keyboard stick; the modes are what these tests are about.
  game.lintConfig = { ...game.lintConfig, require_keyboard_stick: false };
  document.body.innerHTML = '<div id="app"></div>';
  start(payload);
  const select = document.querySelectorAll<HTMLSelectElement>("header select")[0];
  if (select && select.value !== LIVE_SET) {
    select.value = LIVE_SET;
    select.dispatchEvent(new Event("change"));
  }
}

/** Open a hand's stick: 0 is the left unit, 1 the right. */
function openStick(hand: 0 | 1): void {
  const dial = document.querySelectorAll<HTMLElement>(".stick-dial")[hand];
  const up = dial?.querySelector<HTMLButtonElement>(".dir.up");
  if (!up) throw new Error("no stick dial");
  up.click();
}

function setMode(mode: string): void {
  const select = document.querySelector<HTMLSelectElement>("select[data-stick-mode=select]");
  if (!select) throw new Error("no mode select");
  select.value = mode;
  select.dispatchEvent(new Event("change"));
}

const tuning = (field: string): HTMLInputElement | HTMLSelectElement | null =>
  document.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-tuning=${field}]`);

const firstOption = (field: string): string =>
  (tuning(field) as HTMLSelectElement | null)?.options[0]?.textContent ?? "no such control";

function choose(field: string, value: string): void {
  const control = tuning(field);
  if (!control) throw new Error(`no ${field}`);
  control.value = value;
  control.dispatchEvent(new Event("change"));
}

beforeEach(mount);

describe("a stick's X inversion, shown as it will be written", () => {
  it("is on for the right unit's keyboard stick and off for its pointer and Xbox sticks", () => {
    openStick(1);
    expect(firstOption("invert_x")).toBe("As it is (on)");
    setMode("mouse");
    expect(firstOption("invert_x")).toBe("As it is (off)");
    setMode("xbox");
    expect(firstOption("invert_x")).toBe("As it is (off)");
  });

  it("is off in every mode of the left unit", () => {
    openStick(0);
    expect(firstOption("invert_x")).toBe("As it is (off)");
    setMode("mouse");
    expect(firstOption("invert_x")).toBe("As it is (off)");
  });

  it("says so in the tuning summary once the owner changes it, and can go back to as it is", () => {
    openStick(1);
    setMode("mouse");
    expect(document.querySelector(".stick-tuning summary")?.textContent).toBe("Tuning");
    choose("invert_x", "on");
    expect((tuning("invert_x") as HTMLSelectElement).value).toBe("on");
    expect(document.querySelector(".stick-tuning summary")?.textContent).toBe("Tuning (changed)");
    choose("invert_x", "");
    expect((tuning("invert_x") as HTMLSelectElement).value).toBe("");
    expect(document.querySelector(".stick-tuning summary")?.textContent).toBe("Tuning");
  });
});

describe("what appears in each mode, as the app's tabs have it", () => {
  it("offers the cones and trigger magnitude for keys, and no lock zone until the lock is on", () => {
    openStick(0);
    expect(tuning("cone_vertical")).not.toBeNull();
    expect(tuning("trigger_magnitude")).not.toBeNull();
    expect(tuning("lock_zone_angle")).toBeNull();
    choose("angle_lock", "on");
    expect(tuning("lock_zone_angle")).not.toBeNull();
    expect(tuning("lock_zone_size")).not.toBeNull();
  });

  it("leaves out the threshold and cones for the pointer, and the trigger magnitude for an Xbox stick", () => {
    openStick(0);
    setMode("mouse");
    expect(tuning("threshold")).toBeNull();
    expect(tuning("cone_vertical")).toBeNull();
    expect(tuning("trigger_magnitude")).not.toBeNull();
    setMode("xbox");
    expect(tuning("trigger_magnitude")).toBeNull();
    expect(tuning("angle_lock")).toBeNull();
    expect(tuning("threshold")).not.toBeNull();
    // Both still invert and angle.
    expect(tuning("invert_y")).not.toBeNull();
    expect(tuning("angle")).not.toBeNull();
  });

  it("asks for a hold magnitude and key only while the hold threshold is on", () => {
    openStick(0);
    expect(tuning("hold_magnitude")).toBeNull();
    expect(tuning("hold_key")).toBeNull();
    choose("hold_threshold", "on");
    expect(tuning("hold_magnitude")).not.toBeNull();
    expect(tuning("hold_key")).not.toBeNull();
  });
});

describe("angle, throttle and counter strafe", () => {
  it("shows the template's angle where the layout is silent", () => {
    openStick(1);
    expect((tuning("angle") as HTMLInputElement).placeholder).toBe("176");
    choose("angle", "170");
    expect((tuning("angle") as HTMLInputElement).value).toBe("170");
    // Out of range is refused and the box goes back.
    choose("angle", "400");
    expect((tuning("angle") as HTMLInputElement).value).toBe("170");
  });

  it("keeps the throttle off while smoothing is on, as the app does", () => {
    openStick(1);
    // The right template smooths.
    expect(firstOption("analog_smoothing")).toBe("As it is (on)");
    expect((tuning("analog_throttle") as HTMLInputElement).disabled).toBe(true);
    choose("analog_smoothing", "off");
    expect((tuning("analog_throttle") as HTMLInputElement).disabled).toBe(false);
  });

  it("marks the counter strafe as one the app warns about, and offers the unit's buttons", () => {
    openStick(0);
    const select = tuning("counter_strafe") as HTMLSelectElement;
    expect(select.options[0]?.textContent).toBe("As it is (none)");
    expect(select.options[1]?.textContent).toBe("None");
    expect(select.options.length).toBeGreaterThan(20);
    expect(document.querySelector(".unsafe")?.getAttribute("title")).toContain("online play");
    const target = [...select.options].find((option) => option.value === "index_side");
    expect(target).toBeDefined();
    choose("counter_strafe", "index_side");
    expect((tuning("counter_strafe") as HTMLSelectElement).value).toBe("index_side");
    choose("counter_strafe", "none");
    expect((tuning("counter_strafe") as HTMLSelectElement).value).toBe("none");
  });
});
