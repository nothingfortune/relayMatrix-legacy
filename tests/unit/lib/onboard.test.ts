/**
 * What a unit can do on its own beyond keys: send Xbox buttons and triggers, scroll, and
 * drive its stick as an Xbox stick or as the mouse pointer. Each is stored on the unit
 * (firmware 112), so it works with nothing running on the PC.
 *
 * `tests/fixtures/unit-protocol/onboard-112.json` holds what the Azeron app 2.0.3 wrote
 * for each, with the export of the profile it wrote: the compiler must produce those
 * export fields and the encoder those bytes. The capture is the reference.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  XBOX_BUTTON_BITS,
  describeWheel,
  resolveSlot,
  wheelFields,
} from "../../../src/lib/binding.js";
import { compileProfile } from "../../../src/lib/compile.js";
import { removeKey } from "../../../src/lib/object.js";
import { decompile } from "../../../src/lib/decompile.js";
import { loadProfile, loadTemplate } from "../../../src/lib/io.js";
import { Game } from "../../../src/lib/model.js";
import { Profile } from "../../../src/lib/model-core.js";
import type { StoredProfile } from "../../../src/lib/unitproto.js";
import {
  ProtocolError,
  decodeStoredRecord,
  encodeInputRecord,
  isWritableInput,
} from "../../../src/lib/unitproto.js";
import { compareStored } from "../../../src/lib/unitsession.js";
import type { ExportDocument, ExportProfile, InputRecord } from "../../../src/types/azeron.js";
import { isRebindableRecord } from "../../../src/types/azeron.js";
import type { PositionSpec } from "../../../src/types/profile.js";
import { repoPath } from "../../../src/config/paths.js";
import { UnitSession } from "../../../src/lib/unitsession.js";
import { FakeUnit } from "../../helpers/fakeunit.js";

interface Captured {
  capture: string;
  slot: number;
  input: InputRecord;
  wire: string;
}

const captured = (
  JSON.parse(readFileSync("tests/fixtures/unit-protocol/onboard-112.json", "utf8")) as {
    records: Captured[];
  }
).records;

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

function one(capture: string, id: number): Captured {
  const found = captured.find((entry) => entry.capture === capture && entry.input.id === id);
  if (found === undefined) throw new Error(`no captured input ${String(id)} in ${capture}`);
  return found;
}

describe("the unit's records for Xbox output, scroll and the stick's modes", () => {
  it("are encoded exactly as the app sent them", () => {
    expect(captured.length).toBeGreaterThanOrEqual(12);
    for (const entry of captured) {
      const where = `${entry.capture} input ${String(entry.input.id)}`;
      expect(isWritableInput(entry.input, [0, 28, 29]), where).toBe(true);
      expect(hex(encodeInputRecord(entry.slot, entry.input)), where).toBe(entry.wire);
    }
  });

  it("covers every kind: button and trigger on each press, scroll, Xbox and mouse sticks", () => {
    const kinds = new Set(captured.flatMap((entry) => entry.input.types));
    for (const type of ["21", "22", "23", "35", "40"]) expect(kinds).toContain(type);
    // An Xbox button on a long and on a double press, not only a tap.
    expect(one("wheel-layer", 18).input.types).toEqual(["6", "22", "6"]);
    expect(one("wheel-layer", 13).input.types).toEqual(["6", "6", "22"]);
  });

  it("sends scroll down and left as the app did on the right unit: a negative byte", () => {
    const down = one("write-right", 13);
    const left = one("write-right", 38);
    expect([down.input.x, down.input.y]).toEqual([0, -1]);
    expect([left.input.x, left.input.y]).toEqual([-1, 0]);
    // [slot id pin pinTwo] then type 0x23, x, y, interval and yInterval, two bytes each.
    expect(down.wire.slice(8, 8 + 14)).toBe("2300ff00960070");
    expect(left.wire.slice(8, 8 + 14)).toBe("23ff0000700096");
    expect(hex(encodeInputRecord(down.slot, down.input))).toBe(down.wire);
    expect(hex(encodeInputRecord(left.slot, left.input))).toBe(left.wire);
  });

  it("sends the Xbox stick on the right unit with its side set, as the app did", () => {
    const stick = one("write-right", 24);
    expect(stick.input.types[0]).toBe("21");
    expect(stick.input.analogSettings?.isRightAnalog).toBe(true);
    expect(hex(encodeInputRecord(stick.slot, stick.input))).toBe(stick.wire);
  });

  it("still refuses a direction that does not fit a signed byte", () => {
    const far = structuredClone(one("write-right", 13).input);
    far.y = -200;
    expect(() => encodeInputRecord(3, far)).toThrow(ProtocolError);
  });

  it("refuses an Xbox button that is not one button", () => {
    const button = structuredClone(one("xinput", 15).input);
    button.keyValues = ["4097", "0", "0", "0"];
    expect(() => encodeInputRecord(4, button)).toThrow(/not one button bit/);
  });

  it("are records the compiler may rewrite", () => {
    for (const type of ["21", "22", "23", "35", "40"]) {
      expect(isRebindableRecord({ types: [type, "6", "6"] } as unknown as InputRecord)).toBe(true);
    }
    // What the app runs on the PC still passes through: macro, layer switch, sequence.
    for (const type of ["16", "24", "37"]) {
      expect(isRebindableRecord({ types: [type, "6", "6"] } as unknown as InputRecord)).toBe(false);
    }
  });
});

describe("a key's Xbox and scroll bindings", () => {
  it("names a button by XInput's bit and a trigger as the export does", () => {
    expect(resolveSlot({ xinput: "A" }, null)).toEqual(["22", "4096", "0"]);
    expect(resolveSlot({ xinput: "Guide" }, null)).toEqual(["22", "1024", "0"]);
    expect(resolveSlot({ xinput: "RT" }, null)).toEqual(["23", "T2", "0"]);
    expect(resolveSlot({ xinput: "LT" }, null)).toEqual(["23", "T1", "0"]);
    expect(() => resolveSlot({ xinput: "LeftStickUp" }, null)).toThrow(/not an Xbox button/);
  });

  it("agrees with what the app exported for A and the right trigger", () => {
    expect(one("xinput", 15).input.keyValues[0]).toBe(String(XBOX_BUTTON_BITS.A));
    expect(one("xinput", 10).input.keyValues[0]).toBe("T2");
  });

  it("works out scroll's fields the way the app does", () => {
    // The app exported scroll up at speed 33 and right at 29 like this.
    const up = one("wheel-layer", 4).input;
    expect(wheelFields("up", 33)).toEqual({ x: 0, y: 1, interval: 150, yInterval: 100.5 });
    expect([up.x, up.y, up.interval, up.yInterval]).toEqual([0, 1, 150, 100.5]);
    const right = one("wheel-layer", 12).input;
    expect(wheelFields("right", 29)).toEqual({ x: 1, y: 0, interval: 106.5, yInterval: 150 });
    expect([right.x, right.y, right.interval, right.yInterval]).toEqual([1, 0, 106.5, 150]);
    expect(describeWheel({ x: 0, y: 1, interval: 150, yInterval: 100.5 })).toEqual({
      wheel: "up",
      speed: 33,
    });
    // Neither axis moving is not a direction.
    expect(describeWheel({ x: 0, y: 0, interval: 150, yInterval: 150 })).toBeNull();
    expect(() => wheelFields("up", 0)).toThrow(/1 to 100/);
    expect(() => wheelFields("sideways")).toThrow(/not a scroll direction/);
  });
});

describe("compiling and decompiling them", () => {
  const SINGLE_V5 = "games/SpaceSims/everspace/profiles/single-v5.yaml";

  function build(edit: (positions: Record<string, PositionSpec>) => void) {
    const game = new Game("games/SpaceSims/everspace");
    const profile = loadProfile(SINGLE_V5, game);
    const template = loadTemplate("templates/everspace2-v5.json");
    const data = structuredClone(profile.data);
    edit(data.positions);
    const edited = new Profile(data, profile.device, { path: profile.path, game });
    const built = compileProfile(edited, { template, actions: game.actions.actions });
    const record = (name: string): InputRecord | undefined => {
      const pin = profile.device.positions[name]?.pin;
      return built.profiles[0]?.inputs.find((input) => input.pinOne === pin);
    };
    return { game, profile, template, built, record };
  }

  function onboard(positions: Record<string, PositionSpec>): void {
    positions.pinky_1 = { label: "Jump", tap: { xinput: "A" }, long: { xinput: "Y" } };
    positions.pinky_2 = { label: "Fire", tap: { xinput: "RT" } };
    positions.pinky_3 = { label: "Next", tap: { wheel: "up", speed: 33 } };
    positions.stick = { mode: "mouse", mouse_sensitivity: 2 };
  }

  it("writes the fields the app's own export has", () => {
    const { record } = build(onboard);
    expect(record("pinky_1")?.types).toEqual(["22", "22", "11"]);
    expect(record("pinky_1")?.keyValues[0]).toBe("4096");
    expect(record("pinky_1")?.keyValuesLong[0]).toBe("32768");
    expect(record("pinky_2")?.types[0]).toBe("23");
    expect(record("pinky_2")?.keyValues[0]).toBe("T2");
    const scroll = record("pinky_3");
    expect(scroll?.types[0]).toBe("35");
    expect([scroll?.x, scroll?.y, scroll?.interval, scroll?.yInterval]).toEqual([0, 1, 150, 100.5]);
    const stick = record("stick");
    expect(stick?.types[0]).toBe("40");
    expect(stick?.analogSettings?.mouseSensitivity).toBe(2);
  });

  it("comes back out of the export as the same bindings, and builds the same again", () => {
    const { game, profile, template, built } = build(onboard);
    const data = decompile(built, profile.device, { actions: game.actions });
    expect(data.positions.pinky_1?.tap).toEqual({ xinput: "A" });
    expect(data.positions.pinky_1?.long).toEqual({ xinput: "Y" });
    expect(data.positions.pinky_2?.tap).toEqual({ xinput: "RT" });
    expect(data.positions.pinky_3?.tap).toEqual({ wheel: "up", speed: 33 });
    expect(data.positions.stick?.mode).toBe("mouse");
    expect(data.positions.stick?.mouse_sensitivity).toBe(2);
    const again = compileProfile(new Profile(data, profile.device, { path: profile.path, game }), {
      template,
      actions: game.actions.actions,
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(built));
  });

  it("makes the stick an Xbox stick", () => {
    const { record } = build((positions) => {
      positions.stick = { mode: "xbox" };
    });
    expect(record("stick")?.types[0]).toBe("21");
  });

  it("refuses scroll on a long press", () => {
    expect(() =>
      build((positions) => {
        positions.pinky_3 = { long: { wheel: "down" } };
      }),
    ).toThrow(/tap only/);
  });

  it("keeps a pointer speed on a stick switched out of mouse mode, where it does nothing", () => {
    const { game, profile, template, built, record } = build((positions) => {
      positions.stick = { mode: "keyboard", mouse_sensitivity: 2 };
    });
    expect(record("stick")?.types[0]).toBe("4");
    expect(record("stick")?.analogSettings?.mouseSensitivity).toBe(2);
    const data = decompile(built, profile.device, { actions: game.actions });
    expect(data.positions.stick?.mouse_sensitivity).toBe(2);
    const again = compileProfile(new Profile(data, profile.device, { path: profile.path, game }), {
      template,
      actions: game.actions.actions,
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(built));
  });

  it("goes to a unit byte for byte as the app sent the same bindings", () => {
    const { record } = build(onboard);
    const button = record("pinky_2");
    if (button === undefined) throw new Error("no record");
    // The app's trigger record and ours differ only in id and pin; the trigger block agrees.
    const ours = hex(encodeInputRecord(4, button)).slice(8, 8 + 14);
    const theirs = one("xinput", 10).wire.slice(8, 8 + 14);
    expect(ours).toBe(theirs);
  });
});

describe("reading a unit's slot that holds what this cannot decode", () => {
  it("keeps going rather than misreading the record or running off its end", () => {
    // A stored scroll record: its id, pins and types, then a layout not captured yet.
    const wanted = structuredClone(one("wheel-layer", 4).input);
    const stored = Uint8Array.from([
      2,
      wanted.id,
      wanted.pinOne,
      wanted.pinTwo,
      0x23,
      6,
      6,
      0,
      1,
      0,
    ]);
    const input = decodeStoredRecord(stored);
    expect(input.undecoded).toBe(true);
    expect(input.types).toEqual(["35", "6", "6"]);
    const slot = { slot: 5, name: "Recon", inputs: [input], settings: null };
    // What was read -- the pins and the tap's type -- agrees, and the rest cannot be compared,
    // which is not a difference (`writeProfile` reports it as unchecked).
    expect(compareStored([wanted], slot)).toEqual([]);
    // A scroll key that came back on other pins is still a difference.
    const moved = structuredClone(wanted);
    moved.pinOne += 1;
    expect(compareStored([moved], slot).map((difference) => difference.field)).toContain("pins");
  });

  it("reads an Xbox button and trigger back as the values that were written", () => {
    const record = new Uint8Array(68);
    record.set([2, 15, 24, 255, 0x16, 0x06, 0x06]);
    // Stored values are little-endian, unlike what OBM_COPY sends.
    record.set([0x00, 0x10], 7);
    const input = decodeStoredRecord(record);
    expect(input.keyValues[0]).toBe("4096");
    const wanted = structuredClone(one("xinput", 15).input);
    wanted.types = ["22", "6", "6"];
    const differences = compareStored([wanted], {
      slot: 4,
      name: "Recon",
      inputs: [input],
      settings: null,
    });
    expect(differences.filter((difference) => difference.field.startsWith("keyValues["))).toEqual(
      [],
    );
  });
});

describe("Everspace 2's rule that its stick is keyboard only", () => {
  it("still refuses the stick as an Xbox stick or as the mouse, now both are real modes", async () => {
    const { lintGame } = await import("../../../src/lib/lint.js");
    const game = new Game("games/SpaceSims/everspace");
    const profile = loadProfile("games/SpaceSims/everspace/profiles/single-v5.yaml", game);
    for (const mode of ["xbox", "mouse"]) {
      const data = structuredClone(profile.data);
      const stick = data.positions.stick;
      if (stick === undefined) throw new Error("no stick");
      stick.mode = mode;
      delete stick.raw;
      const edited = new Profile(data, profile.device, { path: profile.path, game });
      const { live } = lintGame(game, [edited]);
      expect(
        live.some((finding) => finding.rule === "stick-not-keyboard"),
        mode,
      ).toBe(true);
    }
  });
});

describe("an export of the Azeron app 2.0.3 with every kind in it", () => {
  /**
   * The app's own export of the profile it wrote while recorded: Xbox buttons on each
   * press, a trigger, three scroll keys (one moving neither axis), the stick as a mouse,
   * and a macro, a sequence and a layer switch the app runs on the PC.
   */
  function roundTrip(exported: ExportDocument): { before: InputRecord[]; after: InputRecord[] } {
    const game = new Game("games/SpaceSims/everspace");
    const device = loadProfile("games/SpaceSims/everspace/profiles/single-v5.yaml", game).device;
    const data = decompile(exported, device, { actions: null });
    const profile = new Profile(data, device, { path: "recon.yaml", game });
    const built = compileProfile(profile, { template: exported, actions: null });
    return { before: exported.profiles[0]?.inputs ?? [], after: built.profiles[0]?.inputs ?? [] };
  }

  it("keeps a scroll it cannot name, on a key with nothing else to say about it", () => {
    const exported = JSON.parse(
      readFileSync("tests/fixtures/unit-protocol/recon-112-export.json", "utf8"),
    ) as ExportDocument;
    // Scroll on both axes at once, unlabelled: nothing in the YAML but the scroll itself.
    const both = exported.profiles[0]?.inputs.find((input) => input.id === 4);
    if (both === undefined) throw new Error("no input 4");
    delete both.label;
    Object.assign(both, { x: 1, y: 1, interval: 75, yInterval: 75, doubleDelay: 150 });
    const { after } = roundTrip(exported);
    const kept = after.find((input) => input.id === 4);
    expect(kept?.types[0]).toBe("35");
    expect([kept?.x, kept?.y, kept?.interval, kept?.yInterval]).toEqual([1, 1, 75, 75]);
  });

  it("builds back from its decompiled YAML exactly as it was", () => {
    const game = new Game("games/SpaceSims/everspace");
    const device = loadProfile("games/SpaceSims/everspace/profiles/single-v5.yaml", game).device;
    const exported = JSON.parse(
      readFileSync("tests/fixtures/unit-protocol/recon-112-export.json", "utf8"),
    ) as ExportDocument;
    const data = decompile(exported, device, { actions: null });
    const profile = new Profile(data, device, { path: "recon.yaml", game });
    const built = compileProfile(profile, { template: exported, actions: null });
    const before = exported.profiles[0]?.inputs ?? [];
    const after = built.profiles[0]?.inputs ?? [];
    expect(after).toHaveLength(before.length);
    before.forEach((record, index) => {
      const rebuilt = after[index];
      if (rebuilt === undefined) throw new Error(`no input ${String(record.id)}`);
      if (record.analogSettings !== undefined && record.types[0] === "40") {
        // The stick's directions come back as the integer keycodes the compiler emits
        // ("KeyW" as 87): the same key, so the unit is given the same bytes.
        expect(hex(encodeInputRecord(5, rebuilt)), "the stick").toBe(
          hex(encodeInputRecord(5, record)),
        );
        return;
      }
      expect(JSON.stringify(rebuilt), `input ${String(record.id)}`).toBe(JSON.stringify(record));
    });
  });
});

