import { beforeAll, describe, expect, it } from "vitest";
import { resolveAmbCue, resolveAmbStop, resolveBgmTimeline, resolveFade, resolveSeRec, resolveSprites, resolveVoiceRef, renderSpanPartial, resolveStageImage, resolveStageOverlay, spriteLeftPct } from "./reader";
import { loadManifest } from "../engine/assets";
import type { BnrRec } from "../engine/types";

describe("sprite timeline (bnr (4,154)/(4,155) shows + (4,156)/(4,157) hides)", () => {
  const recs: BnrRec[] = [
    { ev: 3, spr: { id: 1, stem: "kaz001101", pos: 1 }, conf: "high" },
    { ev: 7, spr: { id: 2, stem: "set001101", pos: 0 }, conf: "high" },
    { ev: 9, sprHide: 1, conf: "high" },
    { ev: 11, spr: { id: 1, stem: "kaz001104", pos: 2 }, conf: "hypothesis" },
    { ev: 12, spr: { id: 1, stem: "kaz001104", pos: 2 }, conf: "high" },
  ];
  it("latest show per character id at/before the event wins", () => {
    expect(resolveSprites(recs, 0)).toEqual([]);
    expect(resolveSprites(recs, 3)).toEqual([{ id: 1, stem: "kaz001101", pos: 1 }]);
    expect(resolveSprites(recs, 7)).toEqual([
      { id: 1, stem: "kaz001101", pos: 1 },
      { id: 2, stem: "set001101", pos: 0 },
    ]);
  });
  it("hide clears the character; hypothesis recs are ignored; draw order kept", () => {
    expect(resolveSprites(recs, 9)).toEqual([{ id: 2, stem: "set001101", pos: 0 }]);
    expect(resolveSprites(recs, 11)).toEqual([{ id: 2, stem: "set001101", pos: 0 }]);
    expect(resolveSprites(recs, 12)).toEqual([
      { id: 2, stem: "set001101", pos: 0 },
      { id: 1, stem: "kaz001104", pos: 2 },
    ]);
  });
  it("a show of the same char replaces pose+position in place", () => {
    const rs: BnrRec[] = [
      { ev: 1, spr: { id: 10, stem: "tak001102", pos: 0 }, conf: "high" },
      { ev: 2, spr: { id: 2, stem: "set001106", pos: 1 }, conf: "high" },
      { ev: 3, spr: { id: 10, stem: "tak001104", pos: 2 }, conf: "high" },
    ];
    expect(resolveSprites(rs, 3)).toEqual([
      { id: 10, stem: "tak001104", pos: 2 },
      { id: 2, stem: "set001106", pos: 1 },
    ]);
  });
  it("a backdrop show/clear wipes all sprites (sprClear), keeping same-ev re-shows", () => {
    const rs: BnrRec[] = [
      { ev: 1, spr: { id: 1, stem: "kaz001101", pos: 1 }, conf: "high" },
      { ev: 5, layer: "bak", stems: ["100700"], sprClear: true, conf: "high" },
      { ev: 6, spr: { id: 10, stem: "tak001106", pos: 1 }, conf: "high" },
    ];
    expect(resolveSprites(rs, 4)).toEqual([{ id: 1, stem: "kaz001101", pos: 1 }]);
    expect(resolveSprites(rs, 6)).toEqual([{ id: 10, stem: "tak001106", pos: 1 }]);
    // same-event re-show after the wipe survives (statement order)
    const rs2: BnrRec[] = [
      { ev: 1, spr: { id: 1, stem: "kaz001101", pos: 1 }, conf: "high" },
      { ev: 5, layer: "bak", stems: ["100700"], sprClear: true, conf: "high" },
      { ev: 5, spr: { id: 2, stem: "set001210", pos: 2 }, conf: "high" },
    ];
    expect(resolveSprites(rs2, 5)).toEqual([{ id: 2, stem: "set001210", pos: 2 }]);
  });
});

describe("sprite screen positions (exe 0x4be0bc table)", () => {
  it("maps position indices to stage-% left coordinates", () => {
    expect(spriteLeftPct(null)).toBe(50);
    expect(spriteLeftPct(1)).toBe(50); // 0 offset = centre
    expect(spriteLeftPct(0)).toBeCloseTo((640 - 288) / 1280 * 100, 5);
    expect(spriteLeftPct(2)).toBeCloseTo((640 + 288) / 1280 * 100, 5);
    expect(spriteLeftPct(5)).toBeCloseTo((640 - 480) / 1280 * 100, 5);
    expect(spriteLeftPct(9)).toBeCloseTo((640 + 160) / 1280 * 100, 5);
    expect(spriteLeftPct(11)).toBe(50); // out of table -> centred
    expect(spriteLeftPct(-1)).toBe(50);
  });
});

const RESOLVE = (t: number) => `bgm/BGM_${String(t).padStart(3, "0")}_B.OGG`;

