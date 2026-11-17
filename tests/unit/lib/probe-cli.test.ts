/**
 * `azeron probe` writes the press test's profiles with the device's compiled X in the stick
 * record, in both passes, so the files read are the ones the page puts on a unit.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { repoPath } from "../../../src/config/paths.js";
import type { ExportDocument } from "../../../src/types/azeron.js";

vi.mock("../../../src/lib/io.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/lib/io.js")>();
  return {
    ...original,
    // The fixture's right unit has no keyboard X fact; this gives it one.
    loadDevice: (...args: Parameters<typeof original.loadDevice>) => {
      const device = original.loadDevice(...args);
      if (device.data.device === "cyborg2-right") device.data.stick_invert_x = false;
      return device;
    },
  };
});

let folder: string | null = null;

afterEach(() => {
  if (folder !== null) rmSync(folder, { recursive: true, force: true });
  folder = null;
});

function stickX(path: string): unknown {
  const doc = JSON.parse(readFileSync(path, "utf8")) as ExportDocument;
  return doc.profiles[0]?.inputs.find((input) => input.pinOne === 31)?.analogSettings?.invertXAxis;
}

describe("azeron probe", () => {
  it("writes the device's X into the stick of both profiles, not the template's", async () => {
    const { main } = await import("../../../src/index.js");
    folder = mkdtempSync(join(tmpdir(), "azeron-probe-"));
    const template = repoPath("templates/everspace2-akimbo-right.json");
    // The template's own stick is inverted: that is what a probe built without the fact holds.
    expect(stickX(template)).toBe(true);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(
        main(["probe", "--device", "cyborg2-right", "--template", template, "--out", folder]),
      ).toBe(0);
    } finally {
      write.mockRestore();
    }
    expect(stickX(join(folder, "probe-1-pins.json"))).toBe(false);
    expect(stickX(join(folder, "probe-2-stick-zero.json"))).toBe(false);
  });
});