describe("writing them to a unit and reading the slot back", () => {
  /**
   * How a unit stores these is inferred, not captured: a key-like record keeps its value
   * where a key's code goes, and a stick keeps its own layout whatever its mode. A unit that
   * stored them otherwise shows as a difference after the write -- never as success.
   */
  const akimbo = (): ExportDocument =>
    JSON.parse(
      readFileSync(repoPath("dist/SpaceSims/everspace/everspace_akimbo_v10_left.json"), "utf8"),
    ) as ExportDocument;

  function akimboProfile(): ExportProfile {
    const profile = akimbo().profiles[0];
    if (profile === undefined) throw new Error("no profile");
    return profile;
  }

  function withOnboard(): InputRecord[] {
    const profile = akimbo().profiles[0];
    if (profile === undefined) throw new Error("no profile");
    const keys = profile.inputs.filter((input) => input.types[0] === "1");
    const [first, second] = keys;
    if (first === undefined || second === undefined) throw new Error("no keys");
    first.types = ["22", "11", "11"];
    first.keyValues = ["4096", "0", "0", "0"];
    second.types = ["23", "11", "11"];
    second.keyValues = ["T2", "0", "0", "0"];
    const stick = profile.inputs.find((input) => input.types[0] === "4");
    if (stick?.analogSettings === undefined) throw new Error("no stick");
    stick.types = ["40", "0", "0"];
    stick.analogSettings.mouseSensitivity = 2;
    return profile.inputs;
  }

  async function ready(): Promise<{
    fake: FakeUnit;
    session: UnitSession;
    slots: Awaited<ReturnType<UnitSession["readAll"]>>;
  }> {
    const fake = new FakeUnit({ deviceId: 49229 });
    for (const name of ["Basic", "Joystick", "Everspace 2 akimbo"]) {
      fake.seed(name, akimbo().profiles[0]?.inputs ?? []);
    }
    const session = new UnitSession(fake);
    await session.identify();
    const slots = await session.readAll();
    return { fake, session, slots };
  }

  it("writes an Xbox button, a trigger and the stick as a mouse over a slot of keys", async () => {
    const { session } = await ready();
    const profile = akimboProfile();
    profile.inputs = withOnboard();
    const report = await session.writeProfile({
      slot: 2,
      name: "ES2 akimbo",
      profile,
      unknownPins: [0, 28, 29],
    });
    expect(report.problems).toEqual([]);
  });

  it("shows what replacing keys with them would change, in either direction, without throwing", async () => {
    const { slots } = await ready();
    const held = slots.find((slot) => slot.slot === 2);
    if (held === undefined) throw new Error("no slot 2");
    const wanted = withOnboard().filter((input) => isWritableInput(input, [0, 28, 29]));
    const forward = compareStored(wanted, held);
    expect(forward.some((difference) => difference.field === "types")).toBe(true);
    // And back: a slot holding Xbox output, a layout of keys.
    const xboxSlot = {
      ...held,
      inputs: held.inputs.map((input) =>
        input.types[0] === "1"
          ? { ...input, types: ["22", "11", "11"], keyValues: ["4096", "0", "0", "0"] }
          : input,
      ),
    };
    const keysWanted = (akimbo().profiles[0]?.inputs ?? []).filter((input) =>
      isWritableInput(input, [0, 28, 29]),
    );
    expect(() => compareStored(keysWanted, xboxSlot)).not.toThrow();
    expect(compareStored(keysWanted, xboxSlot).length).toBeGreaterThan(0);
  });

  it("writes a layout with scroll, and says which keys it could not read back", async () => {
    const { fake, session } = await ready();
    const profile = akimboProfile();
    const inputs = withOnboard();
    const key = inputs.find((input) => input.types[0] === "1");
    if (key === undefined) throw new Error("no key");
    Object.assign(key, { types: ["35", "11", "11"], x: 0, y: 1, interval: 150, yInterval: 75 });
    profile.inputs = inputs;
    fake.received.length = 0;
    const report = await session.writeProfile({
      slot: 2,
      name: "ES2 akimbo",
      profile,
      unknownPins: [0, 28, 29],
    });
    expect(fake.received.length).toBeGreaterThan(0);
    // Not a difference: the unit holds the scroll key, its contents just cannot be compared.
    expect(report.problems).toEqual([]);
    expect(report.unchecked.map((record) => record.id)).toEqual([key.id]);
    expect(report.unchecked[0]?.raw).toMatch(/^[0-9a-f]+$/);
  });

  it("writes scroll down and left, which have a negative direction", async () => {
    const { session } = await ready();
    const profile = akimboProfile();
    const inputs = withOnboard();
    const keys = inputs.filter((input) => input.types[0] === "1").slice(0, 2);
    const [down, left] = keys;
    if (down === undefined || left === undefined) throw new Error("no keys");
    Object.assign(down, {
      types: ["35", "11", "11"],
      x: 0,
      y: -1,
      interval: 150,
      yInterval: 112.5,
    });
    Object.assign(left, {
      types: ["35", "11", "11"],
      x: -1,
      y: 0,
      interval: 112.5,
      yInterval: 150,
    });
    profile.inputs = inputs;
    const report = await session.writeProfile({
      slot: 2,
      name: "ES2 akimbo",
      profile,
      unknownPins: [0, 28, 29],
    });
    expect(report.problems).toEqual([]);
    expect(report.unchecked.map((record) => record.id).sort()).toEqual([down.id, left.id].sort());
  });

  it("still sees a scroll key that came back on another pin or as another kind", () => {
    const wanted = structuredClone(one("write-right", 13).input);
    const stored = (pinOne: number, tap: number): StoredProfile => ({
      slot: 3,
      name: "Recon",
      inputs: [decodeStoredRecord(Uint8Array.from([2, wanted.id, pinOne, 255, tap, 6, 6, 0, 0]))],
      settings: null,
    });
    expect(compareStored([wanted], stored(wanted.pinOne, 0x23))).toEqual([]);
    expect(compareStored([wanted], stored(wanted.pinOne + 1, 0x23)).length).toBeGreaterThan(0);
    expect(compareStored([wanted], stored(wanted.pinOne, 0x1e)).length).toBeGreaterThan(0);
  });

  it("does not let a record this cannot read pass for a key that was written", () => {
    // Only scroll is let off for what it cannot be compared on; a key whose stored type
    // came back as something unreadable is a difference, as a corrupted write must be.
    const key = structuredClone(one("xinput", 15).input);
    const bad = decodeStoredRecord(
      Uint8Array.from([2, key.id, key.pinOne, key.pinTwo, 0x1e, 6, 6, 0]),
    );
    expect(bad.undecoded).toBe(true);
    const found = compareStored([key], { slot: 3, name: "Recon", inputs: [bad], settings: null });
    expect(found.length).toBeGreaterThan(0);
  });
});