describe("BGM timeline (bnr (4,158) cues)", () => {
  it("plays the latest cue at/before the event", () => {
    const cues = [{ ev: 3, track: 7 }, { ev: 60, track: 1 }];
    expect(resolveBgmTimeline(cues, 0, RESOLVE)).toEqual({ kind: "sustain" });
    expect(resolveBgmTimeline(cues, 3, RESOLVE)).toEqual({
      kind: "play", url: "bgm/BGM_007_B.OGG",
    });
    expect(resolveBgmTimeline(cues, 100, RESOLVE)).toEqual({
      kind: "play", url: "bgm/BGM_001_B.OGG",
    });
  });

  it("stops silence; files without cues inherit (sustain)", () => {
    const cues = [{ ev: 3, track: 7 }, { ev: 60, stop: true }];
    expect(resolveBgmTimeline(cues, 59, RESOLVE).kind).toBe("play");
    expect(resolveBgmTimeline(cues, 60, RESOLVE)).toEqual({ kind: "stop" });
    expect(resolveBgmTimeline([], 10, RESOLVE)).toEqual({ kind: "sustain" });
  });

  it("missing tracks sustain instead of cutting to silence", () => {
    const cues = [{ ev: 3, track: 7 }, { ev: 60, track: 5, missing: true }];
    expect(resolveBgmTimeline(cues, 61, RESOLVE)).toEqual({
      kind: "play", url: "bgm/BGM_007_B.OGG",
    });
  });

  it("unresolvable files (assets not installed) sustain", () => {
    const cues = [{ ev: 3, track: 7 }];
    expect(resolveBgmTimeline(cues, 3, () => null)).toEqual({ kind: "sustain" });
  });

  it("a later stop beats an earlier play and vice versa", () => {
    const cues = [{ ev: 3, stop: true }, { ev: 60, track: 1 }];
    expect(resolveBgmTimeline(cues, 10, RESOLVE)).toEqual({ kind: "stop" });
    expect(resolveBgmTimeline(cues, 60, RESOLVE).kind).toBe("play");
  });
});

describe("ambient channel resolvers (4,165 cue / 4,166 stop)", () => {
  const RECS = [
    { ev: 5, amb: { se: 3019, ch: 0, vol: 128, loop: true }, conf: "high" },
    { ev: 9, ambStop: 0, conf: "high" },
    { ev: 12, amb: { se: 7, ch: 2, vol: 60, loop: false }, conf: "hypothesis" },
  ];

  it("fires only high-confidence cues at the exact event", () => {
    expect(resolveAmbCue(RECS, 5)).toEqual({ se: 3019, ch: 0, vol: 128, loop: true });
    expect(resolveAmbCue(RECS, 12)).toBeNull(); // hypothesis: ignored
    expect(resolveAmbCue(RECS, 6)).toBeNull();
  });

  it("resolves channel stops", () => {
    expect(resolveAmbStop(RECS, 9)).toBe(0);
    expect(resolveAmbStop(RECS, 5)).toBeNull();
  });
});

describe("voice resolver (archive-key/NNN map + tok fallback)", () => {
  it("prefers the map; null map entry means unvoiced", () => {
    expect(resolveVoiceRef(12, 99)).toBe(12);
    expect(resolveVoiceRef(null, 99)).toBeNull();
  });

  it("passes exact archive keys through (voicemap v2)", () => {
    expect(resolveVoiceRef("1008_0199", 199)).toBe("1008_0199");
    expect(resolveVoiceRef("ic/1002_0000", undefined)).toBe("ic/1002_0000");
  });

  it("falls back to comma-tok only with no map", () => {
    expect(resolveVoiceRef(undefined, 99)).toBe(99);
    expect(resolveVoiceRef(undefined, undefined)).toBeNull();
  });
});

describe("typewriter partial rendering (escape-before-break)", () => {
  it("converts engine breaks without leaking literal tags", () => {
    expect(renderSpanPartial({ text: "a\\nb" }, 10)).toBe("<span>a<br>b</span>");
    expect(renderSpanPartial({ text: "a\\kb" }, 10)).toBe("<span>a<br><br>b</span>");
  });

  it("escapes HTML in the source text", () => {
    const html = renderSpanPartial({ text: "<F16 hi>" }, 10);
    expect(html).not.toContain("<F16");
  });

  it("reveals prefixes without breaking entities", () => {
    const full = renderSpanPartial({ text: "ab&cd" }, 99);
    const part = renderSpanPartial({ text: "ab&cd" }, 3);
    expect(full).toBe("<span>ab&amp;cd</span>");
    expect(part).toBe("<span>ab&amp;</span>");
  });
});

