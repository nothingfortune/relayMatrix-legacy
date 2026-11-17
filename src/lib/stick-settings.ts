/**
 * The stick settings the Azeron app's Configurator offers beside the deadzones, cones and
 * pointer speed: its angle, the two inversions, angle lock, the trigger and hold
 * magnitudes, the analog throttle and smoothing, and the counter strafe button.
 *
 * Each is a field of a stick's YAML (`angle`, `invert_x`, ...) mapped onto one field of the
 * export's `analogSettings`, and each is written only where the YAML gives it: a stick that
 * says nothing keeps what its template has. The labels and ranges are the app's own, read
 * from its interface code on 2026-11-15. Node-free, so the editor shows exactly what the
 * compiler will write.
 */

import type { AnalogSettings } from "../types/azeron.js";
import type { PositionSpec } from "../types/profile.js";
import { DEVICE_KEY_CODES } from "./unitproto.js";

export class StickSettingError extends Error {}

/** A stick mode as `PositionSpec.mode` names it. */
export type StickModeName = "keyboard" | "mouse" | "xbox";

export type StickNumberField =
  | "angle"
  | "trigger_magnitude"
  | "hold_magnitude"
  | "lock_zone_angle"
  | "lock_zone_size"
  | "analog_throttle";

export type StickFlagField =
  "invert_x" | "invert_y" | "angle_lock" | "hold_threshold" | "analog_smoothing";

export interface StickNumberSetting {
  field: StickNumberField;
  /** The `analogSettings` field it is written to. */
  key: string;
  low: number;
  high: number;
  /** What the unit holds when nothing else says, for the editor's placeholder. */
  fallback: number;
}

/** The app's sliders: the angle -180 to 180, magnitudes 1 to 9, lock zone 10 to 90, throttle 0 to 50. */
export const STICK_NUMBER_SETTINGS: readonly StickNumberSetting[] = [
  { field: "angle", key: "angle", low: -180, high: 180, fallback: 0 },
  { field: "trigger_magnitude", key: "triggerMagnitude", low: 1, high: 9, fallback: 4 },
  { field: "hold_magnitude", key: "holdMagnitude", low: 1, high: 9, fallback: 9 },
  { field: "lock_zone_angle", key: "lockZoneAngle", low: 10, high: 90, fallback: 70 },
  { field: "lock_zone_size", key: "lockZoneSize", low: 10, high: 90, fallback: 30 },
  { field: "analog_throttle", key: "analogThrottle", low: 0, high: 50, fallback: 0 },
];

export const STICK_FLAG_SETTINGS: readonly { field: StickFlagField; key: string }[] = [
  { field: "invert_x", key: "invertXAxis" },
  { field: "invert_y", key: "invertYAxis" },
  { field: "angle_lock", key: "isAngleLock" },
  { field: "hold_threshold", key: "isHoldTrigger" },
  { field: "analog_smoothing", key: "isAnalogSmoothing" },
];

/** Every field this module owns, for a caller that has to clear or list them. */
export const STICK_SETTING_FIELDS: readonly (keyof PositionSpec)[] = [
  ...STICK_NUMBER_SETTINGS.map((setting) => setting.field),
  ...STICK_FLAG_SETTINGS.map((setting) => setting.field),
  "hold_key",
  "counter_strafe",
];

/** The device's per-mode X inversion (`stick_invert_x`), or nothing. */
export type InvertXByMode = Partial<Record<string, boolean>>;

function whole(position: string, field: string, value: unknown, low: number, high: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high) {
    throw new StickSettingError(
      `${position}: ${field} ${String(value)} is not a whole number from ${String(low)} to ${String(high)}`,
    );
  }
  return value;
}

function flag(position: string, field: string, value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new StickSettingError(`${position}: ${field} must be true or false`);
  }
  return value;
}

/**
 * What a switch holds once the layout, the device and the template have had their say, in
 * that order. `invert_x` is the only one a device speaks for: its map may say a mode's X
 * needs writing as not inverted (`stick_invert_x`).
 */
export function stickFlag(
  field: StickFlagField,
  spec: PositionSpec,
  base: AnalogSettings | undefined,
  invertXByMode: InvertXByMode,
  mode: string,
): boolean {
  const given = spec[field];
  if (given !== undefined) return given;
  if (field === "invert_x") {
    const fromDevice = invertXByMode[mode];
    if (fromDevice !== undefined) return fromDevice;
  }
  const key = STICK_FLAG_SETTINGS.find((setting) => setting.field === field)?.key;
  return key !== undefined && base?.[key] === true;
}

/** A number the layout gives, else the stick's own, else the app's default. */
export function stickNumber(
  field: StickNumberField,
  spec: PositionSpec,
  base: AnalogSettings | undefined,
): number {
  const given = spec[field];
  if (given !== undefined) return given;
  const setting = STICK_NUMBER_SETTINGS.find((candidate) => candidate.field === field);
  const held = setting === undefined ? undefined : base?.[setting.key];
  return typeof held === "number" ? held : (setting?.fallback ?? 0);
}

/**
 * Write the layout's settings into a stick's record, field by field and only where given.
 * `recordIdOf` turns a counter strafe position into the id the app files its button under
 * (the number in its `BP_<id>` log lines, which is a record's id and not a pin).
 */
export function applyStickSettings(
  analog: AnalogSettings,
  spec: PositionSpec,
  position: string,
  mode: string,
  invertXByMode: InvertXByMode,
  recordIdOf: (name: string) => number | undefined,
): void {
  for (const setting of STICK_NUMBER_SETTINGS) {
    const value = spec[setting.field];
    if (value === undefined) continue;
    analog[setting.key] = whole(position, setting.field, value, setting.low, setting.high);
  }
  for (const setting of STICK_FLAG_SETTINGS) {
    const value = spec[setting.field];
    if (value === undefined) continue;
    analog[setting.key] = flag(position, setting.field, value);
  }
  // The device's fact about a mode, where the layout is silent.
  const fromDevice = invertXByMode[mode];
  if (spec.invert_x === undefined && fromDevice !== undefined) analog.invertXAxis = fromDevice;

  // The app turns the throttle off while smoothing is on, and smoothing off while the
  // throttle is up: the two are one choice.
  const touched = spec.analog_throttle !== undefined || spec.analog_smoothing !== undefined;
  if (
    touched &&
    stickFlag("analog_smoothing", spec, analog, invertXByMode, mode) &&
    stickNumber("analog_throttle", spec, analog) > 0
  ) {
    throw new StickSettingError(
      `${position}: analog_throttle does nothing while smoothing is on; set analog_smoothing: false`,
    );
  }

  if (spec.hold_key !== undefined) {
    const name = spec.hold_key;
    if (typeof name !== "string" || DEVICE_KEY_CODES[name] === undefined) {
      throw new StickSettingError(
        `${position}: hold_key ${JSON.stringify(name)} is not a key the unit has a code for`,
      );
    }
    // The app's keyboard type; the Xbox, DirectInput and mouse hold types are not written.
    analog.holdType = "1";
    analog.holdKeyValues = [name, "0", "0"];
  }

  if (spec.counter_strafe !== undefined) {
    if (spec.counter_strafe === null) {
      analog.rotateStickButtonId = 0;
    } else {
      const id = recordIdOf(spec.counter_strafe);
      if (id === undefined) {
        throw new StickSettingError(
          `${position}: counter_strafe '${spec.counter_strafe}' is not a button on this unit`,
        );
      }
      analog.rotateStickButtonId = id;
    }
  }
}
