/**
 * Every genre's pad and layouts, each started as a game and checked.
 *
 * The data is tests/fixtures/defaults/genres, a frozen copy of all eight genres (the main
 * fixture holds two, older); no test reads the real ones. When a genre changes, take a fresh
 * copy deliberately: see the README there. Each style is started in a scratch data root, with
 * one unit and with a pair, and linted strictly, as CLAUDE.md asks of a new genre.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/paths.js")>();
  const root = mkdtempSync(join(tmpdir(), "azeron-genrepads-"));
  for (const dir of ["devices", "templates"])
    cpSync(join(actual.dataRoot, dir), join(root, dir), { recursive: true });
  cpSync(join(actual.repoRoot, "tests/fixtures/defaults/genres"), join(root, "genres"), {
    recursive: true,
  });
  mkdirSync(join(root, "games"));
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

import { repoPath } from "../../../src/config/paths.js";
import { genreDefaults, padRows, SINGLE_UNIT } from "../../../src/lib/defaults.js";
import { loadProfileData } from "../../../src/lib/io.js";
import { lintGame, lintGenre } from "../../../src/lib/lint.js";
import { Game, Genre } from "../../../src/lib/model.js";
import { buildAll, startGame } from "../../../src/lib/tasks.js";
import { XBOX_CONTROLS } from "../../../src/lib/xbox.js";
import { isPadControl } from "../../../src/lib/controls.js";

afterEach(() => {
  rmSync(repoPath("games"), { recursive: true, force: true });
  mkdirSync(repoPath("games"));
  rmSync(repoPath("dist"), { recursive: true, force: true });
});

const genres = Genre.discover();
const PAIR = ["cyborg2-left", "cyborg2-right"];

describe("the eight genres", () => {
  it("are all here, each with a controller layout and a keyboard one", () => {
    expect(genres.map((genre) => genre.name)).toEqual([
      "Action",
      "FPS",
      "Flight",
      "Mech",
      "RPG",
      "SpaceSims",
      "Strategy",
      "Survival",
    ]);
    for (const genre of genres) {
      expect(Object.keys(genre.styles), genre.name).toEqual(
        expect.arrayContaining(["controller", "keyboard"]),
      );
    }
  });

  it.each(genres.map((genre) => [genre.name, genre] as const))(
    "%s lints clean, its pad and its styles included",
    (_name, genre) => {
      expect(lintGenre(genre).live).toEqual([]);
    },
  );

  it.each(genres.map((genre) => [genre.name, genre] as const))(
    "%s puts every control it uses on a real pad, one action each",
    (_name, genre) => {
      const used = Object.values(genre.actions.actions)
        .map((spec) => spec.xbox)
        .filter((control) => control !== undefined);
      expect(used.every((control) => isPadControl(control))).toBe(true);
      expect(new Set(used).size).toBe(used.length);
    },
  );

  it.each(genres.map((genre) => [genre.name, genre] as const))(
    "%s has a pad control for every action it requires",
    (_name, genre) => {
      const missing = Object.entries(genre.actions.actions)
        .filter(([, spec]) => (spec.tags ?? []).includes("required") && spec.xbox === undefined)
        .map(([id]) => id);
      expect(missing).toEqual([]);
    },
  );

  it.each(genres.map((genre) => [genre.name, genre] as const))(
    "%s keeps its menus on View and Menu",
    (_name, genre) => {
      const onPlay = Object.entries(genre.actions.actions)
        .filter(
          ([, spec]) =>
            (spec.tags ?? []).includes("menu") &&
            spec.xbox !== undefined &&
            !["View", "Menu"].includes(spec.xbox),
        )
        .map(([id]) => id);
      expect(onPlay).toEqual([]);
    },
  );

  it("name the pad's controls the same in the table as in the layout", () => {
    for (const genre of genres) {
      const rows = padRows(genre.actions.actions);
      expect(rows.map((row) => row.control)).toEqual(Object.keys(XBOX_CONTROLS));
    }
  });
});

describe("starting each genre in each of its layouts", () => {
  const cases = genres.flatMap((genre) =>
    [...Object.keys(genre.styles), SINGLE_UNIT].map((style) => [genre.name, style] as const),
  );

  it.each(cases)(
    "%s, %s: lints strictly clean, builds, and leaves no control empty",
    (name, style) => {
      const slug = `zz${name}${style}`;
      const result = startGame({
        name: slug,
        slug,
        genre: name,
        devices: style === SINGLE_UNIT ? ["cyborg2-left"] : PAIR,
        set: "v1",
        ...(style === SINGLE_UNIT ? {} : { style }),
      });
      expect(result.leftOff).toEqual([]);
      const game = new Game(`games/${name}/${slug}`);
      expect(lintGame(game).live).toEqual([]);
      expect(buildAll([game]).errors).toEqual([]);
    },
  );
});

describe("the pad and the pair agree", () => {
  const input = (genre: Genre) => ({
    genre: genre.name,
    actions: genre.actions.actions,
    defaults: genre.config.positions,
    styles: genre.styles,
    modes: genre.stickModes,
  });

  it.each(genres.map((genre) => [genre.name, genre] as const))(
    "%s: each action on a pad control sits where that control is on the controller layout",
    (_name, genre) => {
      const controller = genreDefaults(input(genre)).styles.find(
        (style) => style.name === "controller",
      );
      expect(controller?.error).toBeNull();
      for (const row of padRows(genre.actions.actions)) {
        if (row.action === null) continue;
        const place = XBOX_CONTROLS[row.control];
        const hand = place ? controller?.[place.hand] : undefined;
        const at = place === undefined ? undefined : hand?.[place.position];
        // A style that sets its own stick (the pointer) is not the pad's stick, and says so.
        if (place?.direction !== undefined && at?.mode !== "keyboard") continue;
        const found = place?.direction === undefined ? at?.tap : at?.directions?.[place.direction];
        expect(found, `${genre.name} ${row.control}`).toBe(row.action);
      }
    },
  );

  it("shows the Strategy pointer on the left stick in mouse mode, and compiles it", () => {
    startGame({
      name: "zzS",
      slug: "zzS",
      genre: "Strategy",
      devices: PAIR,
      set: "v1",
      style: "controller",
    });
    const left = loadProfileData("games/Strategy/zzS/profiles/v1-left.yaml").positions;
    expect(left.stick).toMatchObject({ mode: "mouse", mouse_sensitivity: 5 });
    expect(buildAll([new Game("games/Strategy/zzS")]).errors).toEqual([]);
  });

  it("sends A and B from keys as the mouse's buttons, with no mouse in the layout", () => {
    startGame({
      name: "zzR",
      slug: "zzR",
      genre: "RPG",
      devices: PAIR,
      set: "v1",
      style: "controller",
    });
    const actions = new Game("games/RPG/zzR").actions.actions;
    expect(actions.select_move).toMatchObject({ mouse: "left", pad: "A" });
    expect(actions.context).toMatchObject({ mouse: "right", pad: "B" });
  });
});

describe("a pair of a mouse genre starts as it did before it had a controller layout", () => {
  it.each(["RPG", "Strategy"])("%s: its one-unit layout on the left, the right empty", (name) => {
    const slug = `zz${name}pair`;
    startGame({ name: slug, slug, genre: name, devices: PAIR, set: "v1" });
    const genre = genres.find((entry) => entry.name === name);
    const left = loadProfileData(`games/${name}/${slug}/profiles/v1-left.yaml`).positions;
    const right = loadProfileData(`games/${name}/${slug}/profiles/v1-right.yaml`).positions;
    expect(Object.keys(left).sort()).toEqual(Object.keys(genre?.config.positions ?? {}).sort());
    expect(right).toEqual({});
    expect(existsSync(repoPath(`games/${name}/${slug}/actions.yaml`))).toBe(true);
  });
});
