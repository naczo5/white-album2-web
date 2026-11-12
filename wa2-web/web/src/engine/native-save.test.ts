import { describe, expect, it } from "vitest";
import {
  NATIVE_SAVE_SIZE,
  cleanNativeOption,
  findNativeCandidates,
  findNativePosition,
  nativeToSave,
  normalizeNativeText,
  parseNativeFile,
  parseNativeSave,
} from "./native-save";
import { deserialize, serialize } from "./save";
import type { Scenario } from "./types";

function writeAscii(buf: Uint8Array, off: number, s: string): void {
  for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i) & 0x7f;
}

function writeU16(buf: Uint8Array, off: number, n: number): void {
  buf[off] = n & 0xff;
  buf[off + 1] = (n >> 8) & 0xff;
}

function nativeBuffer(opts: {
  script?: string;
  text?: string;
  speaker?: string;
  preview?: string;
  options?: string[];
  route?: string;
} = {}): ArrayBuffer {
  const buf = new Uint8Array(NATIVE_SAVE_SIZE);
  writeAscii(buf, 0x203d8, opts.script ?? "2003");
  writeAscii(buf, 0x203d8 + 5, opts.route ?? "030");
  writeAscii(buf, 0x112c2, opts.text ?? "For all her physical beauty, I had never met a woman.");
  writeAscii(buf, 0x116c4, opts.speaker ?? "");
  writeAscii(buf, 0x18, opts.preview ?? "Preview text");
  (opts.options ?? ['"1. Go left"', "'2. Stay here'"]).forEach((o, i) =>
    writeAscii(buf, 0x11714 + i * 0x100, o),
  );
  writeU16(buf, 0x08, 2026);
  writeU16(buf, 0x0a, 9);
  writeU16(buf, 0x0c, 3);
  writeU16(buf, 0x0e, 23);
  writeU16(buf, 0x10, 23);
  writeU16(buf, 0x12, 16);
  writeU16(buf, 0x14, 25);
  buf[0] = 2;
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

  it("detects the system save by name or fixed size", () => {
    const named = parseNativeFile(new ArrayBuffer(16), "Sys.sav");
    expect(named.kind).toBe("system");
    const sized = parseNativeFile(new ArrayBuffer(2528384), "whatever.sav");
    expect(sized.kind).toBe("system");
  });

  it("normalizes soft wraps and punctuation", () => {
    expect(normalizeNativeText("For all her physical beauty~ I had\\nnever met her."))
      .toBe("for all her physical beauty i had never met her");
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
  });

  it("strips UI numbering and quotes from options", () => {
    expect(cleanNativeOption('"1. I can\'t handle her."')).toBe("I can't handle her.");
    expect(cleanNativeOption("'2. See her off'")).toBe("See her off");
  });
});
