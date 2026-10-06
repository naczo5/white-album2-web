import { describe, expect, it } from "vitest";
import { bgmTrackUrl, imageUrl, loadManifest, resolveMovieUrl } from "./assets";

const TABLE = {
  mv000: "movie/mv000.mp4",
  mv010: "movie/mv010.mp4",
  mv011: "movie/mv011.mp4",
  mv100: "movie/mv100.mp4",
};

describe("movie cue resolution (engine mvNN -> file mvNN0/1 pairs)", () => {
  it("prefers the high variant, falls back to low", () => {
    expect(resolveMovieUrl(TABLE, "mv01")).toBe("movie/mv010.mp4");
    expect(resolveMovieUrl({ mv011: "movie/mv011.mp4" }, "mv01")).toBe("movie/mv011.mp4");
    expect(resolveMovieUrl(TABLE, "mv10")).toBe("movie/mv100.mp4");
    expect(resolveMovieUrl(TABLE, "mv99")).toBeNull();
  });

  it("covers every engine cue used by the scenarios", () => {
    const cues = ["mv01", "mv02", "mv07", "mv08", "mv09", "mv10", "mv11",
      "mv12", "mv13", "mv14", "mv20", "mv21", "mv22", "mv23", "mv24"];
    const full: Record<string, string> = {};
    for (const c of cues) {
      full[`${c}0`] = `movie/${c}0.mp4`;
      full[`${c}1`] = `movie/${c}1.mp4`;
    }
    for (const c of cues) {
      expect(resolveMovieUrl(full, c)).toBe(`movie/${c}0.mp4`);
    }
  });
});

describe("manifest URL rebasing (assets/ relative -> page fetchable)", () => {
  it("prefixes the manifest directory onto relative values", async () => {
    const body = {
      version: 1,
      images: { "a.tga": "bg/a.png" },
      bgm: { "BGM_008_A.OGG": "bgm/BGM_008_A.OGG" },
      sfx: {},
      voice: {},
      movies: {},
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true, json: async () => body,
    })) as unknown as typeof fetch;
    try {
      await loadManifest("assets/manifest.json");
      expect(imageUrl("a.tga")).toBe("assets/bg/a.png");
      expect(bgmTrackUrl(8)).toBe("assets/bgm/BGM_008_A.OGG");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
