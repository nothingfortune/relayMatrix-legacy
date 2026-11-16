/**
 * The Key panel's Tuning section for a stick: the Azeron app's Configurator, setting by
 * setting. A setting left as it is keeps what the stick has now (the layout's value, else the
 * device's, else the template's) and shows it beside the control; only a value given here is
 * written over it. Which settings appear follows the stick's mode, as the app's tabs do.
 */

import { DEVICE_KEY_CODES } from "../lib/unitproto.js";
import { removeKey } from "../lib/object.js";
import { stickFlag, stickNumber } from "../lib/stick-settings.js";
import type { InvertXByMode, StickFlagField, StickNumberField } from "../lib/stick-settings.js";
import { MAX_THRESHOLD, STICK_TRAVEL, type AnalogSettings } from "../types/azeron.js";
import type { PositionSpec } from "../types/profile.js";

type ToolField =
  | "deadzone_lower"
  | "deadzone_upper"
  | "threshold"
  | "cone_vertical"
  | "cone_horizontal"
  | StickNumberField;

export interface TuningContext {
  /** The device's `stick_invert_x`. */
  invertXByMode: InvertXByMode;
  /** The device swaps the stick's directions (`stick_directions`). */
  swapsDirections: boolean;
  /** The device's `stick_angle`, which stands over the template's angle. */
  stickAngle: number | undefined;
  /** The unit's buttons a counter strafe can be: name, label and the record id it files under. */
  buttons: { name: string; label: string; id: number | undefined }[];
  render: () => void;
}

