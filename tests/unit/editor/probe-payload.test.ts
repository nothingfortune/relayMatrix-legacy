// @vitest-environment happy-dom
/**
 * What the page hands the press test: each unit's probe is built with the X the compiler writes
 * for it, so the test measures the unit as compiled. Without that the probe measures the raw
 * template, and the result is about a stick nobody runs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { start } from "../../../src/editor/app.js";
import { start as startProbe } from "../../../src/editor/probe.js";
import { buildPayload } from "../../../src/lib/editor/payload.js";
import type { ProbePayload } from "../../../src/types/probe.js";

vi.mock("../../../src/editor/probe.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/editor/probe.js")>();
  return { ...original, start: vi.fn(original.start) };
});

const PAYLOAD = buildPayload();

function probePayloadFor(rightFact: boolean | undefined): ProbePayload {
  const payload = structuredClone(PAYLOAD);
  const right = payload.devices["cyborg2-right"];
  if (!right) throw new Error("no right unit in the fixture");
  if (rightFact === undefined) delete (right as { stick_invert_x?: unknown }).stick_invert_x;
  else right.stick_invert_x = rightFact;
  vi.mocked(startProbe).mockClear();
  document.body.innerHTML = '<div id="app"></div>';
  start(payload);
  const header = [...document.querySelectorAll<HTMLButtonElement>("header button")].find(
    (button) => button.textContent === "Press test",
  );
  header?.click();
  const call = vi.mocked(startProbe).mock.calls[0];
  const given = call?.[0];
  if (given === undefined) throw new Error("the page did not start the press test");
  return given;
}

const writtenFor = (payload: ProbePayload, hand: string): boolean | undefined =>
  payload.units.find((unit) => unit.hand === hand)?.invertXWritten;

afterEach(() => {
  vi.mocked(startProbe).mockClear();
});

describe("the editor's press test payload", () => {
  it("builds a unit's probe with the X its device map says, not the template's", () => {
    const payload = probePayloadFor(false);
    // The fixture's right template carries invertXAxis: true on its stick: the raw reading.
    expect(writtenFor(payload, "right")).toBe(false);
    const flipped = probePayloadFor(true);
    expect(writtenFor(flipped, "right")).toBe(true);
  });

  it("leaves the template's own X on a unit whose map has no keyboard fact", () => {
    const payload = probePayloadFor(undefined);
    expect(writtenFor(payload, "right")).toBe(true);
  });

  it("is given a way to read what the unit's own probe carries", () => {
    probePayloadFor(false);
    const options = vi.mocked(startProbe).mock.calls[0]?.[2];
    expect(typeof options?.writtenX).toBe("function");
    // Nothing has been read off a unit here, so it is not known.
    expect(options?.writtenX?.("right")).toBeNull();
  });
});
