import { describe, expect, it } from "vitest";
import {
  NATIVE_SAVE_SIZE,
  cleanNativeOption,
  decodeWa2Text,
  findNativeCandidates,
  findNativePosition,
  nativeAnchorKey,
  nativeToSave,
  normalizeNativeText,
  parseNativeFile,
  parseNativeSave,
} from "./native-save";
import { deserialize, serialize } from "./save";
import type { NativePosData, Scenario } from "./types";

function writeAscii(buf: Uint8Array, off: number, s: string): void {
  for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i) & 0x7f;
}

function writeU16(buf: Uint8Array, off: number, n: number): void {
  buf[off] = n & 0xff;
  buf[off + 1] = (n >> 8) & 0xff;
}

function writeU32(buf: Uint8Array, off: number, n: number): void {
  buf[off] = n & 0xff;
  buf[off + 1] = (n >> 8) & 0xff;
  buf[off + 2] = (n >> 16) & 0xff;
  buf[off + 3] = (n >> 24) & 0xff;
}

function nativeBuffer(opts: {
  script?: string;
  text?: string;
  speaker?: string;
  preview?: string;
  options?: string[];
  route?: string;
  scriptPos?: number;
  parseMode?: number;
  layout?: number;
  vmVersion?: string;
  jumpCount?: number;
  argCount?: number;
  optionCount?: number;
  ints?: Record<number, number>;
  floats?: Record<number, number>;
} = {}): ArrayBuffer {
  const buf = new Uint8Array(NATIVE_SAVE_SIZE);
  writeAscii(buf, 0x203d8, opts.script ?? "2003");
  writeAscii(buf, 0x203d8 + 5, opts.route ?? "030");
  writeAscii(buf, 0x112c2, opts.text ?? "For all her physical beauty, I had never met a woman.");
  writeAscii(buf, 0x116c4, opts.speaker ?? "");
  writeAscii(buf, 0x18, opts.preview ?? "Preview text");
  const options = opts.options ?? ['"1. Go left"', "'2. Stay here'"];
  writeU32(buf, 0x11710, opts.optionCount ?? options.length);
  options.forEach((o, i) => writeAscii(buf, 0x11714 + i * 0x100, o));
  writeU16(buf, 0x08, 2026);
  writeU16(buf, 0x0a, 9);
  writeU16(buf, 0x0c, 3);
  writeU16(buf, 0x0e, 23);
  writeU16(buf, 0x10, 23);
  writeU16(buf, 0x12, 16);
  writeU16(buf, 0x14, 25);
  buf[0] = 2;
  // Exact VM signature: PC save v2 / VM 1.00 / single-script layout 4.
  writeAscii(buf, 0x134d4, opts.vmVersion ?? "1.00");
  writeU32(buf, 0x134d8, opts.layout ?? 4);
  writeU32(buf, 0x1c01c, opts.parseMode ?? 131);
  writeU32(buf, 0x1c18c, opts.scriptPos ?? 0x37ac0);
  writeU32(buf, 0x203d4, opts.jumpCount ?? 0);
  writeU32(buf, 0x1d590, opts.argCount ?? 0);
  const dv = new DataView(buf.buffer);
  for (const [i, v] of Object.entries(opts.ints ?? {})) {
    dv.setInt32(0x1d594 + Number(i) * 64, v, true);
  }
  for (const [i, v] of Object.entries(opts.floats ?? {})) {
    dv.setFloat32(0x1dc14 + Number(i) * 64, v, true);
  }
  return buf.buffer;
}

const scenario: Scenario = {
  script: "2003",
  tokens: 10,
  warnings: [],
  events: [
    { t: "narrate", text: "Something else entirely." },
    { t: "narrate", text: "For all her physical beauty, I had never met a woman." },
    { t: "choice", options: [
      { n: 1, text: "Go left", goto: null },
      { n: 2, text: "Stay here", goto: null },
    ] },
  ],
};

