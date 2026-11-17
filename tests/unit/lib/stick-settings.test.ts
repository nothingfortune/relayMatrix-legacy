/**
 * The stick settings the Azeron app's Configurator offers, and the right unit's X.
 *
 * The right unit's template carries `invertXAxis: true` beside an angle of 176. Keyboard
 * mode was put right with `stick_directions` (a key swap); the pointer and an Xbox stick have
 * no keys, so the device map says their X is written as not inverted (`stick_invert_x`). The
 * device here is built in the test, not read from the frozen fixture: its map is a fact about
 * hardware, and these tests say what the compiler does with it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileProfile } from "../../../src/lib/compile.js";
import { decompile } from "../../../src/lib/decompile.js";
import { loadDevice, loadProfile, loadTemplate } from "../../../src/lib/io.js";
import { checkProfile } from "../../../src/lib/lint.js";
import type { Finding } from "../../../src/lib/lint.js";
import { Game } from "../../../src/lib/model.js";
import { Device, Profile } from "../../../src/lib/model-core.js";
import { removeKey } from "../../../src/lib/object.js";
import { stickFlag } from "../../../src/lib/stick-settings.js";
import { activeAnalogKeys } from "../../../src/types/azeron.js";
import type { AnalogSettings, InputRecord } from "../../../src/types/azeron.js";
import type { DeviceData, PositionSpec } from "../../../src/types/profile.js";

const game = new Game("games/SpaceSims/everspace");
const RIGHT = "games/SpaceSims/everspace/profiles/akimbo-v10-right.yaml";
const LEFT = "games/SpaceSims/everspace/profiles/akimbo-v10-left.yaml";

type Hand = "left" | "right";
type Mode = "keyboard" | "mouse" | "xbox";

/** The right unit as it was mapped before one fact replaced the swap (probe-stick.test.ts has the new): the key swap and the pointer and Xbox X. */
function rightDevice(extra: Partial<DeviceData> = {}): Device {
  const base = loadProfile(RIGHT, game).device.data;
  return new Device({
    ...base,
    stick_directions: { up: "up", right: "left", down: "down", left: "right" },
    stick_invert_x: { mouse: false, xbox: false },
    ...extra,
  });
}

function leftDevice(extra: Partial<DeviceData> = {}): Device {
  return new Device({ ...loadProfile(LEFT, game).device.data, ...extra });
}

interface Built {
  analog: AnalogSettings;
  built: ReturnType<typeof compileProfile>;
  profile: Profile;
}

/** Compile a unit's profile with its stick in `mode`, `extra` on the stick, over `device`. */
function build(
  hand: Hand,
  mode: Mode,
  extra: Partial<PositionSpec> = {},
  device: Device = hand === "right" ? rightDevice() : leftDevice(),
  templateEdit: (analog: AnalogSettings) => void = () => undefined,
): Built {
  const source = loadProfile(hand === "right" ? RIGHT : LEFT, game);
  const data = structuredClone(source.data);
  const stick = { ...data.positions.stick, ...extra, mode } as PositionSpec;
  // A stick that sends no keys has no directions to name.
  if (mode !== "keyboard") removeKey(stick, "directions");
  removeKey(stick, "raw");
  data.positions.stick = stick;
  const profile = new Profile(data, device, { path: source.path, game });
  const template = loadTemplate(`templates/everspace2-akimbo-${hand}.json`);
  const pin = device.positions.stick?.pin;
  const held = template.profiles[0]?.inputs.find((input) => input.pinOne === pin)?.analogSettings;
  if (held) templateEdit(held);
  const built = compileProfile(profile, { template, actions: game.actions.actions });
  const record = built.profiles[0]?.inputs.find((input) => input.pinOne === pin);
  if (!record?.analogSettings) throw new Error("no stick");
  return { analog: record.analogSettings, built, profile };
}

