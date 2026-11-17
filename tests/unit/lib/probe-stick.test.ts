/**
 * The right stick, hard-coded at the device: X written not inverted in every mode, no key swap
 * in any, and a press test that measures the stick as the compiler writes it.
 *
 * The right unit's template carries `invertXAxis: true` beside angle 176. What the press test
 * of 2026-11-11 saw with it -- left and right swapped, up and down true -- is modelled here as
 * `unitReads`: the evidence is that one record, so the model is that one fact and no more.
 */
import { describe, expect, it } from "vitest";

import { compileProfile } from "../../../src/lib/compile.js";
import { loadProfile, loadTemplate } from "../../../src/lib/io.js";
import { checkProfile } from "../../../src/lib/lint.js";
import { Game } from "../../../src/lib/model.js";
import { Device, Profile } from "../../../src/lib/model-core.js";
import {
  buildProbeProfile,
  buildStickCalibrationProfile,
  deviceChanges,
  deviceFromProbe,
  probeDiff,
  probeInvertX,
  readsReversed,
  stickVerdict,
} from "../../../src/lib/probe.js";
import type { ProbeResult } from "../../../src/lib/probe.js";
import { normalizeInvertX } from "../../../src/lib/stick-settings.js";
import { activeAnalogKeys, STICK_DIRECTIONS } from "../../../src/types/azeron.js";
import type { StickDirection } from "../../../src/types/azeron.js";
import type { DeviceData } from "../../../src/types/profile.js";

const game = new Game("games/SpaceSims/everspace");
const RIGHT = "games/SpaceSims/everspace/profiles/akimbo-v10-right.yaml";
const rightData = (): DeviceData => loadProfile(RIGHT, game).device.data;
const template = (): ReturnType<typeof loadTemplate> =>
  loadTemplate("templates/everspace2-akimbo-right.json");

/** The right unit as it was: the key swap, the template's inversion left on, the pointer fixed. */
const OLD: Partial<DeviceData> = {
  stick_directions: { up: "up", right: "left", down: "down", left: "right" },
  stick_invert_x: { mouse: false, xbox: false },
};
/** The right unit now: one fact, every mode. */
const NOW: Partial<DeviceData> = { stick_invert_x: false };

const withData = (extra: Partial<DeviceData>): DeviceData => {
  const { stick_directions: _swap, stick_invert_x: _fact, ...base } = rightData();
  return { ...base, ...extra };
};

/**
 * What the unit does with a stick record, from the one measurement there is: written with
 * `invertXAxis: true` it reads left for right and right for left, up and down true; written
 * with false, everything true. Returns the export field a physical push drives.
 */
function unitReads(invertX: boolean, push: StickDirection): StickDirection {
  if (!invertX) return push;
  return push === "right" ? "left" : push === "left" ? "right" : push;
}

function compiled(extra: Partial<DeviceData>): { analog: Record<string, unknown>; fields: object } {
  const source = loadProfile(RIGHT, game);
  const device = new Device(withData(extra));
  const profile = new Profile(structuredClone(source.data), device, { path: source.path, game });
  const built = compileProfile(profile, { template: template(), actions: game.actions.actions });
  const pin = device.positions.stick?.pin;
  const record = built.profiles[0]?.inputs.find((input) => input.pinOne === pin);
  if (!record?.analogSettings) throw new Error("no stick");
  return { analog: record.analogSettings, fields: activeAnalogKeys(record.analogSettings) };
}

