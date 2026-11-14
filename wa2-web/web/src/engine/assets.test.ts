import { afterEach, describe, expect, it, vi } from "vitest";
import { audioPreloadStatus, bgmIntroUrl, bgmLoopUrl, bgmSoloUrl, bgmTrackUrl, clearAudioPackCache, imageUrl, loadManifest, movieUrl, preloadAudio, resolveAudioUrl, resolveMovieUrl, seUrl, subtitleUrl, voiceUrl } from "./assets";

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

describe("movie subtitle lookup (BYOA WebVTT tracks)", () => {
  const SUB = {
    mv010: "subs/mv010.vtt",
    mv02: "subs/mv02.vtt",
    "mv03.mp4": "subs/mv03.vtt",
  };

  it("uses the same key chain as the movie file", () => {
    // Exact cue id, then the high/low file variants.
    expect(resolveMovieUrl({ mv010: "movie/mv010.mp4" }, "mv01")).not.toBeNull();
    expect(subtitleUrl("mv01")).toBeNull(); // no manifest loaded yet
  });

  it("resolves exact, mvNN0/mvNN1 and .mp4 keys after load", async () => {
    const body = {
      version: 1,
      images: {},
      bgm: {},
      sfx: {},
      voice: {},
      movies: { mv010: "movie/mv010.mp4" },
      subtitles: SUB,
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true, json: async () => body,
    })) as unknown as typeof fetch;
    try {
      await loadManifest("assets/manifest.json");
      expect(subtitleUrl("mv01")).toBe("assets/subs/mv010.vtt");
      expect(subtitleUrl("MV01")).toBe("assets/subs/mv010.vtt");
      expect(subtitleUrl("mv02")).toBe("assets/subs/mv02.vtt");
      expect(subtitleUrl("mv03")).toBe("assets/subs/mv03.vtt");
      expect(subtitleUrl("mv99")).toBeNull();
      // The movie itself still resolves from its own table.
      expect(movieUrl("mv01")).toBe("assets/movie/mv010.mp4");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("tolerates a manifest with no subtitles table", async () => {
    const body = {
      version: 1, images: {}, bgm: {}, sfx: {}, voice: {}, movies: {},
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true, json: async () => body,
    })) as unknown as typeof fetch;
    try {
      await loadManifest("assets/manifest.json");
      expect(subtitleUrl("mv01")).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("rebases absolute subtitle URLs untouched", async () => {
    const body = {
      version: 1, images: {}, bgm: {}, sfx: {}, voice: {}, movies: {},
      subtitles: { mv010: "https://cdn.example/subs/mv010.vtt" },
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true, json: async () => body,
    })) as unknown as typeof fetch;
    try {
      await loadManifest("assets/manifest.json");
      expect(subtitleUrl("mv01")).toBe("https://cdn.example/subs/mv010.vtt");
    } finally {
      globalThis.fetch = origFetch;
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

describe("chunked .vpk audio resolution", () => {
  afterEach(() => {
    clearAudioPackCache();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function blobSpy() {
    const created: { url: string; blob: Blob }[] = [];
    const revoked: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
      const u = `blob:mock/${created.length}`;
      created.push({ url: u, blob: b as Blob });
      return u;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((u) => {
      revoked.push(u);
    });
    return { created, revoked };
  }

  it("returns plain audio URLs unchanged without fetching", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await resolveAudioUrl(null)).toBeNull();
    expect(await resolveAudioUrl("assets/voice/a.ogg")).toBe("assets/voice/a.ogg");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requests only the manifest byte range (no 1.5 MB chunk per voice line)", async () => {
    const payload = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x52, 0x49, 0x46, 0x46, 0x01, 0x02]);
    const ranges: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("range") ?? "";
      ranges.push(range);
      const m = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!m) throw new Error("expected a range request");
      const start = Number(m[1]);
      const end = Number(m[2]) + 1;
      return {
        status: 206,
        ok: true,
        arrayBuffer: async () => payload.slice(start, end).buffer,
      };
    }));
    const { created, revoked } = blobSpy();

    const [oggUrl, wavUrl] = await Promise.all([
      resolveAudioUrl("https://cdn.example/assets/vpk/c0.vpk#0-4"),
      resolveAudioUrl("https://cdn.example/assets/vpk/c0.vpk#4-10:wav"),
    ]);
    expect(ranges.sort()).toEqual(["bytes=0-3", "bytes=4-9"]);
    expect(oggUrl).toBe("blob:mock/0");
    expect(wavUrl).toBe("blob:mock/1");
    expect(created[0].blob.type).toBe("audio/ogg");
    expect(await created[0].blob.arrayBuffer()).toEqual(payload.slice(0, 4).buffer);
    expect(created[1].blob.type).toBe("audio/wav");
    expect(await created[1].blob.arrayBuffer()).toEqual(payload.slice(4, 10).buffer);

    // Cached slice hit returns the same blob URL with zero extra requests.
    expect(await resolveAudioUrl("https://cdn.example/assets/vpk/c0.vpk#0-4")).toBe("blob:mock/0");
    expect(created).toHaveLength(2);
    expect(ranges).toHaveLength(2);

    clearAudioPackCache();
    expect(revoked).toEqual(["blob:mock/1", "blob:mock/0"]);
  });

  it("falls back to one cached full-chunk fetch when Range is refused", async () => {
    const payload = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x52, 0x49, 0x46, 0x46, 0x01, 0x02]);
    let rangeAttempts = 0;
    let fullFetches = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.headers && new Headers(init.headers).has("range")) {
        rangeAttempts++;
        return { status: 416, ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      fullFetches++;
      return {
        status: 200,
        ok: true,
        arrayBuffer: async () => payload.buffer.slice(0),
      };
    }));
    blobSpy();
    const [a, b] = await Promise.all([
      resolveAudioUrl("https://cdn.example/assets/vpk/c0.vpk#0-4"),
      resolveAudioUrl("https://cdn.example/assets/vpk/c0.vpk#4-10"),
    ]);
    expect(a).toBe("blob:mock/0");
    expect(b).toBe("blob:mock/1");
    expect(rangeAttempts).toBe(2);
    expect(fullFetches).toBe(1); // in-flight chunk fetch is shared
  });

  it("ignores a 206 with a wrong length and falls back to the chunk", async () => {
    const payload = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x52, 0x49, 0x46, 0x46, 0x01, 0x02]);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.headers && new Headers(init.headers).has("range")) {
        return { status: 206, ok: true, arrayBuffer: async () => new ArrayBuffer(2) };
      }
      return { status: 200, ok: true, arrayBuffer: async () => payload.buffer.slice(0) };
    }));
    blobSpy();
    const url = await resolveAudioUrl("https://cdn.example/assets/vpk/c0.vpk#0-4");
    expect(url).toBe("blob:mock/0");
  });

  it("tracks preload state so the reader can gate before painting", async () => {
    const payload = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x52, 0x49, 0x46, 0x46, 0x01, 0x02]);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 206,
      ok: true,
      arrayBuffer: async () => payload.slice(0, 4).buffer,
    })));
    blobSpy();
    const url = "https://cdn.example/assets/vpk/c0.vpk#0-4";
    expect(audioPreloadStatus(url)).toBe("none");
    const pending = preloadAudio(url);
    expect(audioPreloadStatus(url)).toBe("pending");
    expect(await pending).toBe("blob:mock/0");
    expect(audioPreloadStatus(url)).toBe("ready");
    expect(audioPreloadStatus(null)).toBe("none");
    expect(audioPreloadStatus("assets/voice/a.ogg")).toBe("ready");
  });

  it("rejects out-of-bounds slices cleanly", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.headers && new Headers(init.headers).has("range")) {
        return { status: 416, ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      return { status: 200, ok: true, arrayBuffer: async () => payload.buffer.slice(0) };
    }));
    expect(await resolveAudioUrl("assets/vpk/c1.vpk#0-10")).toBeNull();
    expect(await resolveAudioUrl("assets/vpk/c1.vpk#3-2")).toBeNull();
  });
});