describe("the right unit's X, by mode", () => {
  // Left: the template inverts nothing. Right: it inverts X, which keyboard mode corrects
  // with the key swap and the other two modes cannot.
  it.each([
    ["left", "keyboard", false],
    ["left", "mouse", false],
    ["left", "xbox", false],
    ["right", "keyboard", true],
    ["right", "mouse", false],
    ["right", "xbox", false],
  ] as [Hand, Mode, boolean][])("%s unit, %s stick: X inverted is %s", (hand, mode, inverted) => {
    expect(build(hand, mode).analog.invertXAxis).toBe(inverted);
  });

  it("leaves keyboard mode exactly as it was: the swap and the template's inversion", () => {
    const { analog } = build("right", "keyboard");
    const withDevice = activeAnalogKeys(analog);
    // The same layout on a device that has the swap and no per-mode X compiles the same.
    const without = build("right", "keyboard", {}, rightDevice({ stick_invert_x: {} }));
    expect(JSON.stringify(analog)).toBe(JSON.stringify(without.analog));
    // Physical right is written to the export's left field: the swap is at work.
    const physical = loadProfile(RIGHT, game).data.positions.stick?.directions?.right;
    expect(physical).toBeDefined();
    expect(withDevice.left[0]).not.toBe(0);
  });

  it("is the template's own inversion that the device map takes off", () => {
    // Without the device's fact, the right unit's pointer stick carries the template's X.
    expect(
      build("right", "mouse", {}, rightDevice({ stick_invert_x: {} })).analog.invertXAxis,
    ).toBe(true);
  });

  it("lets a layout's invert_x say otherwise, both ways, in every mode", () => {
    expect(build("right", "mouse", { invert_x: true }).analog.invertXAxis).toBe(true);
    expect(build("right", "xbox", { invert_x: true }).analog.invertXAxis).toBe(true);
    expect(build("right", "keyboard", { invert_x: false }).analog.invertXAxis).toBe(false);
    expect(build("left", "mouse", { invert_x: true }).analog.invertXAxis).toBe(true);
    expect(build("left", "keyboard", { invert_x: false }).analog.invertXAxis).toBe(false);
  });

  it("writes Y only where the layout gives it", () => {
    expect(build("right", "mouse").analog.invertYAxis).toBe(false);
    expect(build("right", "mouse", { invert_y: true }).analog.invertYAxis).toBe(true);
    expect(build("left", "keyboard", { invert_y: true }).analog.invertYAxis).toBe(true);
  });

  it("says what a stick holds with nothing set, for the editor to show", () => {
    const base = build("right", "keyboard").analog;
    const device = rightDevice();
    expect(stickFlag("invert_x", {}, base, device.stickInvertX, "mouse")).toBe(false);
    expect(stickFlag("invert_x", {}, base, device.stickInvertX, "keyboard")).toBe(true);
    expect(stickFlag("invert_x", { invert_x: false }, base, device.stickInvertX, "keyboard")).toBe(
      false,
    );
  });
});

