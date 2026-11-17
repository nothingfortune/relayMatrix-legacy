/**
 * What the editor is handed about a genre's defaults: its pad and each layout, built as a
 * new game builds them, so the page draws what a game would start with.
 */

import { describe, expect, it } from "vitest";

import { genreDefaults } from "../../../src/lib/defaults.js";
import { buildPayload } from "../../../src/lib/editor/payload.js";
import { Genre } from "../../../src/lib/model.js";

const payload = buildPayload();

describe("the editor payload's genre defaults", () => {
  it("carries every genre's pad and its layouts, the one unit last", () => {
    expect(payload.genres.length).toBeGreaterThan(0);
    for (const genre of payload.genres) {
      expect(genre.defaults?.genre).toBe(genre.name);
      expect(genre.defaults?.pad).toHaveLength(24);
      const names = genre.defaults?.styles.map((style) => style.name) ?? [];
      expect(names.at(-1)).toBe("default");
      expect(names.slice(0, -1)).toEqual(genre.styles?.map((style) => style.name));
    }
  });

  it("is what the same function says of the genre's files", () => {
    for (const genre of Genre.discover()) {
      const carried = payload.genres.find((entry) => entry.name === genre.name);
      const fresh = genreDefaults({
        genre: genre.name,
        actions: genre.actions.actions,
        defaults: genre.config.positions,
        styles: genre.styles,
        modes: genre.stickModes,
      });
      expect(carried?.defaults).toEqual(fresh);
    }
  });

  it("builds each layout without error", () => {
    for (const genre of payload.genres) {
      for (const style of genre.defaults?.styles ?? []) {
        expect(style.error, `${genre.name} ${style.name}`).toBeNull();
      }
    }
  });
});