describe("native save parser", () => {
  it("reads the slot header, line, speaker and options", () => {
    const save = parseNativeSave(nativeBuffer());
    expect(save).not.toBeNull();
    expect(save!.script).toBe("2003");
    expect(save!.route).toBe("030");
    expect(save!.text).toContain("For all her physical beauty");
    expect(save!.options).toEqual(["Go left", "Stay here"]);
    expect(save!.timestamp).toBe("2026-09-23 23:16:25");
  });

  it("decodes the exact VM signature and frame-0 locals", () => {
    const save = parseNativeSave(nativeBuffer({
      scriptPos: 0x37ac0,
      ints: { 0: 1, 5: 3201, 19: 3200 },
      floats: { 23: -960 },
    }))!;
    expect(save.signature).toBe("exact");
    expect(save.vmVersion).toBe("1.00");
    expect(save.layout).toBe(4);
    expect(save.parseMode).toBe(131);
    expect(save.scriptPos).toBe(0x37ac0);
    // Flat 52: 26 ints then 26 floats, frame 0 only (stride 64).
    expect(save.locals).toHaveLength(52);
    expect(save.locals.slice(0, 5)).toEqual([1, 0, 0, 0, 0]);
    expect(save.locals[5]).toBe(3201);
    expect(save.locals[19]).toBe(3200);
    expect(save.locals[26 + 23]).toBe(-960);
    expect(save.jumpCount).toBe(0);
    expect(save.jumpStack).toEqual([]);
    expect(save.argCount).toBe(0);
  });

  it("summarizes jump-stack records instead of dropping them", () => {
    const ab = nativeBuffer({ jumpCount: 2 });
    const dv = new DataView(ab);
    dv.setUint32(0x1e4a8, 3, true);
    dv.setUint32(0x1e4a8 + 4, 7, true);
    dv.setUint32(0x1e4a8 + 12, 0x1234, true);
    dv.setUint32(0x1e4a8 + 528, 1, true);
    const save = parseNativeSave(ab)!;
    expect(save.jumpCount).toBe(2);
    expect(save.jumpStack[0]).toEqual({ type: 3, count: 7, end: 0x1234, condition: 1 });
    expect(save.jumpStack[1]).toEqual({ type: 0, count: 0, end: 0, condition: 0 });
  });

  it("fails closed on every signature mismatch", () => {
    const bad: [string, ArrayBuffer][] = [
      ["short file", nativeBuffer().slice(0, 1024)],
      ["version 1", (() => { const b = nativeBuffer(); new Uint8Array(b)[0] = 1; return b; })()],
      ["vm version", nativeBuffer({ vmVersion: "1.01" })],
      ["layout", nativeBuffer({ layout: 5 })],
      ["parse mode", nativeBuffer({ parseMode: 130 })],
      ["jump count", nativeBuffer({ jumpCount: 16 })],
      ["arg count", nativeBuffer({ argCount: 257 })],
      ["option count", (() => { const b = nativeBuffer(); writeU32(new Uint8Array(b), 0x11710, 4); return b; })()],
      ["nested script slot", (() => {
        const b = nativeBuffer();
        new Uint8Array(b)[0x134e0 + 53648 + 40] = 1;
        return b;
      })()],
      ["nested local frame", (() => {
        const b = nativeBuffer();
        new Uint8Array(b)[0x1d594 + 4] = 1;
        return b;
      })()],
    ];
    for (const [label, buffer] of bad) {
      expect(parseNativeSave(buffer), label).toBeNull();
      expect(parseNativeFile(buffer, "save_01.sav").kind, label).toBe("unknown");
    }
  });

  it("truncates the speaker field at the native 16-byte slot", () => {
    const b = nativeBuffer();
    // A full 16-byte speaker with no NUL must not absorb option 1.
    writeAscii(new Uint8Array(b), 0x116c4, "Automated Phone!");
    expect(parseNativeSave(b)!.speaker).toBe("Automated Phone!");
    expect(parseNativeSave(b)!.options[0]).toBe("Go left");
  });

  it("detects the system save by name or fixed size", () => {
    const named = parseNativeFile(new ArrayBuffer(16), "Sys.sav");
    expect(named.kind).toBe("system");
    const sized = parseNativeFile(new ArrayBuffer(2528384), "whatever.sav");
    expect(sized.kind).toBe("system");
  });

  it("normalizes soft wraps and punctuation", () => {
    expect(normalizeNativeText("For all her physical beauty~ I had\\nnever met her."))
      .toBe("for all her physical beauty i had never met her");
    // CK-GAL/Japanese quote brackets are separators too, not word characters.
    expect(normalizeNativeText("「そうか」…… I see.")).toBe("そうか i see");
  });

  it("decodes CK-GAL private glyphs, mixed runs and a truncated lead byte", () => {
    // The iOS port's private map: 0x89 + 0x7f trail is a CJK fill-in glyph.
    expect(decodeWa2Text(Uint8Array.from([0x89, 0x7f]))).toBe("蹑");
    expect(decodeWa2Text(Uint8Array.from([0x99, 0x7f]))).toBe("轴");
    // 0x98 is deliberately unmapped; the peer's Python zip must not shift
    // the table and claim it.
    expect(decodeWa2Text(Uint8Array.from([0x98, 0x7f]))).not.toBe("轴");
    expect(decodeWa2Text(Uint8Array.from([0x41, 0x89, 0x7f, 0x42]))).toBe("A蹑B");
    // A truncated lead byte decodes on its own (replacement, never a read
    // past the buffer).
    expect(decodeWa2Text(Uint8Array.from([0x41, 0x89]))).toBe("A�");
  });

  it("matches a line exactly and flags duplicate matches", () => {
    const save = parseNativeSave(nativeBuffer())!;
    const pos = findNativePosition(save, scenario);
    expect(pos).toMatchObject({ event: 1, script: "2003", confidence: "exact", ambiguous: false, matches: 1 });

    const dup: Scenario = {
      ...scenario,
      events: [
        scenario.events[1],
        scenario.events[1],
        scenario.events[2],
      ],
    };
    const dp = findNativePosition(save, dup)!;
    expect(dp.event).toBe(0);
    expect(dp.ambiguous).toBe(true);
    expect(findNativeCandidates(save, dup)).toHaveLength(2);
  });

  it("falls back to choice buffers when the line cannot be matched", () => {
    const save = parseNativeSave(nativeBuffer({ text: "Unknown line." }))!;
    const pos = findNativePosition(save, scenario);
    expect(pos).toMatchObject({ event: 2, script: "2003", confidence: "choice", ambiguous: false, matches: 1 });
  });

  it("builds a SaveData with native metadata and survives JSON round-trip", () => {
    const save = parseNativeSave(nativeBuffer())!;
    const pos = findNativePosition(save, scenario)!;
    const out = nativeToSave(save, pos, "save_01.sav");
    expect(out.position).toEqual({ script: "2003", event: 1 });
    expect(out.native?.file).toBe("save_01.sav");
    expect(out.native?.script).toBe("2003");
    expect(out.native?.timestamp).toBe("2026-09-23 23:16:25");
    const round = deserialize(serialize(out));
    expect(round.native?.file).toBe("save_01.sav");
    expect(round.native?.timestamp).toBe("2026-09-23 23:16:25");
    // ScriptPos/anchor must survive the localStorage/JSON round-trip too.
    expect(round.native?.scriptPos).toBe(out.native?.scriptPos);
    expect(round.native?.anchor).toBe("fuzzy");
  });

  it("strips UI numbering and quotes from options", () => {
    expect(cleanNativeOption('"1. I can\'t handle her."')).toBe("I can't handle her.");
    expect(cleanNativeOption("'2. See her off'")).toBe("See her off");
  });

  it("parses Global.vrb records and restores flags.g, aff, picks, and flags.cfg", async () => {
    const { STANDARD_GLOBAL_VARS } = await import("./cfg-vm");
    const ab = nativeBuffer({ script: "2003", text: "For all her physical beauty, I had never met a woman." });
    const bytes = new Uint8Array(ab);
    const dv = new DataView(ab);
    // Write 29 Global.vrb records at 0x54cb0 (compact ASCII names fit in <= 0x54fd0)
    const vals: Record<number, number> = { 5: 2, 7: 7, 8: 3, 12: 1, 14: 2, 15: 1 };
    let p = 0x54cb8;
    for (let i = 0; i < STANDARD_GLOBAL_VARS.length; i++) {
      const nameBytes = new TextEncoder().encode(`G_${i}`);
      const nlen = nameBytes.length + 1; // includes trailing NUL
      dv.setUint32(p, nlen, true);
      p += 4;
      bytes.set(nameBytes, p);
      bytes[p + nameBytes.length] = 0;
      p += nlen;
      bytes[p] = 3;
      p += 1;
      dv.setInt32(p, vals[i] ?? 0, true);
      p += 4;
    }
    expect(p).toBeLessThanOrEqual(NATIVE_SAVE_SIZE);
    dv.setUint32(0x54cb0, p - 0x54cb0, true);
    dv.setUint32(0x54cb4, STANDARD_GLOBAL_VARS.length, true);

    const parsed = parseNativeSave(ab)!;
    expect(parsed.globalVars).toHaveLength(29);
    expect(parsed.globalVars?.[7]?.value).toBe(7);

    const cfg = {
      version: 1,
      vars: STANDARD_GLOBAL_VARS,
      scripts: {
        "2003": {
          "0": [
            { t: "play" as const, from: 0, to: 1 },
            { t: "play" as const, from: 1, to: 2 },
          ],
        },
      },
    };
    const pos = findNativePosition(parsed, scenario)!;
    const restored = nativeToSave(parsed, pos, "save_18.sav", 1, 1, { cfg });
    expect(restored.flags.g?.[7]).toBe(7);
    expect(restored.flags.g?.[12]).toBe(1);
    expect(restored.flags.aff).toEqual({ k: 2, s: 7, koharu: 3 });
    expect(restored.picks["2003-242"]).toBe(2);
    expect(restored.picks["2003-982"]).toBe(1);
    expect(restored.flags.cfg?.script).toBe("2003");
    expect(restored.flags.cfg?.executedRanges).toEqual([[0, 1], [1, 2]]);
  });

  it("seeds restored native locals over the CFG replay's inferred values", () => {
    const ab = nativeBuffer({ ints: { 0: 42, 1: 7 }, floats: { 0: 1.5 } });
    const parsed = parseNativeSave(ab)!;
    // The replay runs `setL 0 = 7`, which the save's own local must override.
    const cfg = {
      version: 1,
      vars: [],
      scripts: {
        "2003": {
          "0": [
            { t: "setL" as const, idx: 0, op: "=", val: 7 },
            { t: "play" as const, from: 0, to: 2 },
          ],
        },
      },
    };
    const pos = { event: 1, script: "2003", confidence: "exact" as const, ambiguous: false, matches: 1 };
    const restored = nativeToSave(parsed, pos, "save_01.sav", 1, 1, { cfg });
    expect(restored.flags.cfg?.l[0]).toBe(42);
    expect(restored.flags.cfg?.l[1]).toBe(7);
    expect(restored.flags.cfg?.l[26]).toBe(1.5);
    // No CFG -> no replayed state to seed, and no crash on router-less packs.
    const plain = nativeToSave(parsed, pos, "save_01.sav");
    expect(plain.flags.cfg).toBeUndefined();
  });
});