describe("the device map's stick_invert_x", () => {
  it("loads through the real loader, and refuses a mode or value it does not know", () => {
    const dir = mkdtempSync(join(tmpdir(), "azeron-invert-"));
    try {
      const good = join(dir, "good.yaml");
      writeFileSync(
        good,
        "device: x\npositions: {}\nstick_invert_x:\n  mouse: false\n  xbox: false\n",
      );
      expect(loadDevice(good).stickInvertX).toEqual({ mouse: false, xbox: false });
      const bad = join(dir, "bad.yaml");
      writeFileSync(bad, "device: x\npositions: {}\nstick_invert_x:\n  pointer: false\n");
      expect(() => loadDevice(bad)).toThrow(/stick_invert_x/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is kept by a decompile that would otherwise lose an export's inversion", () => {
    const device = rightDevice();
    // A right-unit export with an Xbox stick that is X-inverted on purpose.
    const inverted = build("right", "xbox", { invert_x: true });
    const data = decompile(inverted.built, device);
    expect(data.positions.stick?.invert_x).toBe(true);
    // ...and it rebuilds to the same stick.
    const again = new Profile(data, device, { path: "x.yaml", game });
    const template = loadTemplate("templates/everspace2-akimbo-right.json");
    const rebuilt = compileProfile(again, { template, actions: game.actions.actions });
    const pin = device.positions.stick?.pin;
    const stick = (document: typeof rebuilt): InputRecord | undefined =>
      document.profiles[0]?.inputs.find((input) => input.pinOne === pin);
    expect(stick(rebuilt)?.analogSettings?.invertXAxis).toBe(true);
    // An export that agrees with the device says nothing.
    const quiet = decompile(build("right", "xbox").built, device);
    expect(quiet.positions.stick?.invert_x).toBeUndefined();
  });
});

describe("the other Configurator settings", () => {
  it("writes each one to the field the app stores it in", () => {
    const { analog } = build("left", "keyboard", {
      angle: -45,
      angle_lock: true,
      lock_zone_angle: 60,
      lock_zone_size: 20,
      trigger_magnitude: 3,
      hold_threshold: true,
      hold_magnitude: 7,
      hold_key: "ShiftLeft",
      analog_throttle: 12,
      analog_smoothing: false,
    });
    expect(analog).toMatchObject({
      angle: -45,
      isAngleLock: true,
      lockZoneAngle: 60,
      lockZoneSize: 20,
      triggerMagnitude: 3,
      isHoldTrigger: true,
      holdMagnitude: 7,
      holdType: "1",
      holdKeyValues: ["ShiftLeft", "0", "0"],
      analogThrottle: 12,
      isAnalogSmoothing: false,
    });
  });

  it("leaves what the layout does not give as the template had it", () => {
    const { analog } = build("right", "keyboard", { trigger_magnitude: 5 });
    expect(analog).toMatchObject({
      angle: 176,
      isAngleLock: false,
      lockZoneAngle: 70,
      holdMagnitude: 9,
      isHoldTrigger: false,
      analogThrottle: 0,
      isAnalogSmoothing: true,
      rotateStickButtonId: 0,
      triggerMagnitude: 5,
    });
  });

  it("puts a layout's angle over the device's stick_angle, which is over the template's", () => {
    expect(build("right", "mouse").analog.angle).toBe(176);
    expect(build("right", "mouse", {}, rightDevice({ stick_angle: 170 })).analog.angle).toBe(170);
    expect(
      build("right", "mouse", { angle: 150 }, rightDevice({ stick_angle: 170 })).analog.angle,
    ).toBe(150);
  });

  it("refuses a value outside the app's range, naming the field", () => {
    expect(() => build("left", "keyboard", { angle: 181 })).toThrow(
      /angle 181 is not a whole number from -180 to 180/,
    );
    expect(() => build("left", "keyboard", { trigger_magnitude: 0 })).toThrow(/1 to 9/);
    expect(() => build("left", "keyboard", { hold_magnitude: 10 })).toThrow(/1 to 9/);
    expect(() => build("left", "keyboard", { lock_zone_size: 5 })).toThrow(/10 to 90/);
    expect(() => build("left", "keyboard", { analog_throttle: 51 })).toThrow(/0 to 50/);
    expect(() => build("left", "keyboard", { angle: 1.5 })).toThrow(/whole number/);
    expect(() => build("left", "keyboard", { hold_key: "Nope" })).toThrow(/hold_key/);
  });

  it("treats the throttle and smoothing as the one choice the app does", () => {
    // The right template has smoothing on: a throttle needs it off in the same breath.
    expect(() => build("right", "keyboard", { analog_throttle: 5 })).toThrow(/smoothing is on/);
    expect(
      build("right", "keyboard", { analog_throttle: 5, analog_smoothing: false }).analog,
    ).toMatchObject({ analogThrottle: 5, isAnalogSmoothing: false });
    // A template that already holds both is not the layout's doing, and still builds.
    expect(() =>
      build("left", "keyboard", {}, leftDevice(), (analog) => {
        analog.analogThrottle = 5;
        analog.isAnalogSmoothing = true;
      }),
    ).not.toThrow();
  });

  it("files a counter strafe by the button's record id, which is what the app logs", () => {
    const device = leftDevice();
    const pin = device.positions.index_side?.pin;
    const template = loadTemplate("templates/everspace2-akimbo-left.json");
    const id = template.profiles[0]?.inputs.find((input) => input.pinOne === pin)?.id;
    expect(id).toBeGreaterThan(0);
    expect(
      build("left", "keyboard", { counter_strafe: "index_side" }).analog.rotateStickButtonId,
    ).toBe(id);
    expect(
      build("left", "keyboard", {
        counter_strafe: null,
      }).analog.rotateStickButtonId,
    ).toBe(0);
    expect(() => build("left", "keyboard", { counter_strafe: "nowhere" })).toThrow(/not a button/);
    expect(() => build("left", "keyboard", { counter_strafe: "stick" })).toThrow(/not a button/);
  });
});

describe("what the linter says", () => {
  const check = (profile: Profile): Finding[] =>
    checkProfile(profile, game.actions, game.lintConfig);
  const rule = (findings: Finding[], name: string): Finding[] =>
    findings.filter((finding) => finding.rule === name);

  it("errors on a device that swaps left and right and also sets the keyboard's X", () => {
    const device = rightDevice({ stick_invert_x: { keyboard: false } });
    const { profile } = build("right", "keyboard", {}, device);
    const found = rule(check(profile), "stick-double-correction");
    expect(found.map((finding) => finding.level)).toEqual(["error"]);
    expect(found[0]?.message).toContain("stick_invert_x");
  });

  it("warns on a layout that sets invert_x on a keyboard stick the device already swaps", () => {
    const { profile } = build("right", "keyboard", { invert_x: false });
    const found = rule(check(profile), "stick-double-correction");
    expect(found.map((finding) => [finding.level, finding.position])).toEqual([
      ["warning", "stick"],
    ]);
    // A pointer stick has no swap to double, nor does a unit that does not swap.
    expect(
      rule(check(build("right", "mouse", { invert_x: true }).profile), "stick-double-correction"),
    ).toEqual([]);
    expect(
      rule(check(build("left", "keyboard", { invert_x: true }).profile), "stick-double-correction"),
    ).toEqual([]);
    expect(rule(check(build("right", "keyboard").profile), "stick-double-correction")).toEqual([]);
  });

  it("warns on a hold magnitude below the trigger magnitude", () => {
    const low = build("left", "keyboard", { trigger_magnitude: 6, hold_magnitude: 4 });
    expect(rule(check(low.profile), "stick-magnitude-order")).toHaveLength(1);
    const fine = build("left", "keyboard", { trigger_magnitude: 4, hold_magnitude: 4 });
    expect(rule(check(fine.profile), "stick-magnitude-order")).toEqual([]);
  });
});
