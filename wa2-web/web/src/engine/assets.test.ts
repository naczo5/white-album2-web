import { describe, expect, it } from "vitest";
import { bgmIntroUrl, bgmLoopUrl, bgmSoloUrl, bgmTrackUrl, imageUrl, loadManifest, resolveMovieUrl, seUrl, voiceUrl } from "./assets";

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

  it("resolves IC nested-LAC audio under the ic- key namespace", async () => {
    // extract_assets writes nested-LAC IC audio as `ic-<file>` while
    // images/voice use `ic/<file>`; the reader must accept both.
    const body = {
      version: 1,
      images: {},
      bgm: { "ic-BGM_008_B.OGG": "ic/bgm/BGM_008_B.OGG" },
      sfx: { "ic-SE_1002.WAV": "ic/sfx/SE_1002.WAV" },
      voice: {},
      movies: {},
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true, json: async () => body,
    })) as unknown as typeof fetch;
    try {
      await loadManifest("assets/manifest.json");
      expect(bgmTrackUrl(8, "intro")).toBe("assets/ic/bgm/BGM_008_B.OGG");
      expect(seUrl(1002, "intro")).toBe("assets/ic/sfx/SE_1002.WAV");
      expect(bgmTrackUrl(8, "closing")).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("resolves A/B loop parts separately (intro vs body)", async () => {
    const body = {
      version: 1,
      images: {},
      bgm: {
        "BGM_007_A.OGG": "bgm/BGM_007_A.OGG",
        "BGM_007_B.OGG": "bgm/BGM_007_B.OGG",
        "BGM_009.OGG": "bgm/BGM_009.OGG",
        "BGM_003.g": "bgm/BGM_003.ogg",
      },
      sfx: { "SE_0001.w": "sfx/SE_0001.wav" },
      voice: {},
      movies: {},
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true, json: async () => body,
    })) as unknown as typeof fetch;
    try {
      await loadManifest("assets/manifest.json");
      expect(bgmIntroUrl(7)).toBe("assets/bgm/BGM_007_A.OGG");
      expect(bgmLoopUrl(7)).toBe("assets/bgm/BGM_007_B.OGG");
      expect(bgmSoloUrl(9)).toBe("assets/bgm/BGM_009.OGG");
      expect(bgmIntroUrl(9)).toBeNull();
      expect(bgmTrackUrl(9)).toBe("assets/bgm/BGM_009.OGG");
      expect(bgmSoloUrl(3)).toBe("assets/bgm/BGM_003.ogg");
      expect(seUrl(1)).toBe("assets/sfx/SE_0001.wav");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("legacy numeric voice refs chain to the family base for variants", async () => {
    const body = {
      version: 1,
      images: {},
      bgm: {},
      sfx: {},
      voice: { "1008_0199": "voice/1008_0199_01.OGG",
               "1008_020_0199": "voice/1008_020_0199_01.OGG" },
      movies: {},
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true, json: async () => body,
    })) as unknown as typeof fetch;
    try {
      await loadManifest("assets/manifest.json");
      expect(voiceUrl("1008", 199)).toBe("assets/voice/1008_0199_01.OGG");
      expect(voiceUrl("1008_020", 199)).toBe("assets/voice/1008_020_0199_01.OGG");
      expect(voiceUrl("1008_030", 199)).toBe("assets/voice/1008_0199_01.OGG");
      expect(voiceUrl("1008_020", 5)).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