function el(
  tag: string,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

const number = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

const SWITCH_LABELS: Record<StickFlagField, string> = {
  invert_x: "Invert X",
  invert_y: "Invert Y",
  angle_lock: "Angle lock",
  hold_threshold: "Hold threshold",
  analog_smoothing: "Smoothing",
};

export function stickTuningField(
  spec: PositionSpec,
  base: AnalogSettings | undefined,
  mode: string,
  context: TuningContext,
): HTMLElement {
  const cones = (base?.analogCones ?? {}) as Record<string, unknown>;
  const percent = (raw: unknown): number | undefined => {
    const value = number(raw);
    return value === undefined ? undefined : Math.round((value * 100) / STICK_TRAVEL);
  };
  const flag = (field: StickFlagField): boolean =>
    stickFlag(field, spec, base, context.invertXByMode, mode);
  const asItIs = (field: StickFlagField): boolean =>
    stickFlag(field, {}, base, context.invertXByMode, mode);

  interface Row {
    field: ToolField;
    label: string;
    low: number;
    high: number;
    now: number | undefined;
    off?: boolean;
  }
  const rows: Row[] = [
    {
      field: "angle",
      label: "Angle (degrees)",
      low: -180,
      high: 180,
      now: context.stickAngle ?? number(base?.angle),
    },
    {
      field: "deadzone_lower",
      label: "Lower deadzone (%)",
      low: 0,
      high: 99,
      now: percent(base?.lowerLimit),
    },
    {
      field: "deadzone_upper",
      label: "Upper deadzone (%)",
      low: 0,
      high: 99,
      now: percent(base?.upperLimit),
    },
  ];
  // The app hides the threshold for a mouse stick, and the cones only steer keys.
  if (mode !== "mouse") {
    rows.push({
      field: "threshold",
      label: "Sensitivity threshold (0 to 25)",
      low: 0,
      high: MAX_THRESHOLD,
      now: number(base?.sensitivity),
    });
  }
  if (mode === "keyboard") {
    rows.push(
      {
        field: "cone_vertical",
        label: "Vertical cone (degrees)",
        low: 1,
        high: 89,
        now: number(cones.verticalCone),
      },
      {
        field: "cone_horizontal",
        label: "Horizontal cone (degrees)",
        low: 1,
        high: 89,
        now: number(cones.horizontalCone),
      },
    );
  }
  // An Xbox stick has no trigger point and no lock zone; the app's tabs leave them out.
  if (mode !== "xbox") {
    rows.push({
      field: "trigger_magnitude",
      label: "Trigger magnitude (1 to 9)",
      low: 1,
      high: 9,
      now: stickNumber("trigger_magnitude", {}, base),
    });
    if (flag("angle_lock")) {
      rows.push(
        {
          field: "lock_zone_angle",
          label: "Lock zone angle (10 to 90)",
          low: 10,
          high: 90,
          now: stickNumber("lock_zone_angle", {}, base),
        },
        {
          field: "lock_zone_size",
          label: "Lock zone size (10 to 90)",
          low: 10,
          high: 90,
          now: stickNumber("lock_zone_size", {}, base),
        },
      );
    }
  }
  if (flag("hold_threshold")) {
    rows.push({
      field: "hold_magnitude",
      label: "Hold magnitude (1 to 9)",
      low: 1,
      high: 9,
      now: stickNumber("hold_magnitude", {}, base),
    });
  }
  rows.push({
    field: "analog_throttle",
    label: "Analog throttle (0 to 50)",
    low: 0,
    high: 50,
    now: stickNumber("analog_throttle", {}, base),
    // The app turns the throttle off while smoothing is on.
    off: flag("analog_smoothing"),
  });

  const switches: StickFlagField[] = ["invert_x", "invert_y"];
  if (mode !== "xbox") switches.push("angle_lock");
  switches.push("hold_threshold", "analog_smoothing");

  const tuned =
    rows.some((row) => spec[row.field] !== undefined) ||
    switches.some((field) => spec[field] !== undefined) ||
    spec.hold_key !== undefined ||
    spec.counter_strafe !== undefined;
  const details = el("details", { class: "stick-tuning" }, [
    el("summary", {}, [tuned ? "Tuning (changed)" : "Tuning"]),
  ]);
  if (tuned) details.setAttribute("open", "open");
  const grid = el("div", { class: "tuning-grid" });

  for (const row of rows) {
    const input = el("input", {
      type: "number",
      min: String(row.low),
      max: String(row.high),
      step: "1",
      placeholder: row.now === undefined ? "as it is" : String(row.now),
      value: spec[row.field] === undefined ? "" : String(spec[row.field]),
      "data-tuning": row.field,
    }) as HTMLInputElement;
    if (row.off === true) {
      input.disabled = true;
      input.title = "Off while smoothing is on";
    }
    input.addEventListener("change", () => {
      if (input.value.trim() === "") {
        removeKey(spec, row.field);
      } else {
        const value = Number(input.value);
        if (!Number.isInteger(value) || value < row.low || value > row.high) {
          input.value = spec[row.field] === undefined ? "" : String(spec[row.field]);
          return;
        }
        spec[row.field] = value;
      }
      context.render();
    });
    grid.append(el("div", { class: "field" }, [el("label", {}, [row.label]), input]));
  }

  for (const field of switches) {
    const select = el("select", { "data-tuning": field }) as HTMLSelectElement;
    select.append(
      el("option", { value: "" }, [`As it is (${asItIs(field) ? "on" : "off"})`]),
      el("option", { value: "on" }, ["On"]),
      el("option", { value: "off" }, ["Off"]),
    );
    const given = spec[field];
    select.value = given === undefined ? "" : given ? "on" : "off";
    if (field === "invert_x" && context.swapsDirections) {
      select.title = "Keyboard mode: this unit swaps left and right on its own";
    }
    select.addEventListener("change", () => {
      if (select.value === "") removeKey(spec, field);
      else spec[field] = select.value === "on";
      context.render();
    });
    grid.append(el("div", { class: "field" }, [el("label", {}, [SWITCH_LABELS[field]]), select]));
  }

  if (flag("hold_threshold")) {
    const held = base?.holdKeyValues;
    const now = Array.isArray(held) && held[0] !== undefined ? String(held[0]) : "as it is";
    const input = el("input", {
      type: "text",
      list: "hold-keys",
      placeholder: now,
      value: spec.hold_key ?? "",
      "data-tuning": "hold_key",
    }) as HTMLInputElement;
    input.addEventListener("change", () => {
      const value = input.value.trim();
      if (value === "") {
        removeKey(spec, "hold_key");
      } else if (DEVICE_KEY_CODES[value] === undefined) {
        input.value = spec.hold_key ?? "";
        return;
      } else {
        spec.hold_key = value;
      }
      context.render();
    });
    const keys = el("datalist", { id: "hold-keys" });
    for (const name of Object.keys(DEVICE_KEY_CODES)) keys.append(el("option", { value: name }));
    grid.append(el("div", { class: "field" }, [el("label", {}, ["Hold key"]), input, keys]));
  }

  const strafe = el("select", { "data-tuning": "counter_strafe" }) as HTMLSelectElement;
  const held = number(base?.rotateStickButtonId) ?? 0;
  const heldAs = context.buttons.find((button) => button.id === held && held > 0)?.label;
  strafe.append(
    el("option", { value: "" }, [
      `As it is (${held === 0 ? "none" : (heldAs ?? `#${String(held)}`)})`,
    ]),
    el("option", { value: "none" }, ["None"]),
  );
  for (const button of context.buttons) {
    strafe.append(el("option", { value: button.name }, [button.label]));
  }
  strafe.value = spec.counter_strafe === null ? "none" : (spec.counter_strafe ?? "");
  strafe.addEventListener("change", () => {
    if (strafe.value === "") removeKey(spec, "counter_strafe");
    else spec.counter_strafe = strafe.value === "none" ? null : strafe.value;
    context.render();
  });
  const marker = el(
    "span",
    { class: "unsafe", title: "The Azeron app warns this might not be safe for online play" },
    [" unsafe online"],
  );
  grid.append(el("div", { class: "field" }, [el("label", {}, ["Counter strafe", marker]), strafe]));

  details.append(grid);
  return details;
}
