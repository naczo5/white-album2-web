import { describe, expect, it } from "vitest";
import { resolveBgmTimeline, resolveFade, resolveSeRec, resolveVoiceNnn } from "./reader";

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

describe("voice-number resolver (bnr NNN map + tok fallback)", () => {
  it("prefers the map; null map entry means unvoiced", () => {
    expect(resolveVoiceNnn(12, 99)).toBe(12);
    expect(resolveVoiceNnn(null, 99)).toBeNull();
  });

  it("falls back to comma-tok only with no map", () => {
    expect(resolveVoiceNnn(undefined, 99)).toBe(99);
    expect(resolveVoiceNnn(undefined, undefined)).toBeNull();
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
      { ev: 9, conf: "high" },
    ];
    expect(resolveFade(recs, 1)).toBeNull();
    expect(resolveFade(recs, 2)).toBe(1000);
    expect(resolveFade(recs, 6)).toBe(2000);
    expect(resolveFade(recs, 10)).toBeNull();
  });

  it("ignores hypothesis records", () => {
    expect(resolveFade([{ ev: 1, fadeMs: 500, conf: "hypothesis" }], 5)).toBeNull();
  });
});