describe("native position ranking", () => {
  const dup: Scenario = {
    script: "1007",
    tokens: 10,
    warnings: [],
    events: [
      { t: "narrate", text: "Shared line." },
      { t: "narrate", text: "Another line." },
      { t: "narrate", text: "Shared line." },
    ],
  };

  function nativePos(anchors: Record<string, [number, number][]>): NativePosData {
    return { version: 1, anchors };
  }

  it("keeps text order when the pack has no anchors", () => {
    const save = parseNativeSave(nativeBuffer({ script: "1007", text: "Shared line." }))!;
    const out = findNativeCandidates(save, dup);
    expect(out.map((p) => p.event)).toEqual([0, 2]);
    expect(out[0]!.anchor).toBeUndefined();
    // A lone exact text hit is still a text match, not a ScriptPos anchor.
    const single = parseNativeSave(nativeBuffer({ script: "1007", text: "Another line." }))!;
    expect(findNativePosition(single, dup)?.anchor).toBeUndefined();
  });

  it("ranks the closest label at-or-before ScriptPos first and marks it exact", () => {
    const save = parseNativeSave(nativeBuffer({ script: "1007", text: "Shared line.", scriptPos: 950 }))!;
    const pos = nativePos({ "1007": [[100, 0], [900, 2]] });
    const out = findNativeCandidates(save, dup, pos);
    expect(out.map((p) => p.event)).toEqual([2, 0]);
    expect(out[0]).toMatchObject({ confidence: "exact", anchor: "exact", ambiguous: true, matches: 2 });
    expect(out[1]!.anchor).toBeUndefined();
    expect(findNativePosition(save, dup, pos)?.event).toBe(2);
  });

  it("falls back to text order when no candidate label is below ScriptPos", () => {
    const save = parseNativeSave(nativeBuffer({ script: "1007", text: "Shared line.", scriptPos: 50 }))!;
    const out = findNativeCandidates(save, dup, nativePos({ "1007": [[100, 0], [900, 2]] }));
    expect(out.map((p) => p.event)).toEqual([0, 2]);
    expect(out[0]!.anchor).toBeUndefined();
  });

  it("uses the ic/<script> anchors for route 2 saves when present", () => {
    const save = parseNativeSave(nativeBuffer({ script: "1007", route: "2", text: "Shared line.", scriptPos: 950 }))!;
    const pos = nativePos({
      "1007": [[900, 0], [100, 2]],
      "ic/1007": [[100, 0], [900, 2]],
    });
    expect(nativeAnchorKey(pos, "1007", "2")).toBe("ic/1007");
    expect(nativeAnchorKey(pos, "1007", "002")).toBe("ic/1007");
    expect(nativeAnchorKey(pos, "1007", "030")).toBe("1007");
    expect(findNativePosition(save, dup, pos)?.event).toBe(2);
    // Route 030 (CC/Coda) uses the main anchors.
    const main = parseNativeSave(nativeBuffer({ script: "1007", route: "030", text: "Shared line.", scriptPos: 950 }))!;
    expect(findNativePosition(main, dup, pos)?.event).toBe(0);
  });

  it("stores ScriptPos and the resolved anchor on the imported save", () => {
    const save = parseNativeSave(nativeBuffer({ script: "1007", text: "Shared line.", scriptPos: 950 }))!;
    const pos = nativePos({ "1007": [[100, 0], [900, 2]] });
    const candidate = findNativeCandidates(save, dup, pos)[0]!;
    const out = nativeToSave(save, candidate, "save_00.sav", 1, 2, { nativePos: pos });
    expect(out.native?.scriptPos).toBe(950);
    expect(out.native?.anchor).toBe("exact");
    expect(out.native?.candidateCount).toBe(2);
    // Only the ranked best carries the explicit marker. Stripping it (a
    // caller that only has an unranked position) must not re-grade a
    // merely-plausible label as exact.
    const bare = nativeToSave(save, { ...candidate, anchor: undefined }, "save_00.sav", 1, 2, { nativePos: pos });
    expect(bare.native?.anchor).toBe("fuzzy");
    expect(nativeToSave(save, { ...candidate, anchor: undefined }, "save_00.sav").native?.anchor).toBe("fuzzy");
  });
});
