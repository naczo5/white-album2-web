import { describe, expect, it } from "vitest";
import {
  SYS_SIZE,
  buildSysProfile,
  countGalleryRows,
  mergeSysProfile,
  parseSysSave,
} from "./sys-save";
import { Router } from "./router";
import type { FlowData, Scenario, SysProfile, SysSlotsTable } from "./types";

const REGION_A_END = 0x080000;
const REGION_B_START = 0x080000;
const REGION_C_START = 0x268480;

/** Minimal synthetic table: three scripts, one choice script with two nodes. */
function table(): SysSlotsTable {
  return {
    version: 1,
    sysSav: { size: SYS_SIZE, regions: { A: { start: 0, end: REGION_A_END, excludedSlots: [0] } } },
    scripts: ["UNTRUSTED", "1001", "1002"],
    choiceTable: { scriptIds: ["1002"], base: 900, stride: 4 },
    cgRows: [
      [100100, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [100200, 100201, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ],
    endingSlots: { "1": "ic-end", "22": "cc-setsuna", "99": "coda-setsuna-true" },
    endingSlotsConfidence: { "1": "hypothesis", "22": "high", "99": "reserved" },
    gateSlots: { replaySlot: 3, chiakiNormalSlot: 2, codaEnteredSlot: 10, setsunaCcSlot: 22 },
  };
}

function blankSys(): Uint8Array {
  return new Uint8Array(SYS_SIZE);
}

function setBit(buf: Uint8Array, slot: number, bit: number): void {
  const base = slot * 0x200;
  buf[base + (bit >> 3)] = buf[base + (bit >> 3)]! | (0x80 >> (bit & 7));
}

function setFlag(buf: Uint8Array, slot: number, value: number): void {
  new DataView(buf.buffer).setUint32(REGION_C_START + slot * 4, value, true);
}

function ab(buf: Uint8Array): ArrayBuffer {
  return buf.buffer as ArrayBuffer;
}

const SCENARIOS: Scenario[] = [
  {
    script: "1001",
    tokens: 6,
    warnings: [],
    events: [
      { t: "narrate", text: "a" },
      { t: "image", file: "x.tga", layer: "bak" },
      { t: "say", speaker: "A", text: "b" },
      { t: "narrate", text: "c" },
    ],
  },
  {
    script: "1002",
    tokens: 8,
    warnings: [],
    events: [
      { t: "say", speaker: "A", text: "d" },
      { t: "choice", options: [{ n: 1, text: "one", goto: null }, { n: 2, text: "two", goto: null }] },
      { t: "narrate", text: "e" },
      { t: "choice", options: [{ n: 1, text: "x", goto: null }, { n: 2, text: "y", goto: null }, { n: 3, text: "z", goto: null }] },
    ],
  },
];

const FLOW: FlowData = {
  version: 1,
  nodes: [
    {
      id: "1002-3", engine: { script: "1002", event: 3 },
      options: [{ n: 1, text: "x", goto: null }, { n: 2, text: "y", goto: null }, { n: 3, text: "z", goto: null }],
      date: null, effects: {}, gated: {}, walkthrough: null, status: "NEEDS_PLAYTEST",
    },
    {
      // Out of engine order on purpose: the bitmask order is event order.
      id: "1002-1", engine: { script: "1002", event: 1 },
      options: [{ n: 1, text: "one", goto: null }, { n: 2, text: "two", goto: null }],
      date: null, effects: {}, gated: {}, walkthrough: null, status: "NEEDS_PLAYTEST",
    },
  ],
};

function router(): Router {
  return new Router(SCENARIOS, FLOW);
}

describe("parseSysSave", () => {
  it("returns null for a short/truncated buffer", () => {
    const short = new Uint8Array(SYS_SIZE - 1);
    expect(parseSysSave(ab(short), table())).toBeNull();
  });

  it("reads MSB-first bits and drops the excluded slot 0", () => {
    const buf = blankSys();
    setBit(buf, 0, 5); // untrusted bucket: must be dropped
    setBit(buf, 1, 0);
    setBit(buf, 1, 1);
    setBit(buf, 1, 2);
    setBit(buf, 2, 7); // byte 0, LSB of the first byte
    setBit(buf, 2, 8); // byte 1, MSB
    const sys = parseSysSave(ab(buf), table())!;
    expect(sys.readBits.map((r) => r.slot)).toEqual([1, 2]);
    expect(sys.readBits[0]).toEqual({ slot: 1, script: "1001", bits: [0, 1, 2] });
    expect(sys.readBits[1]!.bits).toEqual([7, 8]);
  });

  it("uses the MSB-first mask per byte, not bit position order", () => {
    const buf = blankSys();
    buf[1 * 0x200] = 0x81; // bits 0 and 7 of the first byte
    const sys = parseSysSave(ab(buf), table())!;
    expect(sys.readBits[0]!.bits).toEqual([0, 7]);
  });

  it("reads Region B CG bytes and Region C u32 LE flags", () => {
    const buf = blankSys();
    buf[REGION_B_START + 100100] = 1;
    buf[REGION_B_START + 100201] = 1;
    setFlag(buf, 22, 1);
    setFlag(buf, 101, 1);
    const sys = parseSysSave(ab(buf), table())!;
    expect(sys.cgIds).toEqual([100100, 100201]);
    expect(sys.flags).toHaveLength(1024);
    expect(sys.flags[22]).toBe(1);
    expect(sys.flags[101]).toBe(1);
    expect(sys.flags[0]).toBe(0);
  });
});

describe("buildSysProfile", () => {
  it("maps bits to sequential say/narrate indices and ignores the sentinel", () => {
    const buf = blankSys();
    // 1001 has 3 message events (indices 0, 2, 3) plus the sentinel at 3.
    setBit(buf, 1, 0);
    setBit(buf, 1, 1);
    setBit(buf, 1, 2);
    setBit(buf, 1, 3); // sentinel == msgs.length, not a line
    const sys = parseSysSave(ab(buf), table())!;
    const { profile, readKeys } = buildSysProfile(sys, table(), router(), FLOW, "Sys.sav");
    expect(readKeys).toEqual(["1001:0", "1001:2", "1001:3"]);
    expect(profile.readKeys).toEqual(readKeys);
    expect(profile.visited).toEqual(["1001"]);
    expect(profile.fileName).toBe("Sys.sav");
  });

  it("gates endings on confidence (hypothesis and reserved never unlock)", () => {
    const buf = blankSys();
    setFlag(buf, 1, 1); // ic-end: hypothesis
    setFlag(buf, 22, 1); // cc-setsuna: high
    setFlag(buf, 99, 1); // coda-setsuna-true: reserved (and force-zeroed)
    const sys = parseSysSave(ab(buf), table())!;
    const { profile } = buildSysProfile(sys, table(), router(), FLOW);
    expect(profile.endings).toEqual(["cc-setsuna"]);
    expect(profile.endings).not.toContain("ic-end");
    expect(profile.endings).not.toContain("coda-setsuna-true");
  });

  it("decodes choice bitmasks to per-node option lists in engine order", () => {
    const buf = blankSys();
    // choiceIdx 0 (1002), node index 0 = event 1 (2 options), value 0b11.
    setFlag(buf, 900, 0b11);
    // node index 1 = event 3 (3 options), value 0b111.
    setFlag(buf, 901, 0b111);
    const sys = parseSysSave(ab(buf), table())!;
    const { profile } = buildSysProfile(sys, table(), router(), FLOW);
    expect(profile.seenPicks).toEqual({ "1002-1": [1, 2], "1002-3": [1, 2, 3] });
  });

  it("never reports an option the node does not have", () => {
    const buf = blankSys();
    setFlag(buf, 900, 0b1111); // node has only 2 options
    const sys = parseSysSave(ab(buf), table())!;
    const { profile } = buildSysProfile(sys, table(), router(), FLOW);
    expect(profile.seenPicks).toEqual({ "1002-1": [1, 2] });
  });

  it("reads the music, movie, ero and gate bands", () => {
    const buf = blankSys();
    setFlag(buf, 101, 1); // music track 1
    setFlag(buf, 199, 1); // music track 99
    setFlag(buf, 80, 1); // all-movies sentinel
    setFlag(buf, 201, 1); // movie 1
    setFlag(buf, 224, 1); // movie 24
    setFlag(buf, 300, 1); // ero 0
    setFlag(buf, 322, 1); // ero 22
    setFlag(buf, 3, 1); // replay gate
    setFlag(buf, 10, 1); // codaEntered gate
    const sys = parseSysSave(ab(buf), table())!;
    const { profile } = buildSysProfile(sys, table(), router(), FLOW);
    expect(profile.music).toEqual([1, 99]);
    expect(profile.movies).toEqual([0, 1, 24]);
    expect(profile.ero).toEqual([0, 22]);
    expect(profile.gates).toEqual({ replay: 1, chiakiNormal: 0, codaEntered: 1, setsunaCc: 0 });
  });

  it("keeps the gallery CG set from Region B", () => {
    const buf = blankSys();
    buf[REGION_B_START + 100100] = 1;
    buf[REGION_B_START + 100200] = 1;
    const sys = parseSysSave(ab(buf), table())!;
    const { profile } = buildSysProfile(sys, table(), router(), FLOW);
    expect(profile.cg).toEqual([100100, 100200]);
    expect(countGalleryRows(new Set(profile.cg), table().cgRows)).toEqual({ unlocked: 2, total: 3 });
  });

  it("skips scripts this build does not have", () => {
    const t = table();
    t.scripts = ["UNTRUSTED", "9999"];
    const buf = blankSys();
    setBit(buf, 1, 0);
    const sys = parseSysSave(ab(buf), t)!;
    const { profile, readKeys } = buildSysProfile(sys, t, router(), FLOW);
    expect(readKeys).toEqual([]);
    expect(profile.visited).toEqual([]);
  });
});

describe("countGalleryRows", () => {
  it("counts a row when any nonzero cell id is unlocked", () => {
    const rows = [[1, 0], [0, 0], [2, 3]];
    expect(countGalleryRows([3], rows)).toEqual({ unlocked: 1, total: 3 });
    expect(countGalleryRows(new Set([1, 2]), rows)).toEqual({ unlocked: 2, total: 3 });
    expect(countGalleryRows(new Set(), rows)).toEqual({ unlocked: 0, total: 3 });
  });

  it("ignores zero padding cells", () => {
    expect(countGalleryRows(new Set([0]), [[0, 0]])).toEqual({ unlocked: 0, total: 1 });
  });
});

function baseProfile(): SysProfile {
  return {
    version: 1,
    fileName: "Sys.sav",
    importedAt: "2026-11-13T00:00:00.000Z",
    readKeys: ["1001:0", "1001:2"],
    visited: ["1001"],
    endings: ["cc-setsuna"],
    seenPicks: { "1002-1": [1], "1002-3": [3] },
    cg: [100100, 100200],
    music: [1],
    movies: [1],
    ero: [0],
    gates: { replay: 1, codaEntered: 0 },
  };
}

describe("mergeSysProfile", () => {
  it("returns a sanitized copy of the first profile", () => {
    const p = baseProfile();
    p.readKeys = ["1001:0", "1001:0"];
    const merged = mergeSysProfile(null, p);
    expect(merged.readKeys).toEqual(["1001:0"]);
    expect(merged.visited).toEqual(["1001"]);
  });

  it("unions every band monotonically", () => {
    const existing = baseProfile();
    const incoming: SysProfile = {
      ...baseProfile(),
      fileName: "Sys-2.sav",
      readKeys: ["1001:3", "1001:0"],
      visited: ["1001", "1002"],
      endings: ["cc-koharu"],
      seenPicks: { "1002-1": [2], "1002-3": [1] },
      cg: [100201],
      music: [2],
      movies: [0],
      ero: [22],
      gates: { replay: 0, codaEntered: 1 },
    };
    const merged = mergeSysProfile(existing, incoming);
    expect(merged.readKeys.sort()).toEqual(["1001:0", "1001:2", "1001:3"]);
    expect(merged.visited.sort()).toEqual(["1001", "1002"]);
    expect(merged.endings.sort()).toEqual(["cc-koharu", "cc-setsuna"]);
    expect(merged.seenPicks["1002-1"]).toEqual([1, 2]);
    expect(merged.seenPicks["1002-3"]).toEqual([1, 3]);
    expect(merged.cg).toEqual([100100, 100200, 100201]);
    expect(merged.music).toEqual([1, 2]);
    expect(merged.movies).toEqual([0, 1]);
    expect(merged.ero).toEqual([0, 22]);
    // Gate flags are OR-ed: never cleared by a later import.
    expect(merged.gates).toEqual({ replay: 1, codaEntered: 1 });
    expect(merged.fileName).toBe("Sys-2.sav");
  });

  it("never loses entries when the incoming profile is smaller", () => {
    const existing = baseProfile();
    const incoming: SysProfile = {
      ...baseProfile(),
      readKeys: [],
      visited: [],
      endings: [],
      seenPicks: {},
      cg: [],
      music: [],
      movies: [],
      ero: [],
      gates: {},
    };
    const merged = mergeSysProfile(existing, incoming);
    expect(merged.readKeys).toEqual(existing.readKeys);
    expect(merged.visited).toEqual(existing.visited);
    expect(merged.endings).toEqual(existing.endings);
    expect(merged.seenPicks).toEqual(existing.seenPicks);
    expect(merged.cg).toEqual(existing.cg);
    expect(merged.gates).toEqual(existing.gates);
  });
});
