import { beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { resolveAmbCue, resolveAmbientEvents, resolveAmbientTimeline, resolveAmbStop, resolveBgmCue, resolveBgmTimeline, resolveFade, resolveSeIds, resolveSeRec, resolveSprites, resolveVoiceRef, renderSpanPartial, resolveStageImage, resolveStageOverlay, skipBlocked, spriteLeftPct } from "./reader";
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
  it("bak cue with sprClear:false (op 147) keeps standing sprites", () => {
    const rs: BnrRec[] = [
      { ev: 1, spr: { id: 1, stem: "kaz001101", pos: 1 }, conf: "high" },
      { ev: 3, layer: "bak", stems: ["100400"], sprClear: false, conf: "high" },
    ];
    expect(resolveSprites(rs, 3)).toEqual([{ id: 1, stem: "kaz001101", pos: 1 }]);
  });
  it("an out-of-order (late-listed) sprClear is applied at its event, not list position", () => {
    // decode regression: tail statements were anchored to ev 0 at the END of
    // the rec list, wiping sprites at every event (1004 showed none). The
    // resolver stable-sorts by ev so list position can't reorder time.
    const rs: BnrRec[] = [
      { ev: 0, spr: { id: 10, stem: "tak001111", pos: 0 }, conf: "high" },
      { ev: 6, spr: { id: 2, stem: "set001113", pos: 2 }, conf: "high" },
      // buggy decode shape: tail statement anchored to ev 0, listed at the end
      { ev: 0, layer: "bak", stems: ["990000"], sprClear: true, conf: "high" },
      { ev: 0, fadeMs: 180, conf: "high" },
    ];
    expect(resolveSprites(rs, 6)).toEqual([{ id: 2, stem: "set001113", pos: 2 }]);
    expect(resolveSprites(rs, 540)).toEqual([{ id: 2, stem: "set001113", pos: 2 }]);
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

  it("returns the A->B loop pair for the player", () => {
    const cues = [{ ev: 3, track: 7 }];
    const resolved = resolveBgmCue(cues, 3, (t) => ({
      url: `bgm/BGM_${t}_A.OGG`, loopUrl: `bgm/BGM_${t}_B.OGG`,
    }));
    expect(resolved).toEqual({
      kind: "play", url: "bgm/BGM_7_A.OGG", loopUrl: "bgm/BGM_7_B.OGG",
    });
    // solo track: loop itself
    expect(resolveBgmCue(cues, 3, (t) => ({
      url: `bgm/BGM_${t}.OGG`, loopUrl: `bgm/BGM_${t}.OGG`,
    }))).toEqual({ kind: "play", url: "bgm/BGM_7.OGG", loopUrl: "bgm/BGM_7.OGG" });
    // missing/unresolvable still sustains
    expect(resolveBgmCue(cues, 3, () => null)).toEqual({ kind: "sustain" });
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

  it("timeline keeps only looping channels and clears a channel on a one-shot", () => {
    const recs = [
      { ev: 3, amb: { se: 1, ch: 0, vol: 100, loop: true }, conf: "high" },
      { ev: 5, amb: { se: 2, ch: 1, vol: 50, loop: false }, conf: "high" },
      { ev: 5, amb: { se: 3, ch: 2, vol: 60, loop: true }, conf: "high" },
      { ev: 6, amb: { se: 4, ch: 0, vol: 40, loop: true }, conf: "high" },
      { ev: 7, amb: { se: 5, ch: 0, vol: 80, loop: false }, conf: "high" },
      { ev: 8, ambStop: 0, conf: "high" },
      { ev: 9, amb: { se: 6, ch: 3, vol: 80, loop: true }, conf: "hypothesis" },
    ];
    const at5 = resolveAmbientTimeline(recs, 5);
    expect(at5.get(0)).toEqual({ kind: "play", cue: { se: 1, ch: 0, vol: 100, loop: true } });
    // A one-shot is fired once by resolveAmbientEvents, never held as state.
    expect(at5.has(1)).toBe(false);
    expect(at5.get(2)).toEqual({ kind: "play", cue: { se: 3, ch: 2, vol: 60, loop: true } });
    // A later loop replaces the earlier one on the same channel.
    expect(resolveAmbientTimeline(recs, 6).get(0)).toEqual({
      kind: "play", cue: { se: 4, ch: 0, vol: 40, loop: true },
    });
    // A one-shot claims the channel and frees it (engine 0x40f400 +
    // channel updater 0x40f8f0 -> 0x40fa54).
    expect(resolveAmbientTimeline(recs, 7).has(0)).toBe(false);
    expect(resolveAmbientTimeline(recs, 8).has(0)).toBe(false);
    expect(resolveAmbientTimeline(recs, 8).get(2)?.kind).toBe("play");
    expect(resolveAmbientTimeline(recs, 100).has(3)).toBe(false); // hypothesis
    // stepping over the background-change events still yields their cues
    expect(resolveAmbientTimeline(recs, 100).size).toBe(1);
  });

  it("fires only the one-shots crossed by a step, in order, high confidence only", () => {
    const recs = [
      { ev: 3, amb: { se: 1, ch: 0, vol: 100, loop: true }, conf: "high" },
      { ev: 5, amb: { se: 2, ch: 1, vol: 50, loop: false }, conf: "high" },
      { ev: 6, amb: { se: 3, ch: 1, vol: 60, loop: false }, conf: "high" },
      { ev: 6, amb: { se: 4, ch: 2, vol: 70, loop: false }, conf: "high" },
      { ev: 7, amb: { se: 5, ch: 3, vol: 80, loop: false }, conf: "hypothesis" },
      { ev: 8, amb: { se: 6, ch: 0, vol: 90, loop: false }, conf: "high" },
    ];
    const oneShots = (from: number, to: number) =>
      resolveAmbientEvents(recs, from, to)
        .flatMap((e) => e.kind === "play" && !e.cue.loop ? [e.cue.se] : []);
    expect(oneShots(4, 6)).toEqual([2, 3, 4]);
    expect(oneShots(5, 8)).toEqual([3, 4, 6]);
    // Re-rendering at one event (from == to) fires nothing.
    expect(oneShots(6, 6)).toEqual([]);
    // A segment boundary excludes the cue that belongs to the previous step.
    expect(oneShots(6, 7)).toEqual([]); // only hypothesis at 7
  });

  it("keeps play/stop order within one event (engine statement order)", () => {
    const recs = [
      { ev: 5, amb: { se: 1, ch: 0, vol: 100, loop: true }, conf: "high" },
      { ev: 6, amb: { se: 2, ch: 0, vol: 80, loop: false }, conf: "high" },
      { ev: 6, ambStop: 0, conf: "high" },
      { ev: 6, amb: { se: 3, ch: 0, vol: 90, loop: false }, conf: "high" },
    ];
    expect(resolveAmbientEvents(recs, 5, 6).map((e) => e.kind)).toEqual([
      "play", "stop", "play",
    ]);
    expect(resolveAmbientEvents(recs, 5, 6)[2]).toMatchObject({
      kind: "play", cue: { se: 3 },
    });
  });
});

/** The reported regression (closing chapter, 2003): the last one-shot
 * SE 8258 in the scene used to be kept as live channel state, so every line
 * after it restarted the bell. Event numbers differ between JP-spine and
 * special-pak builds, so locate the cue instead of pinning an ev. */
const BYOA_DATA = process.env.WA2_DATA_DIR;
const BYOA_BNR = BYOA_DATA ? `${BYOA_DATA.replace(/\/+$/, "")}/bnr.json` : "";
const HAS_BNR = !!BYOA_BNR && fs.existsSync(BYOA_BNR);

describe.skipIf(!HAS_BNR)("2003 ambience regression (BYOA bnr.json)", () => {
  it("does not resurrect the last SE 8258 one-shot later in the scene", () => {
    const bnr = JSON.parse(fs.readFileSync(BYOA_BNR, "utf8")) as {
      recs: Record<string, { ev: number; amb?: { se: number; ch: number; vol: number; loop: boolean }; ambStop?: number; conf: string }[]>;
    };
    const recs = bnr.recs["2003"];
    expect(recs).toBeTruthy();
    const last = recs.filter((r) => r.amb?.se === 8258 && !r.amb.loop).pop();
    expect(last).toBeTruthy();
    const ev = last!.ev;
    const fired = resolveAmbientEvents(recs, ev - 1, ev)
      .some((e) => e.kind === "play" && e.cue.se === 8258);
    expect(fired).toBe(true);
    // The very next render must not fire it again, and the loop timeline
    // must not retain it as channel state.
    const replayed = resolveAmbientEvents(recs, ev, ev + 1)
      .some((e) => e.kind === "play" && e.cue.se === 8258);
    expect(replayed).toBe(false);
    const timeline = resolveAmbientTimeline(recs, ev + 1);
    expect([...timeline.values()].some((v) =>
      v.kind === "play" && v.cue.se === 8258)).toBe(false);
  });
});

describe("read-only skip gate", () => {
  it("stops at a line that was unread before this render", () => {
    expect(skipBlocked(true, true, false)).toBe(true);
    expect(skipBlocked(true, true, true)).toBe(false);
    expect(skipBlocked(false, true, false)).toBe(false); // not skipping
    expect(skipBlocked(true, false, false)).toBe(false); // skip-all setting
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
    // Real 1002 start: evening rooftop 100101 (tod=1) can precede daytime
    // 100400 in raw decode order; statement order still picks the last cue.
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

  it("grp stems never fall through to b* backdrops (op 148 = v%06d.tga)", () => {
    const bnr = [{ ev: 460, layer: "grp" as const, stems: ["200101"], conf: "high" as const }];
    const txt = [txtEv({ t: "image", file: "g.tga", layer: "grp" }, 432)];
    // b200101 exists but a grp cue must not load it: older overlay wins.
    expect(resolveStageOverlay(txt, bnr, 470, "intro")).toBe("assets/cg/g.png");
  });

  it("txt grp images are overlays, never stage backdrops", () => {
    // The txt image driver routes `grp` to the overlay layer. Treating it
    // as a backdrop made a CG become the floor after the overlay cleared.
    const txt = [txtEv({ t: "image", file: "g.tga", layer: "grp" }, 10)];
    expect(resolveStageImage(txt, null, 20, "closing")).toBeNull();
    expect(resolveStageOverlay(txt, null, 20, "closing")).toBe("assets/cg/g.png");
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

  it("range resolver fires every cue crossed by a step, in order", () => {
    const recs = [
      { ev: 4, se: [1], conf: "high" },
      { ev: 6, se: [2, 3], conf: "high" },
      { ev: 8, se: [9], conf: "hypothesis" },
    ];
    expect(resolveSeIds(recs, 3, 6)).toEqual([1, 2, 3]);
    expect(resolveSeIds(recs, 3, 5)).toEqual([1]);
    expect(resolveSeIds(recs, 6, 6)).toEqual([]); // re-render: nothing replayed
    expect(resolveSeIds(recs, 7, 9)).toEqual([]); // hypothesis ignored
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

describe("CFG executedRanges branch filtering", () => {
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

  it("excludes skipped-branch stage backdrops, overlays, and fades", () => {
    const ranges: [number, number][] = [[0, 10], [30, 50]];
    const txt = [
      { e: { t: "image" as const, file: "b200101.tga", layer: "bak" as const }, i: 15 },
      { e: { t: "image" as const, file: "g.tga", layer: "grp" as const }, i: 20 },
    ];
    const bnr: BnrRec[] = [
      { ev: 5, layer: "bak", stems: ["100400"], fadeMs: 400, conf: "high" },
      { ev: 20, layer: "bak", clear: true, fadeMs: 900, conf: "high" },
    ];
    // Event 15/20 were never executed, so b100400 and fade 400 stay active at event 40
    expect(resolveStageImage(txt, bnr, 40, "intro", ranges)).toBe("assets/ic/bg/b100400.png");
    expect(resolveStageOverlay(txt, bnr, 40, "closing", ranges)).toBeNull();
    expect(resolveFade(bnr, 40, ranges)).toBe(400);
  });

  it("excludes skipped-branch BGM, SE, ambient, and standing sprite cues", () => {
    const ranges: [number, number][] = [[0, 10], [30, 50]];
    const bgmCues = [
      { ev: 4, track: 10 },
      { ev: 20, stop: true },
      { ev: 35, track: 22 },
    ];
    expect(resolveBgmCue(bgmCues, 31, (t) => ({ url: `bgm/${t}.ogg` }), ranges)).toEqual({
      kind: "play",
      url: "bgm/10.ogg",
    });
    expect(resolveBgmTimeline(bgmCues, 31, (t) => `bgm/${t}.ogg`, ranges)).toEqual({
      kind: "play",
      url: "bgm/10.ogg",
    });
    expect(resolveBgmTimeline(bgmCues, 35, (t) => `bgm/${t}.ogg`, ranges)).toEqual({
      kind: "play",
      url: "bgm/22.ogg",
    });

    const bnr: BnrRec[] = [
      { ev: 4, se: [100], amb: { se: 50, ch: 0, vol: 128, loop: true }, spr: { id: 1, stem: "kaz001101", pos: 1 }, conf: "high" },
      { ev: 20, se: [999], ambStop: 0, sprHide: 1, conf: "high" },
      { ev: 32, se: [200], spr: { id: 2, stem: "set001101", pos: 0 }, conf: "high" },
    ];
    expect(resolveSeIds(bnr, 3, 40, ranges)).toEqual([100, 200]);
    expect(resolveAmbientTimeline(bnr, 40, ranges).get(0)).toEqual({
      kind: "play",
      cue: { se: 50, ch: 0, vol: 128, loop: true },
    });
    expect(resolveSprites(bnr, 40, ranges)).toEqual([
      { id: 1, stem: "kaz001101", pos: 1 },
      { id: 2, stem: "set001101", pos: 0 },
    ]);
  });
});