describe("merged stage timeline (txt images + bnr backdrops)", () => {
  const MANIFEST = {
    version: 1,
    images: {
      "ic/b100400.tga": "ic/bg/b100400.png",
      "b200101.tga": "bg/b200101.png",
      "g.tga": "cg/g.png",
    },
    bgm: {},
    sfx: {},
    voice: {},
    movies: {},
  };
  const origFetch = globalThis.fetch;
  beforeAll(async () => {
    globalThis.fetch = (async () => ({
      ok: true, json: async () => MANIFEST,
    })) as unknown as typeof fetch;
    await loadManifest("assets/manifest.json");
    globalThis.fetch = origFetch;
  });

  const txtEv = (e: { t: string; file?: string; layer?: string }, i: number) => ({
    e: e as { t: "image"; file: string; layer: "bak" | "grp" | null },
    i,
  });

  it("bnr classroom shows long before the first txt image (1002 early game)", () => {
    const txt = [txtEv({ t: "image", file: "g.tga", layer: "grp" }, 432)];
    const bnr = [{ ev: 6, layer: "bak" as const, stems: ["100400"], fade: 30, conf: "high" as const }];
    expect(resolveStageImage(txt, bnr, 34, "intro")).toBe("assets/ic/bg/b100400.png");
  });

  it("later txt backdrops win; clear is a barrier", () => {
    const txt = [txtEv({ t: "image", file: "b200101.tga", layer: "bak" }, 500)];
    const bnr = [{ ev: 6, layer: "bak" as const, stems: ["100400"], conf: "high" as const }];
    expect(resolveStageImage(txt, bnr, 600, "closing")).toBe("assets/bg/b200101.png");
    const cleared = [{ ev: 550, layer: "bak" as const, clear: true, conf: "high" as const }];
    expect(resolveStageImage(txt, cleared, 600, "closing")).toBeNull();
  });

  it("same-event bak cues apply in statement order: last wins (1002 ev0)", () => {
    // Real 1002 start: cue 100100 (b* missing on disc) then 100400
    // (classroom). The engine executes statements in order — the later
    // cue wins even though the earlier one resolves.
    const bnr = [
      { ev: 0, layer: "bak" as const, stems: ["100100"], fade: 60, conf: "high" as const },
      { ev: 0, layer: "bak" as const, stems: ["100400"], fade: 60, conf: "high" as const },
    ];
    expect(resolveStageImage([], bnr, 8, "intro")).toBe("assets/ic/bg/b100400.png");
  });

  it("bak stems never fall through to v* CGs (op 146 = B%04d%1d%1d.tga)", () => {
    // Only the CG v100100 exists; the bak cue must NOT show it. The
    // previous backdrop (older cue) stays, matching the engine's failed
    // image load.
    const bnr = [
      { ev: 0, layer: "bak" as const, stems: ["100400"], conf: "high" as const },
      { ev: 5, layer: "bak" as const, stems: ["100100"], conf: "high" as const },
    ];
    expect(resolveStageImage([], bnr, 8, "intro")).toBe("assets/ic/bg/b100400.png");
  });

  it("grp stems never fall through to b* backdrops (ops 147/148 = v%06d.tga)", () => {
    const bnr = [{ ev: 460, layer: "grp" as const, stems: ["200101"], conf: "high" as const }];
    const txt = [txtEv({ t: "image", file: "g.tga", layer: "grp" }, 432)];
    // b200101 exists but a grp cue must not load it: older overlay wins.
    expect(resolveStageOverlay(txt, bnr, 470, "intro")).toBe("assets/cg/g.png");
  });

  it("overlays show grp art and reset on backdrops", () => {
    const txt = [
      txtEv({ t: "image", file: "g.tga", layer: "grp" }, 432),
      txtEv({ t: "image", file: "b200101.tga", layer: "bak" }, 500),
    ];
    expect(resolveStageOverlay(txt, null, 450, "intro")).toBe("assets/cg/g.png");
    expect(resolveStageOverlay(txt, null, 550, "intro")).toBeNull();
    const bnr = [{ ev: 460, layer: "grp" as const, stems: ["v100100"], conf: "high" as const }];
    // v100100 not installed here: falls through to the older overlay
    expect(resolveStageOverlay(txt, bnr, 470, "intro")).toBe("assets/cg/g.png");
  });
});

describe("SE trigger gate (bnr confidence)", () => {
  it("fires only high-confidence records", () => {
    const recs = [
      { ev: 5, se: [447], conf: "hypothesis" },
      { ev: 6, se: [448], conf: "high" },
    ];
    expect(resolveSeRec(recs, 5)).toBeNull();
    expect(resolveSeRec(recs, 6)).toBe(448);
    expect(resolveSeRec(recs, 7)).toBeNull();
  });
});

describe("fade resolver (bnr fadeMs)", () => {
  it("returns the latest high-confidence fade, capped", () => {
    const recs = [
      { ev: 2, fadeMs: 1000, conf: "high" },
      { ev: 5, fadeMs: 99999, conf: "high" },
      { ev: 9, stems: ["100400"], conf: "high" },
    ];
    expect(resolveFade(recs, 1)).toBeNull();
    expect(resolveFade(recs, 2)).toBe(1000);
    expect(resolveFade(recs, 6)).toBe(2000);
    // image change without fade value: default timing
    expect(resolveFade(recs, 10)).toBeNull();
  });

  it("ignores non-visual records without resetting", () => {
    const recs = [
      { ev: 2, fadeMs: 1000, conf: "high" },
      { ev: 5, se: [447], conf: "high" },
    ];
    expect(resolveFade(recs, 6)).toBe(1000);
  });

  it("ignores hypothesis records", () => {
    expect(resolveFade([{ ev: 1, fadeMs: 500, conf: "hypothesis" }], 5)).toBeNull();
  });
});
