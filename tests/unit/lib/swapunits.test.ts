/**
 * Swapping which unit is the left hand and which the right. It writes local.yaml, so the
 * data root is a scratch copy of the fixture's devices: the fixture itself is never touched.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/paths.js")>();
  const root = mkdtempSync(join(tmpdir(), "azeron-swap-"));
  cpSync(join(actual.dataRoot, "devices"), join(root, "devices"), { recursive: true });
  return {
    ...actual,
    repoRoot: root,
    dataRoot: root,
    repoPath: (...parts: readonly string[]) => {
      const joined = join(...parts);
      return isAbsolute(joined) ? joined : join(root, joined);
    },
  };
});

import { dataRoot } from "../../../src/config/paths.js";
import { loadDevice } from "../../../src/lib/io.js";
import { loadLocal, LocalSettingsError, setLocalDeviceIds } from "../../../src/lib/machine.js";
import { ScaffoldError } from "../../../src/lib/scaffold.js";
import { swapUnits } from "../../../src/lib/tasks.js";

const LOCAL = join(dataRoot, "local.yaml");

// One scratch root serves the whole file: each test starts with no local.yaml.
beforeEach(() => {
  rmSync(LOCAL, { force: true });
});

describe("setLocalDeviceIds", () => {
  it("gives both hands their ids in one write, keeping what was there", () => {
    writeFileSync(LOCAL, "# mine\ngames:\n  everspace:\n    export_to: x\n", "utf8");
    setLocalDeviceIds({ "cyborg2-left": "29993", "cyborg2-right": "49229" }, dataRoot);
    const text = readFileSync(LOCAL, "utf8");
    expect(text).toContain("# mine");
    expect(loadLocal(dataRoot)).toEqual({
      games: { everspace: { export_to: "x" } },
      devices: {
        "cyborg2-left": { software_device_id: "29993" },
        "cyborg2-right": { software_device_id: "49229" },
      },
    });
  });

  it("refuses an id that is not a unit's before writing anything", () => {
    expect(() =>
      setLocalDeviceIds({ "cyborg2-left": "1", "cyborg2-right": "x" }, dataRoot),
    ).toThrow(LocalSettingsError);
  });
});

describe("swapUnits", () => {
  it("exchanges the two hands' ids, so the unit that was the left is now the right", () => {
    const before = [
      loadDevice("cyborg2-left").softwareDeviceId,
      loadDevice("cyborg2-right").softwareDeviceId,
    ];
    expect(before).toEqual(["49229", "29993"]);
    const result = swapUnits("cyborg2-left", "cyborg2-right");
    expect(result.ids).toEqual({ "cyborg2-left": "29993", "cyborg2-right": "49229" });
    expect(loadDevice("cyborg2-left").softwareDeviceId).toBe("29993");
    expect(loadDevice("cyborg2-right").softwareDeviceId).toBe("49229");
  });

  it("swaps back the same way, so a second click undoes the first", () => {
    swapUnits("cyborg2-left", "cyborg2-right");
    swapUnits("cyborg2-left", "cyborg2-right");
    expect(loadDevice("cyborg2-left").softwareDeviceId).toBe("49229");
    expect(loadDevice("cyborg2-right").softwareDeviceId).toBe("29993");
    expect(existsSync(LOCAL)).toBe(true);
  });

  it("refuses a hand with no map, and the same hand twice", () => {
    expect(() => swapUnits("cyborg2-left", "no-such-device")).toThrow(ScaffoldError);
    expect(() => swapUnits("cyborg2-left", "cyborg2-left")).toThrow(ScaffoldError);
  });
});
