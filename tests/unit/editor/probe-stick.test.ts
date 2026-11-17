// @vitest-environment happy-dom
/**
 * The press test's stick, as the page shows it: a push the unit called something else is wrong
 * (red, with what it read), never done (green); a reversed X is said once, plainly, with what
 * saving does; and both units' pushes carry the same words.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { start } from "../../../src/editor/probe.js";
import { loadDevice, loadTemplate } from "../../../src/lib/io.js";
import { buildProbeProfile, buildStickCalibrationProfile } from "../../../src/lib/probe.js";
import type { CapturedUnit, ProbePayload } from "../../../src/types/probe.js";

function buildPayloadOnce(): ProbePayload {
  const left = loadDevice("cyborg2-left");
  const right = loadDevice("cyborg2-right");
  const template = loadTemplate("templates/everspace2-v5.json");
  const { assignments } = buildProbeProfile(template, {
    id: "00000000-0000-4000-8000-000000000000",
    name: "PROBE",
    unknownPins: [...left.unknownPins],
  });
  const calibration = buildStickCalibrationProfile(template, {
    id: "00000000-0000-4000-8000-000000000001",
    name: "PROBE stick",
  });
  return {
    generatedAt: new Date().toISOString(),
    profileName: "PROBE",
    devices: { "cyborg2-left": left.data, "cyborg2-right": right.data },
    units: [
      { hand: "left", device: "cyborg2-left" },
      { hand: "right", device: "cyborg2-right" },
    ],
    assignments,
    stickAssignments: calibration.assignments,
  };
}

const PAYLOAD = buildPayloadOnce();
let probePayload: ProbePayload;

const MIRROR: Record<string, string> = {
  up: "up",
  up_right: "up_left",
  right: "left",
  down_right: "down_left",
  down: "down",
  down_left: "down_right",
  left: "right",
  up_left: "up_right",
};

function press(code: string): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  document.body.innerHTML = '<div id="app"></div>';
  probePayload = structuredClone(PAYLOAD);
  // The right unit as the device map now has it: X hard-coded off, so the probe was written
  // with it off and what it reads is the unit's own.
  const right = probePayload.devices["cyborg2-right"];
  if (right) right.stick_invert_x = false;
  const unit = probePayload.units[1];
  if (unit) unit.invertXWritten = false;
  start(probePayload);
});

afterEach(() => {
  vi.useRealTimers();
});

function pickUnit(index: number): void {
  const unitSelect = document.querySelector<HTMLSelectElement>(".probe-bar select");
  if (!unitSelect) throw new Error("no unit selector");
  unitSelect.value = String(index);
  unitSelect.dispatchEvent(new Event("change"));
}

/** Hold every push in the zero pass, the unit reporting `report(push)`. */
function holdAll(report: (push: string) => string): void {
  const zeroTab = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Stick zero",
  );
  zeroTab?.click();
  for (const push of Object.keys(MIRROR)) {
    const entry = probePayload.stickAssignments.find((item) => item.sector === report(push));
    if (!entry) throw new Error(`no key for ${report(push)}`);
    press(entry.key);
    vi.advanceTimersByTime(800);
  }
}

/** The right unit's readings as the page has kept them. */
function stored(): CapturedUnit {
  const all = JSON.parse(localStorage.getItem("azeron-probe-v1") ?? "{}") as Record<
    string,
    CapturedUnit
  >;
  return all.right ?? { pins: {}, stick: {} };
}

const notes = (): string =>
  [...document.querySelectorAll(".note")].map((node) => node.textContent).join(" | ");

describe("a stick that reads backwards is shown as wrong, never as done", () => {
  it("says X reads reversed in the zero pass, not that zero is where it should be", () => {
    pickUnit(1);
    holdAll((push) => MIRROR[push] ?? push);
    expect(notes()).toContain("X reads reversed");
    expect(notes()).not.toContain("Zero is where the software assumes");
  });

  it("says it in one line per unit, with what saving does", () => {
    pickUnit(1);
    holdAll((push) => MIRROR[push] ?? push);
    expect(notes()).toContain("Right stick: X still reversed with Invert X off; saving sets it on");
    expect(document.querySelector(".note.bad")?.textContent).toContain("still reversed");
  });

  it("says reads true when the unit reads true", () => {
    pickUnit(1);
    holdAll((push) => push);
    expect(notes()).toContain("Right stick: reads true; Invert X off");
    expect(document.querySelector(".note.bad")).toBeNull();
  });

  it("marks a push the unit called something else, in red with what it read", () => {
    const skip = (): void => {
      [...document.querySelectorAll("button")].find((b) => b.textContent === "Skip")?.click();
    };
    for (let i = 0; i < 40; i += 1) {
      if (document.querySelector(".prompt b")?.textContent.includes("stick RIGHT")) break;
      skip();
    }
    const leftKey = probePayload.assignments.find(
      (item) => item.kind === "stick" && item.direction === "left",
    )?.key;
    press(leftKey ?? "");
    vi.advanceTimersByTime(800);
    const right = document.querySelector(".active-hand .stick-dial .dir.right");
    expect(right?.classList.contains("wrong")).toBe(true);
    expect(right?.classList.contains("done")).toBe(false);
    expect(right?.querySelector(".push")?.textContent).toBe("right");
    expect(right?.querySelector(".pin")?.textContent).toBe("reads left");
  });

  it("words both units' pushes the same: away, right, toward, left", () => {
    const words = (hand: number): string[] =>
      [...(document.querySelectorAll(".hand")[hand]?.querySelectorAll(".stick-dial .dir") ?? [])]
        .filter((cell) => !cell.classList.contains("hub"))
        .map(
          (cell) =>
            `${cell.className.split(" ")[1] ?? ""}:${cell.querySelector(".push")?.textContent ?? ""}`,
        )
        .sort();
    expect(words(1)).toEqual(words(0));
    expect(words(0)).toEqual(["down:toward", "left:left", "right:right", "up:away"]);
  });
});