describe("the right stick's keys, before and after the hard-coded fact", () => {
  it("sends the same key for every physical push, with no key swap left", () => {
    const before = compiled(OLD);
    const after = compiled(NOW);
    const keyFor = (built: ReturnType<typeof compiled>, push: StickDirection): unknown => {
      const fields = built.fields as Record<StickDirection, unknown[]>;
      const reported = unitReads(built.analog.invertXAxis === true, push);
      return fields[reported][0];
    };
    for (const push of STICK_DIRECTIONS) {
      expect(keyFor(after, push), push).toBe(keyFor(before, push));
      expect(keyFor(after, push), push).not.toBe(0);
    }
    // The mechanism changed: the template's inversion is off and the keys are where they say.
    expect(before.analog.invertXAxis).toBe(true);
    expect(after.analog.invertXAxis).toBe(false);
    const was = before.fields as Record<StickDirection, unknown[]>;
    const now = after.fields as Record<StickDirection, unknown[]>;
    expect(now.right[0]).toBe(was.left[0]);
    expect(now.left[0]).toBe(was.right[0]);
    expect(now.up[0]).toBe(was.up[0]);
    expect(now.down[0]).toBe(was.down[0]);
  });

  it("is the same one fact in keyboard, pointer and Xbox", () => {
    const device = new Device(withData(NOW));
    expect(device.stickInvertX).toEqual({ keyboard: false, mouse: false, xbox: false });
    expect(device.stickDirections).toEqual({});
    expect(normalizeInvertX(true)).toEqual({ keyboard: true, mouse: true, xbox: true });
    expect(normalizeInvertX(undefined)).toEqual({});
    expect(() => normalizeInvertX({ pointer: false })).toThrow(/stick_invert_x/);
  });

  it("keeps the double-correction error: a swap beside a keyboard X fact", () => {
    const both = withData({ ...NOW, stick_directions: OLD.stick_directions ?? {} });
    const source = loadProfile(RIGHT, game);
    const profile = new Profile(structuredClone(source.data), new Device(both), {
      path: source.path,
      game,
    });
    const found = checkProfile(profile, game.actions, game.lintConfig).filter(
      (finding) => finding.rule === "stick-double-correction",
    );
    expect(found.map((finding) => finding.level)).toEqual(["error"]);
    // And the unit as it is now raises nothing of the kind.
    const clean = new Profile(structuredClone(source.data), new Device(withData(NOW)), {
      path: source.path,
      game,
    });
    expect(
      checkProfile(clean, game.actions, game.lintConfig).filter(
        (finding) => finding.rule === "stick-double-correction",
      ),
    ).toEqual([]);
  });
});

