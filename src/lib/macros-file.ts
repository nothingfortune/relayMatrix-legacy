/**
 * A game's macros.yaml, patched one macro at a time so the file's comments, its other
 * macros and its layout come through. The page reads the file's text from the payload and
 * sends the patched whole back through /api/save, as it does for sets.yaml.
 *
 * Node-free, because the editor imports it.
 */

import { isMap, parseDocument, YAMLMap, YAMLSeq } from "yaml";
import type { Document } from "yaml";

import type { MacroDef, MacroStep, MacroTarget } from "./macros.js";

/** What a new macros.yaml starts as. */
export const MACROS_HEADER = "# Macros: a button sends a list of keys. See docs/plans/macros.md.\n";

const targetValue = (target: MacroTarget): unknown =>
  typeof target === "string" ? target : { action: target.action };

/** One step as the file writes it: a bare key is a tap. */
function stepValue(step: MacroStep): unknown {
  if (step.tap !== undefined) {
    return step.hold === undefined
      ? targetValue(step.tap)
      : { tap: targetValue(step.tap), hold: step.hold };
  }
  if (step.down !== undefined) return { down: targetValue(step.down) };
  if (step.up !== undefined) return { up: targetValue(step.up) };
  return { wait: step.wait ?? 0 };
}

/** Whether the macro is only a list of keys, with none of the settings. */
function isPlainList(def: MacroDef): boolean {
  return def.repeat === undefined && def.hold === undefined && def.gap === undefined;
}

/** The node a macro is written as: a flow list of keys, or a mapping when it has settings. */
function macroNode(doc: Document, def: MacroDef): unknown {
  const steps = doc.createNode(def.steps.map(stepValue)) as YAMLSeq;
  steps.flow = true;
  if (isPlainList(def)) return steps;
  const map = new YAMLMap();
  if (def.repeat !== undefined) map.set("repeat", def.repeat);
  if (def.hold !== undefined) map.set("hold", def.hold);
  if (def.gap !== undefined) map.set("gap", def.gap);
  map.set("steps", steps);
  return map;
}

/**
 * The file with one macro set (`def`) or taken out (`null`). Every other line stays as it
 * was. An empty or missing file becomes one with the header, and a file left with no macros
 * keeps `macros: {}`, which is never an empty file.
 */
export function patchMacro(text: string, id: string, def: MacroDef | null): string {
  const doc = parseDocument(text.trim() === "" ? `${MACROS_HEADER}macros: {}\n` : text);
  let section = doc.get("macros", true);
  if (!isMap(section)) {
    section = new YAMLMap();
    doc.set("macros", section);
  }
  if (!isMap(section)) return text;
  const wasEmpty = section.items.length === 0;
  if (def === null) {
    section.delete(id);
  } else {
    section.set(id, macroNode(doc, def));
  }
  // `macros: {}` is how an empty file says so; with a macro in it, it is a block like the rest.
  if (wasEmpty && section.items.length > 0) section.flow = false;
  if (section.items.length === 0) section.flow = true;
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}