describe("the X a result is judged against is the unit's own probe's", () => {
  const restart = (
    writtenX: (hand: string) => boolean | null,
    save?: (path: string, content: string) => void,
  ): void => {
    document.body.innerHTML = '<div id="app"></div>';
    localStorage.clear();
    start(probePayload, undefined, { writtenX, ...(save === undefined ? {} : { save }) });
  };

  /** Hold the zero pass's first pushes, in order, the unit reporting each as given. */
  const holdFirst = (reports: string[]): void => {
    for (const report of reports) {
      const entry = probePayload.stickAssignments.find((item) => item.sector === report);
      if (!entry) throw new Error(`no key for ${report}`);
      press(entry.key);
      vi.advanceTimersByTime(800);
    }
  };
  const openZero = (): void => {
    pickUnit(1);
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Stick zero")
      ?.click();
  };

  it("saves no X change from a reversed reading when the unit's probe was not read", () => {
    const saved: string[] = [];
    restart(
      () => null,
      (_path, content) => saved.push(content),
    );
    window.confirm = vi.fn(() => true);
    pickUnit(1);
    // One position pressed first: the map cannot be saved from a stick alone.
    const button = probePayload.assignments.find((item) => item.kind === "button");
    press(button?.key ?? "");
    vi.advanceTimersByTime(800);
    holdAll((push) => MIRROR[push] ?? push);
    // Each unit has its own Save: this is the right unit's, the second.
    [...document.querySelectorAll("button")]
      .filter((control) => control.textContent === "Save its map")
      .at(1)
      ?.click();
    // The map said false and still does; a flip to true would be a guess.
    expect(saved).toHaveLength(1);
    for (const content of saved) {
      expect(content).toMatch(/^stick_invert_x: false$/m);
      expect(content).not.toMatch(/^stick_invert_x: true$/m);
    }
  });

  it("drops readings taken on a probe that has since been put back with another X", () => {
    let held: boolean | null = null;
    restart(() => held);
    openZero();
    // Seven pushes, the unit mirroring each: left and right are both in.
    holdFirst(["up", "up_left", "left", "down_left", "down", "down_right", "right"]);
    expect(Object.keys(stored().sectors ?? {})).toHaveLength(7);
    expect(notes()).toMatch(/Right stick: X read reversed; not saved/);
    // The probe is taken off and put back, and now it is known to carry false. Nothing is
    // judged against it from the old readings.
    held = false;
    expect(notes()).toMatch(/Right stick: X read reversed; not saved/);
    expect(notes()).not.toContain("saving sets it on");
    // The next push is on the new probe: the old ones are dropped, not carried over.
    holdFirst(["up_right"]);
    expect(Object.keys(stored().sectors ?? {})).toEqual(["up_left"]);
    expect(stored().stickX).toBe(false);
    expect(document.body.textContent).toContain("were dropped");
  });

  it("uses what the unit holds, over what the device map would write now", () => {
    // The payload says false (the map's fact); the probe on the unit was written with true.
    restart(() => true);
    pickUnit(1);
    holdAll((push) => MIRROR[push] ?? push);
    expect(notes()).toContain("Right stick: X still reversed with Invert X on; saving sets it off");
  });

  it("says it is not known, and saves no X, when the unit's probe was not read", () => {
    restart(() => null);
    pickUnit(1);
    holdAll((push) => MIRROR[push] ?? push);
    expect(notes()).toMatch(/Right stick: X read reversed; not saved.*put it back/);
    expect(notes()).not.toContain("saving sets it");
    expect(document.querySelector(".note.bad")?.textContent).toContain("not saved");
  });
});
