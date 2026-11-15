import { describe, expect, it } from "vitest";
import type { SysProfile } from "../engine/types";
import {
  MUSIC_BAND_FIRST,
  MUSIC_BAND_LAST,
  cgChapter,
  cgIdUnlocked,
  cgImageCandidates,
  cgRowUnlocked,
  countCgRows,
  musicBandIds,
  musicBandTrack,
  musicUnlocked,
  resolveCgImage,
  sceneUnlocked,
  type SceneSlot,
} from "./gallery";

function profile(overrides: Partial<SysProfile> = {}): SysProfile {
  return {
    version: 1,
    importedAt: "2026-01-01T00:00:00.000Z",
    readKeys: [],
    visited: [],
    endings: [],
    seenPicks: {},
    cg: [],
    music: [],
    movies: [],
    ero: [],
    gates: {},
    ...overrides,
  };
}

describe("CG gallery unlock checks", () => {
  it("accepts bare CG numbers and part-prefixed Region B ids", () => {
    expect(cgIdUnlocked([100100], 100100)).toBe(true);
    expect(cgIdUnlocked([1_100100], 100100)).toBe(true);
    expect(cgIdUnlocked([100100], 1_100100)).toBe(true);
    expect(cgIdUnlocked([100100], 100101)).toBe(false);
    expect(cgIdUnlocked([0], 0)).toBe(false);
    expect(cgIdUnlocked([], 100100)).toBe(false);
  });

  it("unlocks a row when any nonzero cell is known", () => {
    const rows = [[100100, 0], [0, 0], [100200, 100201]];
    expect(cgRowUnlocked(rows[0]!, [100100])).toBe(true);
    expect(cgRowUnlocked(rows[1]!, [100100])).toBe(false);
    expect(cgRowUnlocked(rows[2]!, [1_100201])).toBe(true);
  });

  it("counts rows, not cells, and skips blank cells", () => {
    const rows = [[100100, 0], [0, 0], [100200, 100201], [0, 100300]];
    expect(countCgRows(rows, [100100, 100201])).toEqual({ unlocked: 2, total: 4 });
    expect(countCgRows(rows, [1_100300])).toEqual({ unlocked: 1, total: 4 });
    expect(countCgRows(rows, [])).toEqual({ unlocked: 0, total: 4 });
    expect(countCgRows([], [])).toEqual({ unlocked: 0, total: 0 });
  });
});

describe("music band unlock checks", () => {
  it("walks the 101..174 band and maps it to BGM file numbers", () => {
    const bands = musicBandIds();
    expect(bands).toHaveLength(MUSIC_BAND_LAST - MUSIC_BAND_FIRST + 1);
    expect(bands[0]).toBe(101);
    expect(bands[bands.length - 1]).toBe(174);
    expect(musicBandTrack(101)).toBe(1);
    expect(musicBandTrack(174)).toBe(74);
  });

  it("accepts both profile id conventions (track ids and band slots)", () => {
    expect(musicUnlocked([1], 101)).toBe(true);
    expect(musicUnlocked([101], 101)).toBe(true);
    expect(musicUnlocked([], 101)).toBe(false);
    expect(musicUnlocked([2], 101)).toBe(false);
    expect(musicUnlocked([73], 174)).toBe(false);
    expect(musicUnlocked([74], 174)).toBe(true);
    expect(musicUnlocked([174], 174)).toBe(true);
  });
});

describe("scene replay unlock checks", () => {
  const scene: SceneSlot = { cg: 200100, chapter: 1, script: "synthetic_1", flag: 310 };

  it("unlocks via the gallery CG id", () => {
    expect(sceneUnlocked(scene, profile({ cg: [200100] }))).toBe(true);
    expect(sceneUnlocked(scene, profile({ cg: [1_200100] }))).toBe(true);
    expect(sceneUnlocked(scene, profile({ cg: [200101] }))).toBe(false);
  });

  it("unlocks via the ero band (flag - 300) or a raw game flag", () => {
    expect(sceneUnlocked(scene, profile({ ero: [10] }))).toBe(true);
    expect(sceneUnlocked(scene, profile({ ero: [310] }))).toBe(true);
    expect(sceneUnlocked(scene, profile({ ero: [9] }))).toBe(false);
    expect(sceneUnlocked(scene, profile({ gameFlags: { "310": 1 } }))).toBe(true);
    expect(sceneUnlocked(scene, profile({ gameFlags: { "310": 0 } }))).toBe(false);
  });

  it("stays locked without a profile", () => {
    expect(sceneUnlocked(scene, null)).toBe(false);
  });
});

describe("CG chapter and image candidate generation", () => {
  it("maps id families to the chapter asset namespaces", () => {
    expect(cgChapter(100100)).toBe("intro");
    expect(cgChapter(200100)).toBe("closing");
    expect(cgChapter(220601)).toBe("closing");
    expect(cgChapter(300400)).toBe("coda");
    expect(cgChapter(500100)).toBe("coda");
    expect(cgChapter(990000)).toBe("special");
  });

  it("tries v then h, then repeats under the intro namespace", () => {
    expect(cgImageCandidates(200100)).toEqual([
      { file: "v200100.tga", chapter: "closing" },
      { file: "h200100.tga", chapter: "closing" },
      { file: "tv200100.tga", chapter: "closing" },
      { file: "v200100.tga", chapter: "intro" },
      { file: "h200100.tga", chapter: "intro" },
      { file: "tv200100.tga", chapter: "intro" },
    ]);
  });

  it("does not duplicate the intro retry for intro CGs", () => {
    expect(cgImageCandidates(100100)).toEqual([
      { file: "v100100.tga", chapter: "intro" },
      { file: "h100100.tga", chapter: "intro" },
      { file: "tv100100.tga", chapter: "intro" },
    ]);
  });

  it("normalizes part-prefixed ids before building filenames", () => {
    expect(cgImageCandidates(1_200100)[0]).toEqual({
      file: "v200100.tga",
      chapter: "closing",
    });
  });

  it("resolves the first available candidate in order", () => {
    const calls: string[] = [];
    const url = resolveCgImage(200100, (file, chapter) => {
      calls.push(`${chapter}:${file}`);
      return file === "h200100.tga" && chapter === "closing" ? "assets/cg/200100.png" : null;
    });
    expect(url).toBe("assets/cg/200100.png");
    expect(calls).toEqual([
      "closing:v200100.tga",
      "closing:h200100.tga",
    ]);
  });

  it("returns null when no candidate exists", () => {
    expect(resolveCgImage(200100, () => null)).toBeNull();
  });
});