describe("the press test measures the stick as the compiler writes it", () => {
  it("writes the device's X into the probe's stick record, in both passes", () => {
    const pins = buildProbeProfile(template(), { id: "a", name: "p", invertX: false });
    const zero = buildStickCalibrationProfile(template(), { id: "b", name: "z", invertX: false });
    const stick = (doc: typeof pins.doc): boolean | undefined =>
      doc.profiles[0]?.inputs.find((input) => input.pinOne === 31)?.analogSettings?.invertXAxis as
        boolean | undefined;
    expect(stick(pins.doc)).toBe(false);
    expect(stick(zero.doc)).toBe(false);
    expect([pins.invertXWritten, zero.invertXWritten]).toEqual([false, false]);
  });

  it("is the template's own inversion when the device has no fact, and says so", () => {
    const pins = buildProbeProfile(template(), { id: "a", name: "p" });
    expect(pins.invertXWritten).toBe(true);
    expect(probeInvertX(withData({}))).toBeUndefined();
    expect(probeInvertX(withData(NOW))).toBe(false);
    expect(probeInvertX(withData({ stick_invert_x: { mouse: false } }))).toBeUndefined();
  });

  it("reads true on a corrected unit: nothing to save, and it says so", () => {
    const assumed = withData(NOW);
    const result: ProbeResult = {
      pins: {},
      stick: unitResult(false),
      sectors: sectorsFor(false),
      invertXWritten: false,
    };
    expect(readsReversed(result)).toBe(false);
    expect(stickVerdict(assumed, result, "Right")).toBe("Right stick: reads true; Invert X off");
    expect(deviceFromProbe(assumed, result).stick_invert_x).toBe(false);
    expect(deviceFromProbe(assumed, result).stick_directions).toBeUndefined();
    expect(stickNotes(assumed, result)).toEqual([]);
  });

  it("says still reversed when the corrected unit reads reversed, and flips the fact, never a swap", () => {
    const assumed = withData(NOW);
    const result: ProbeResult = {
      pins: {},
      stick: unitResult(true),
      sectors: sectorsFor(true),
      invertXWritten: false,
    };
    expect(readsReversed(result)).toBe(true);
    const verdict = stickVerdict(assumed, result, "Right");
    expect(verdict).toBe("Right stick: X still reversed with Invert X off; saving sets it on");
    expect(verdict).not.toMatch(/reads true/);
    const next = deviceFromProbe(assumed, result);
    expect(next.stick_invert_x).toBe(true);
    expect(next.stick_directions).toBeUndefined();
    expect(stickNotes(assumed, result)).toEqual(["stick: X reads reversed"]);
    expect(deviceChanges(assumed, next)).toContain("stick Invert X: off → on");
  });

  it("keeps a measured swap as a swap on a unit with no keyboard X fact, reversed or not", () => {
    // The right unit as it was: a swap, and a fact for the pointer and Xbox only, so keyboard
    // is the template's own (true) and the probe was written with that. A map with no fact
    // for the mode the test runs in keeps the old behaviour: it is never given one.
    const assumed = withData(OLD);
    const result: ProbeResult = {
      pins: {},
      stick: unitResult(true),
      sectors: sectorsFor(true),
      invertXWritten: probeProfileX(assumed) ?? false,
    };
    expect(probeInvertX(assumed)).toBeUndefined();
    expect(result.invertXWritten).toBe(true);
    const next = deviceFromProbe(assumed, result);
    expect(next.stick_invert_x).toEqual(OLD.stick_invert_x);
    expect(next.stick_directions).toEqual(result.stick);
    // And a map with no fact at all, which reads reversed with the template's X: a swap too.
    const bare = withData({});
    const measured = deviceFromProbe(bare, { ...result, invertXWritten: true });
    expect(measured.stick_invert_x).toBeUndefined();
    expect(measured.stick_directions).toEqual(unitResult(true));
    expect(stickVerdict(bare, { ...result, invertXWritten: true }, "Right")).toMatch(
      /^Right stick: .*left reads right.*; saving swaps those keys$/,
    );
  });

  it("flips only the keyboard entry of a per-mode fact, and keeps a bare boolean bare", () => {
    const perMode = withData({ stick_invert_x: { keyboard: true, mouse: true, xbox: false } });
    const reversed: ProbeResult = {
      pins: {},
      stick: unitResult(true),
      sectors: sectorsFor(true),
      invertXWritten: true,
    };
    const next = deviceFromProbe(perMode, reversed);
    expect(next.stick_invert_x).toEqual({ keyboard: false, mouse: true, xbox: false });
    const line = deviceChanges(perMode, next).find((change) => change.startsWith("stick Invert X"));
    expect(line).toBe(
      "stick Invert X: keyboard on, mouse on, xbox off → keyboard off, mouse on, xbox off",
    );
    // A bare boolean was one fact for every mode, and stays one.
    const bare = withData({ stick_invert_x: true });
    expect(deviceFromProbe(bare, reversed).stick_invert_x).toBe(false);
    // A map and a bare boolean that say the same thing are not a change.
    const same = withData({ stick_invert_x: { keyboard: true, mouse: true, xbox: true } });
    expect(deviceChanges(bare, same)).toEqual([]);
  });

  it("reports and saves nothing about X when what the probe was written with is not known", () => {
    const assumed = withData(NOW);
    const unknown: ProbeResult = {
      pins: {},
      stick: unitResult(true),
      sectors: sectorsFor(true),
      invertXWritten: null,
    };
    expect(readsReversed(unknown)).toBe(true);
    const next = deviceFromProbe(assumed, unknown);
    expect(next.stick_invert_x).toBe(false);
    expect(next.stick_directions).toBeUndefined();
    expect(xChanges(assumed, next)).toEqual([]);
    expect(stickVerdict(assumed, unknown, "Right")).toMatch(
      /^Right stick: X read reversed; not saved.*put it back$/,
    );
    // Told what it was written with, the same reading is judged.
    expect(deviceFromProbe(assumed, { ...unknown, invertXWritten: false }).stick_invert_x).toBe(
      true,
    );
  });

  it("run twice on a reversed stick: the second run, with the probe put back, reads true and saves nothing", () => {
    const first: ProbeResult = {
      pins: {},
      stick: unitResult(true),
      sectors: sectorsFor(true),
      invertXWritten: probeInvertX(withData(NOW)) ?? false,
    };
    const saved = deviceFromProbe(withData(NOW), first);
    expect(saved.stick_invert_x).toBe(true);
    // The probe is put back from the saved map, so it is written with true, and the unit,
    // which reads reversed with false, reads true with true.
    const second: ProbeResult = {
      pins: {},
      stick: unitResult(false),
      sectors: sectorsFor(false),
      invertXWritten: probeInvertX(saved) ?? false,
    };
    expect(second.invertXWritten).toBe(true);
    const again = deviceFromProbe(saved, second);
    expect(again.stick_invert_x).toBe(true);
    expect(xChanges(saved, again)).toEqual([]);
    expect(stickVerdict(saved, second, "Right")).toBe("Right stick: reads true; Invert X on");
  });

  it("run twice without putting the probe back: the old probe is still judged as written", () => {
    // The first run saved true. The probe on the unit is still the one written with false, so
    // it reads reversed again, and the answer is the same true. It is not flipped back to false
    // because the map now says true.
    const saved = withData({ stick_invert_x: true });
    const stale: ProbeResult = {
      pins: {},
      stick: unitResult(true),
      sectors: sectorsFor(true),
      invertXWritten: false,
    };
    expect(deviceFromProbe(saved, stale).stick_invert_x).toBe(true);
    expect(xChanges(saved, deviceFromProbe(saved, stale))).toEqual([]);
  });

  it("judges a reading against what the probe was written with, not the device map", () => {
    // The map says false now. An old probe built on the raw template (true) reads reversed:
    // that says the true setting is wrong, so the fact becomes false, not true.
    const assumed = withData(NOW);
    const old: ProbeResult = {
      pins: {},
      stick: unitResult(true),
      sectors: sectorsFor(true),
      invertXWritten: true,
    };
    expect(deviceFromProbe(assumed, old).stick_invert_x).toBe(false);
    expect(stickVerdict(assumed, old, "Right")).toBe(
      "Right stick: X still reversed with Invert X on; saving sets it off",
    );
  });

  it("never writes a left-right key swap onto a unit that has the fact, whatever it reads", () => {
    const assumed = withData(NOW);
    for (const reversed of [true, false]) {
      const next = deviceFromProbe(assumed, {
        pins: {},
        stick: unitResult(reversed),
        invertXWritten: false,
      });
      expect(next.stick_directions, String(reversed)).toBeUndefined();
    }
    // A turn that is not an X reversal is reported and not saved as a swap either.
    const turned: ProbeResult = {
      pins: {},
      stick: { up: "right", right: "down", down: "left", left: "up" },
      invertXWritten: false,
    };
    expect(deviceFromProbe(assumed, turned).stick_directions).toBeUndefined();
    expect(stickVerdict(assumed, turned, "Right")).toMatch(
      /^Right stick: still reversed \(.*\); not saved$/,
    );
    // A stale swap beside the fact is taken off when the test is saved.
    const stale = withData({ ...NOW, stick_directions: OLD.stick_directions ?? {} });
    expect(
      deviceFromProbe(stale, { pins: {}, stick: unitResult(false), invertXWritten: false })
        .stick_directions,
    ).toBeUndefined();
  });

  it("leaves a unit with no fact as it was: a swap is saved as a swap", () => {
    const assumed = withData({});
    const turned: ProbeResult = {
      pins: {},
      stick: { up: "right", right: "down", down: "left", left: "up" },
    };
    expect(deviceFromProbe(assumed, turned).stick_directions).toEqual(turned.stick);
    expect(stickVerdict(assumed, turned, "Left")).toMatch(/saving swaps those keys$/);
    expect(stickVerdict(assumed, { pins: {}, stick: {} }, "Left")).toBeNull();
  });

  it("does not take a reversed stick for a rotated one in the zero pass", () => {
    const assumed = withData(NOW);
    const result: ProbeResult = {
      pins: {},
      stick: {},
      sectors: sectorsFor(true),
      invertXWritten: false,
    };
    const next = deviceFromProbe(assumed, result);
    expect(next.stick_angle).toBeUndefined();
    expect(readsReversed(result)).toBe(true);
  });
});