describe("a layout that sends Xbox output and keys together", () => {
  async function lintWith(edit: (positions: Record<string, PositionSpec>) => void) {
    const { lintGame } = await import("../../../src/lib/lint.js");
    const game = new Game("games/SpaceSims/everspace");
    const profile = loadProfile("games/SpaceSims/everspace/profiles/single-v5.yaml", game);
    const data = structuredClone(profile.data);
    edit(data.positions);
    const edited = new Profile(data, profile.device, { path: profile.path, game });
    return lintGame(game, [edited]).live.filter((finding) => finding.rule === "mixed-input");
  }

  it("is warned of once, since many games flip between pad and keyboard", async () => {
    const found = await lintWith((positions) => {
      positions.pinky_1 = { tap: { xinput: "A" } };
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.level).toBe("warning");
  });

  it("counts a stick with directions and no mode as the keys it sends", async () => {
    const found = await lintWith((positions) => {
      positions.pinky_1 = { tap: { xinput: "A" } };
      // Every key but the stick sends Xbox output; the stick sends keys, with no `mode:`.
      for (const [name, spec] of Object.entries(positions)) {
        if (name === "stick") {
          delete spec.mode;
          delete spec.raw;
        } else if (name !== "pinky_1") {
          removeKey(positions, name);
        }
      }
    });
    expect(found).toHaveLength(1);
  });

  it("is not warned of when the layout sends only keys", async () => {
    expect(await lintWith(() => undefined)).toEqual([]);
  });
});

describe("a stick's tuning", () => {
  const SINGLE_V5 = "games/SpaceSims/everspace/profiles/single-v5.yaml";
  function stickWith(
    extra: Partial<PositionSpec>,
    inTemplate: Record<string, number> = {},
  ): InputRecord | undefined {
    const game = new Game("games/SpaceSims/everspace");
    const profile = loadProfile(SINGLE_V5, game);
    const template = loadTemplate("templates/everspace2-v5.json");
    const stickPin = profile.device.positions.stick?.pin;
    const held = template.profiles[0]?.inputs.find((input) => input.pinOne === stickPin);
    if (held?.analogSettings) Object.assign(held.analogSettings, inTemplate);
    const data = structuredClone(profile.data);
    data.positions.stick = { ...data.positions.stick, ...extra };
    const edited = new Profile(data, profile.device, { path: profile.path, game });
    const built = compileProfile(edited, { template, actions: game.actions.actions });
    const pin = profile.device.positions.stick?.pin;
    return built.profiles[0]?.inputs.find((input) => input.pinOne === pin);
  }

  it("writes deadzones as the app stores them, out of 512, and the threshold and cones", () => {
    const stick = stickWith({
      deadzone_lower: 10,
      deadzone_upper: 5,
      threshold: 7,
      cone_vertical: 30,
      cone_horizontal: 60,
    });
    const analog = stick?.analogSettings;
    expect([analog?.lowerLimit, analog?.upperLimit, analog?.sensitivity]).toEqual([51, 26, 7]);
    expect(analog?.analogCones).toEqual({ verticalCone: 30, horizontalCone: 60 });
  });

  it("leaves what the profile does not give as the template had it", () => {
    const analog = stickWith({ deadzone_lower: 10 })?.analogSettings;
    expect(analog?.sensitivity).toBe(3);
    expect(analog?.upperLimit).toBe(0);
  });

  it("refuses deadzones that leave no travel, and values out of the app's range", () => {
    expect(() => stickWith({ deadzone_lower: 60, deadzone_upper: 40 })).toThrow(/no travel/);
    // A deadzone the profile leaves out is the template's, and counts.
    expect(() => stickWith({ deadzone_lower: 60 }, { upperLimit: 256 })).toThrow(/no travel/);
    expect(() => stickWith({ deadzone_upper: 60 }, { lowerLimit: 256 })).toThrow(/no travel/);
    expect(stickWith({ deadzone_lower: 10 }, { upperLimit: 256 })?.analogSettings?.lowerLimit).toBe(
      51,
    );
    expect(() => stickWith({ threshold: 26 })).toThrow(/0 to 25/);
    expect(() => stickWith({ cone_vertical: 90 })).toThrow(/1 to 89/);
    expect(() => stickWith({ mouse_sensitivity: 11 })).toThrow(/1 to 10/);
  });
});