/** What saving would change about Invert X or a key swap (the zero pass also writes its own). */
const xChanges = (before: DeviceData, after: DeviceData): string[] =>
  deviceChanges(before, after).filter((change) => /Invert X|^stick:/.test(change));

const stickNotes = (assumed: DeviceData, result: ProbeResult): string[] =>
  probeDiff(assumed, result).filter(
    (note) => note.startsWith("stick") && !note.includes("never fired"),
  );

function unitResult(reversed: boolean): Partial<Record<StickDirection, StickDirection>> {
  return Object.fromEntries(STICK_DIRECTIONS.map((push) => [push, unitReads(reversed, push)]));
}

function sectorsFor(reversed: boolean): NonNullable<ProbeResult["sectors"]> {
  const mirror: Record<string, string> = {
    up: "up",
    up_right: "up_left",
    right: "left",
    down_right: "down_left",
    down: "down",
    down_left: "down_right",
    left: "right",
    up_left: "up_right",
  };
  return Object.fromEntries(
    Object.keys(mirror).map((sector) => [sector, reversed ? mirror[sector] : sector]),
  );
}

function probeProfileX(device: DeviceData): boolean | undefined {
  return buildProbeProfile(template(), {
    id: "a",
    name: "p",
    ...(probeInvertX(device) === undefined ? {} : { invertX: probeInvertX(device) ?? false }),
  }).invertXWritten;
}
