// Parser for the original PC build's binary save files.
//
// Format evidence (samples from WA2.exe; byte-for-byte cross-checked with the
// Apache-2.0 galhack/WhiteAlbum2_iOS `convert_pc_saves.py` VM layout):
//   0x00000  u32 version (2)
//   0x00004  u32 playtime/serial
//   0x00008  SYSTEMTIME (8 x u16)
//   0x00018  CP932 current-line preview (64-byte buffer)
//   0x112c2  CP932 full current line
//   0x116c4  CP932 speaker
//   0x11714  CP932 choice option 1 (256-byte slot)
//   0x11814  choice option 2
//   0x11914  choice option 3
//   0x134d4  VM version signature, ASCII "1.00"
//   0x134d8  u32 script-storage layout (4 = single script, no nested stack)
//   0x1c01c  u32 parse mode / pending PC function (131 = stable dialogue,
//            209 = route-choice snapshot)
//   0x1c18c  u32 ScriptPos: byte offset in the script's `.bnr` (the pointer
//            sits after the last executed statement; the engine runs ahead
//            through no-wait ops — observed 7 events on the JP sample set)
//   0x1c190  operand stack, 256 x 20-byte VM arguments
//   0x1d590  u32 operand stack count (<= 256)
//   0x1d594  local ints, 26 variables x 16 call frames (frame 0 = +0,
//            stride 64 bytes; only frame 0 is imported)
//   0x1dc14  local floats, same 26 x 16 layout
//   0x1e4a8  jump stack, 15 x 532-byte records
//   0x203d4  u32 jump stack count (<= 15)
//   0x203d8  CP932 script id (e.g. "2003")
//   next     CP932 route/mode marker ("2" = IC variant, "030" = CC/Coda)
//   0x54cb0  Global.vrb named-variable table
// The file is fixed at 0x54fd0 bytes; Sys.sav is a separate global file.
// Every signature field is validated: an unknown layout/mode makes the file
// "unknown", never a guessed position.
//
// The CK-GAL private Shift-JIS glyph map is reimplemented from the iOS port's
// `script/Wa2Encoding.cs` (Apache-2.0, galhack/WhiteAlbum2_iOS); see
// THIRD_PARTY_NOTICES.md. Text matching is only a fallback: positions are
// ranked by `data/native-pos.json` (.bnr label statement -> IR event).

import {
  G_TO_PICK_NODE,
  STANDARD_GLOBAL_VARS,
  seedCfgLocals,
  seekCfg,
  syncAffFromG,
} from "./cfg-vm";
import type { Router } from "./router";
import type { CfgData, NativePosData, NativeSaveMeta, SaveData } from "./types";
import { newSave } from "./save";
import { SYS_SIZE } from "./sys-save";
import type { Scenario } from "./types";

export const NATIVE_SAVE_SIZE = 0x54fd0; // 348112
/** `Sys.sav` is exactly the same size as the system table's region span:
 * alias the decoder's constant instead of repeating the magic number. */
export const NATIVE_SYS_SIZE = SYS_SIZE;

const OFF_PREVIEW = 0x18;
const OFF_TEXT = 0x112c2;
const OFF_SPEAKER = 0x116c4;
const OFF_OPTION = 0x11714;
const OFF_OPTION_COUNT = 0x11710;
const OPTION_STRIDE = 0x100;
const OFF_VM_VERSION = 0x134d4;
const OFF_LAYOUT = 0x134d8;
/** Native VM script slots 1..4 (slot 0 is the current script). Any nonzero
 * byte means the save sits inside a nested script call; the importer only
 * models the single-script CK-GAL layout and must reject it. */
const OFF_VM_STACK = 0x134e0;
const VM_SLOT_SIZE = 53648;
const OFF_PARSE_MODE = 0x1c01c;
const OFF_SCRIPT_POS = 0x1c18c;
const MAX_ARGS = 256;
const OFF_ARGS_COUNT = 0x1d590;
const OFF_LOCALS_INT = 0x1d594;
const OFF_LOCALS_FLOAT = 0x1dc14;
const LOCAL_COUNT = 26;
const LOCAL_STRIDE = 64;
const JUMP_COUNT = 0x203d4;
const OFF_JUMPS = 0x1e4a8;
const JUMP_SIZE = 532;
const MAX_JUMPS = 15;
const OFF_SCRIPT = 0x203d8;
const OFF_GLOBAL_VRB = 0x54cb0;

export interface NativeGlobalVar {
  name: string;
  value: number;
}

/** Summary of one native VM jump-stack frame (532-byte record). The
 * positions/flags arrays are not imported: only the record's shape is
 * needed to describe the pending control flow. */
export interface NativeJumpFrame {
  type: number;
  count: number;
  end: number;
  condition: number;
}

export interface NativeSave {
  version: number;
  playtime: number;
  timestamp: string;
  preview: string;
  text: string;
  speaker: string;
  options: string[];
  script: string;
  route: string;
  /** Exact VM signature: "exact" = every validated layout field matched. */
  signature: "exact" | "legacy";
  /** ASCII VM version at 0x134d4 ("1.00"). */
  vmVersion: string;
  /** Script-storage layout at 0x134d8 (4). */
  layout: number;
  /** Pending PC function / parse mode at 0x1c01c (131 or 209). */
  parseMode: number;
  /** Byte offset in the script's `.bnr` (0x1c18c). */
  scriptPos: number;
  /** 52 VM locals: 26 ints, then 26 floats (frame 0 only). */
  locals: number[];
  jumpCount: number;
  /** Per-record jump-stack summaries (empty when the stack is empty). */
  jumpStack: NativeJumpFrame[];
  /** Operand-stack depth at save time (0x1d590). The stored argument records
   * (0x1c190, 20 B each) are not replayed by the importer; the count is only
   * a layout/consistency check. */
  argCount: number;
  globalVars?: NativeGlobalVar[];
}

export type ParsedNativeFile =
  | { kind: "slot"; name: string; save: NativeSave }
  | { kind: "system"; name: string; size: number }
  | { kind: "unknown"; name: string; size: number };

export interface NativePosition {
  event: number;
  /** Scenario file selected when a route/variant is resolved. */
  script?: string;
  confidence: "exact" | "fuzzy" | "choice";
  ambiguous: boolean;
  matches: number;
  /** `exact` = this event's label offset was confirmed against the save's
   * ScriptPos through `native-pos.json`; otherwise the text/choice fallback. */
  anchor?: "exact" | "fuzzy" | "choice";
}

const decoder = new TextDecoder("shift_jis");

/** CK-GAL private glyphs: Shift-JIS lead byte + trail 0x7f, mapped onto
 * otherwise-unused CJK code points. Taken byte-for-byte from the iOS port's
 * `Wa2Encoding.CustomMappings` (galhack/WhiteAlbum2_iOS, Apache-2.0).
 * Note 0x98 is deliberately absent (the peer's Python zip mis-aligns this;
 * the C# table is authoritative). */
const CUSTOM_GLYPHS: Record<number, string> = {
  0x89: "蹑", 0x8a: "蹒", 0x8b: "荚", 0x8c: "荞", 0x8d: "蹦",
  0x8e: "蹩", 0x8f: "蹭", 0x90: "蹰", 0x91: "蹲", 0x92: "车",
  0x93: "轨", 0x94: "转", 0x95: "轮", 0x96: "软", 0x97: "轰",
  0x99: "轴", 0x9a: "轶", 0x9b: "轻", 0x9c: "载", 0x9d: "较",
  0x9e: "辄", 0x9f: "辅",
  0xe0: "辆", 0xe1: "辈", 0xe2: "辉", 0xe3: "辍", 0xe4: "辐",
  0xe5: "辑", 0xe6: "输", 0xe7: "辕", 0xe8: "辙", 0xe9: "邋",
  0xea: "锋",
};

/** Decode CK-GAL CP932 text with the engine's private glyph map.
 *
 * Normal Shift-JIS runs keep the platform decoder; only a mapped lead byte
 * followed by the 0x7f trail becomes a private glyph. A truncated lead byte
 * at the end of the buffer is decoded on its own instead of consuming the
 * next byte (the peer's `Wa2Encoding` had to fix the same bug). */
export function decodeWa2Text(bytes: Uint8Array): string {
  let out = "";
  let run = 0;
  const flush = (end: number) => {
    if (end > run) out += decoder.decode(bytes.subarray(run, end));
  };
  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i]!;
    const pair = (lead >= 0x81 && lead <= 0x9f) || (lead >= 0xe0 && lead <= 0xfe);
    if (pair && i + 1 < bytes.length) {
      if (bytes[i + 1] === 0x7f && CUSTOM_GLYPHS[lead] !== undefined) {
        flush(i);
        out += CUSTOM_GLYPHS[lead];
        i += 2;
        run = i;
        continue;
      }
      i += 2;
      continue;
    }
    i += 1;
  }
  flush(i);
  return out;
}

function u16(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8);
}

function u32(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

function i32(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >> 0;
}

function parseGlobalVrb(b: Uint8Array): NativeGlobalVar[] | undefined {
  if (b.length < OFF_GLOBAL_VRB + 8) return undefined;
  const totalBytes = u32(b, OFF_GLOBAL_VRB);
  const count = u32(b, OFF_GLOBAL_VRB + 4);
  if (count === 0 || count > 256 || totalBytes < 8 || OFF_GLOBAL_VRB + totalBytes > b.length) {
    return undefined;
  }
  const end = OFF_GLOBAL_VRB + totalBytes;
  let p = OFF_GLOBAL_VRB + 8;
  const out: NativeGlobalVar[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 4 > end) return undefined;
    const nlen = u32(b, p);
    if (nlen < 1 || p + 4 + nlen + 5 > end) return undefined;
    const rawName = b.subarray(p + 4, p + 4 + nlen);
    const trimmed = rawName[nlen - 1] === 0 ? rawName.subarray(0, nlen - 1) : rawName;
    const name = decodeWa2Text(trimmed);
    const typ = b[p + 4 + nlen];
    if (typ !== 3) return undefined;
    const value = i32(b, p + 4 + nlen + 1);
    out.push({ name, value });
    p += 4 + nlen + 5;
  }
  return out;
}

function cstring(b: Uint8Array, off: number, max: number): string {
  if (off < 0 || off >= b.length) return "";
  let end = off;
  const limit = Math.min(b.length, off + max);
  while (end < limit && b[end] !== 0) end++;
  return decodeWa2Text(b.subarray(off, end)).trim();
}

function systemTime(b: Uint8Array): string {
  if (b.length < 0x18) return "";
  const year = u16(b, 0x08);
  const month = u16(b, 0x0a);
  const day = u16(b, 0x0e); // weekday is 0x0c
  const hour = u16(b, 0x10);
  const minute = u16(b, 0x12);
  const second = u16(b, 0x14);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

/** Native option buffers include their UI numbering and quote characters,
 * e.g. `"1. I can't handle her."` or `'2. See her off'`. */
export function cleanNativeOption(s: string): string {
  return s
    .replace(/^\s*["'“”]?\s*\d+[.)]\s*/, "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
}

function readOptions(b: Uint8Array, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.min(3, count); i++) {
    const raw = cstring(b, OFF_OPTION + i * OPTION_STRIDE, OPTION_STRIDE);
    if (raw) out.push(cleanNativeOption(raw));
  }
  return out;
}

/** Native VM local slots hold 16 call frames (64 bytes per variable:
 * frame 0 + 15 nested frames). The importer reads frame 0 only; any nonzero
 * byte in frames 1..15 means a nested local frame, which it cannot model. */
function hasNestedLocalFrames(b: Uint8Array): boolean {
  for (let i = 0; i < LOCAL_COUNT; i++) {
    for (const base of [OFF_LOCALS_INT, OFF_LOCALS_FLOAT]) {
      const start = base + i * LOCAL_STRIDE + 4;
      const end = base + (i + 1) * LOCAL_STRIDE;
      for (let p = start; p < end; p++) if (b[p] !== 0) return true;
    }
  }
  return false;
}

/** Parse one native slot save. Returns null unless every signature field
 * matches the known PC v2 / VM 1.00 CK-GAL layout (fail closed: an unknown
 * layout never gets a guessed reading position). */
export function parseNativeSave(buffer: ArrayBuffer): NativeSave | null {
  const b = new Uint8Array(buffer);
  if (b.length !== NATIVE_SAVE_SIZE || u32(b, 0) !== 2) return null;
  if (b.length < OFF_SCRIPT + 8) return null;
  const vmVersion = String.fromCharCode(...b.subarray(OFF_VM_VERSION, OFF_VM_VERSION + 4));
  if (vmVersion !== "1.00") return null;
  if (u32(b, OFF_LAYOUT) !== 4) return null;
  const parseMode = u32(b, OFF_PARSE_MODE);
  if (parseMode !== 131 && parseMode !== 209) return null;
  const jumpCount = u32(b, JUMP_COUNT);
  if (jumpCount > MAX_JUMPS) return null;
  const argCount = u32(b, OFF_ARGS_COUNT);
  if (argCount > MAX_ARGS) return null;
  // Match the peer converter's fail-closed layout checks: nested script
  // slots or local frames are a different (unsupported) VM state.
  for (let i = 1; i <= 4; i++) {
    const start = OFF_VM_STACK + i * VM_SLOT_SIZE;
    for (let p = start; p < start + VM_SLOT_SIZE; p++) {
      if (b[p] !== 0) return null;
    }
  }
  if (hasNestedLocalFrames(b)) return null;
  const optionCount = u32(b, OFF_OPTION_COUNT);
  if (optionCount > 3) return null;
  const script = cstring(b, OFF_SCRIPT, 16);
  if (!/^\d{4}(?:_\d+)?$/.test(script)) return null;
  let route = "";
  const scriptEnd = b.indexOf(0, OFF_SCRIPT);
  if (scriptEnd >= 0) route = cstring(b, scriptEnd + 1, 8);
  const globalVars = parseGlobalVrb(b);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const locals: number[] = [];
  for (let i = 0; i < LOCAL_COUNT; i++) {
    locals.push(dv.getInt32(OFF_LOCALS_INT + i * LOCAL_STRIDE, true));
  }
  for (let i = 0; i < LOCAL_COUNT; i++) {
    locals.push(dv.getFloat32(OFF_LOCALS_FLOAT + i * LOCAL_STRIDE, true));
  }
  const jumpStack: NativeJumpFrame[] = [];
  for (let i = 0; i < jumpCount; i++) {
    const at = OFF_JUMPS + i * JUMP_SIZE;
    jumpStack.push({
      type: u32(b, at),
      count: u32(b, at + 4),
      end: u32(b, at + 12),
      condition: u32(b, at + 528),
    });
  }
  return {
    version: u32(b, 0),
    playtime: u32(b, 4),
    timestamp: systemTime(b),
    preview: cstring(b, OFF_PREVIEW, 0x40),
    text: cstring(b, OFF_TEXT, 0x400),
    speaker: cstring(b, OFF_SPEAKER, 16),
    options: readOptions(b, optionCount),
    script,
    route,
    signature: "exact",
    vmVersion,
    layout: u32(b, OFF_LAYOUT),
    parseMode,
    scriptPos: u32(b, OFF_SCRIPT_POS),
    locals,
    jumpCount,
    jumpStack,
    argCount,
    ...(globalVars ? { globalVars } : {}),
  };
}

export function parseNativeFile(buffer: ArrayBuffer, name = ""): ParsedNativeFile {
  const size = buffer.byteLength;
  if (/^sys\.sav$/i.test(name) || size === NATIVE_SYS_SIZE) {
    return { kind: "system", name, size };
  }
  const save = parseNativeSave(buffer);
  if (save) return { kind: "slot", name, save };
  return { kind: "unknown", name, size };
}

/** Normalize native display text for matching against the IR. The native
 * buffer contains soft-wrapped lines with `~`/`…` separators and literal
 * `\n` escapes; the IR text is unwrapped. */
export function normalizeNativeText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/<[^>]*>/g, " ")
    .replace(/\\n/g, " ")
    .replace(/[~〜…]/g, " ")
    .replace(/[「」『』〈〉《》【】〔〕]/g, " ")
    .replace(/[.,!?;:'"“”‘’—–-]/g, " ")
    .replace(/[()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokenScore(a: string, b: string): number {
  const aw = new Set(a.split(" ").filter((x) => x.length > 1));
  const bw = new Set(b.split(" ").filter((x) => x.length > 1));
  if (aw.size === 0 || bw.size === 0) return 0;
  let inter = 0;
  for (const w of aw) if (bw.has(w)) inter++;
  return inter / (aw.size + bw.size - inter);
}

function scoreText(expected: string, candidate: string): number {
  if (!expected || !candidate) return 0;
  if (expected === candidate) return 10000;
  if (expected.length >= 8 && candidate.length >= 8 &&
    (candidate.startsWith(expected) || expected.startsWith(candidate))) {
    return 6000 - Math.min(2000, Math.abs(candidate.length - expected.length) * 4);
  }
  if (expected.length < 8) return 0;
  const j = tokenScore(expected, candidate);
  return j >= 0.65 ? Math.round(3000 * j) : 0;
}

/** Script key that carries this save's ScriptPos anchors: route "2" (the IC
 * variant) has its own `.bnr` set, emitted as `ic/<script>`; otherwise the
 * scenario script id is used. Returns null when the pack has no anchors. */
export function nativeAnchorKey(
  nativePos: NativePosData | null | undefined,
  script: string,
  route: string,
): string | null {
  const anchors = nativePos?.anchors;
  if (!anchors) return null;
  const mode = route.trim().replace(/^0+/, "");
  if (mode === "2" && Array.isArray(anchors[`ic/${script}`])) return `ic/${script}`;
  return Array.isArray(anchors[script]) ? script : null;
}

/** Lowest label-statement byte offset anchored to `event`. A `.bnr` event can
 * own several label statements; the first one is where the line starts. */
function labelOffset(anchors: [number, number][], event: number): number | null {
  let best: number | null = null;
  for (const [off, ev] of anchors) {
    if (ev !== event) continue;
    if (best === null || off < best) best = off;
  }
  return best;
}

/** Rank exact text hits by their label offset below the saved ScriptPos.
 *
 * The VM pointer sits *after* the displayed line (the engine runs ahead
 * through no-wait ops; observed 7 events on the JP sample set), so the
 * correct candidate is the closest
 * label offset at-or-before ScriptPos. Hits past the pointer (or with no
 * anchor) stay as alternatives, ordered by distance. */
function rankExactHits(
  events: number[],
  anchors: [number, number][] | null,
  scriptPos: number | null | undefined,
): { event: number; offset: number | null; best: boolean }[] {
  const hits = events.map((event, i) => ({
    event,
    i,
    offset: anchors ? labelOffset(anchors, event) : null,
  }));
  if (!anchors || typeof scriptPos !== "number") {
    return hits.map((h) => ({ event: h.event, offset: h.offset, best: false }));
  }
  const below = (o: number | null): o is number => o !== null && o <= scriptPos;
  const anyBelow = hits.some((h) => below(h.offset));
  // Nothing executed at-or-before the pointer: no ScriptPos evidence, so keep
  // the text-match order exactly as a pack without anchors would.
  if (!anyBelow) {
    return hits.map((h) => ({ event: h.event, offset: h.offset, best: false }));
  }
  const ranked = [...hits].sort((a, b) => {
    const ab = below(a.offset);
    const bb = below(b.offset);
    if (ab !== bb) return ab ? -1 : 1;
    if (ab && bb) return (b.offset! - a.offset!) || a.i - b.i;
    const ad = a.offset === null ? Infinity : Math.abs(a.offset - scriptPos);
    const bd = b.offset === null ? Infinity : Math.abs(b.offset - scriptPos);
    return (ad - bd) || a.i - b.i;
  });
  const bestOffset = ranked[0]?.offset ?? null;
  // A pre-ranked best only becomes `exact` when no other candidate shares its
  // offset (a malformed/duplicated anchor table must not look resolved).
  const uniqueBest = ranked.every((h, idx) => idx === 0 || h.offset !== bestOffset);
  return ranked.map((h, idx) => ({
    event: h.event,
    offset: h.offset,
    // The closest at-or-before pointer is the save's own bytecode position,
    // not a text guess.
    best: uniqueBest && idx === 0,
  }));
}

/** Locate every plausible scenario event for a native save. An exact line
 * can occur more than once; returning all candidates lets Save/Load show
 * them as separate options rather than silently choosing one. When
 * `nativePos` carries .bnr label anchors for the scenario, ScriptPos ranks
 * the candidates (best first) and marks the unique best anchor `exact`. */
export function findNativeCandidates(
  save: NativeSave,
  scenario: Scenario,
  nativePos?: NativePosData | null,
): NativePosition[] {
  const wanted = normalizeNativeText(save.text || save.preview);
  const exact: number[] = [];
  let best = -1;
  let bestScore = 0;

  if (wanted) {
    for (let i = 0; i < scenario.events.length; i++) {
      const ev = scenario.events[i];
      if (ev.t !== "say" && ev.t !== "narrate") continue;
      const cand = normalizeNativeText(ev.text);
      const sc = scoreText(wanted, cand);
      if (sc === 10000) {
        exact.push(i);
      } else if (sc > bestScore) {
        bestScore = sc;
        best = i;
      }
    }
  }
  if (exact.length > 0) {
    const key = nativeAnchorKey(nativePos, scenario.script, save.route);
    const anchors = key && nativePos ? nativePos.anchors[key]! : null;
    const ranked = rankExactHits(exact, anchors, save.scriptPos);
    return ranked.map((hit) => ({
      event: hit.event,
      script: scenario.script,
      confidence: "exact" as const,
      ambiguous: exact.length > 1,
      matches: exact.length,
      ...(hit.best ? { anchor: "exact" as const } : {}),
    }));
  }
  if (best >= 0 && bestScore >= 2000) {
    return [{
      event: best,
      script: scenario.script,
      confidence: "fuzzy",
      anchor: "fuzzy",
      ambiguous: false,
      matches: 1,
    }];
  }

  const nativeOpts = save.options.map(normalizeNativeText).filter(Boolean);
  if (nativeOpts.length > 0) {
    for (let i = 0; i < scenario.events.length; i++) {
      const ev = scenario.events[i];
      if (ev.t !== "choice") continue;
      const opts = ev.options.map((o) => normalizeNativeText(o.text)).filter(Boolean);
      if (opts.length === 0 || nativeOpts.length !== opts.length) continue;
      if (nativeOpts.every((o) => opts.some((x) => x === o || scoreText(o, x) >= 6000))) {
        return [{
          event: i,
          script: scenario.script,
          confidence: "choice",
          anchor: "choice",
          ambiguous: false,
          matches: 1,
        }];
      }
    }
  }
  return [];
}

/** First candidate, for callers that only need one position. */
export function findNativePosition(
  save: NativeSave,
  scenario: Scenario,
  nativePos?: NativePosData | null,
): NativePosition | null {
  return findNativeCandidates(save, scenario, nativePos)[0] ?? null;
}

export interface NativeToSaveOptions {
  cfg?: CfgData | null;
  router?: Router | null;
  profileGameFlags?: Record<string, number>;
  /** `.bnr` label anchors, used to confirm `meta.anchor` when the caller did
   * not pass a `NativePosition` already ranked by `findNativeCandidates`. */
  nativePos?: NativePosData | null;
}

function anchorFor(
  native: NativeSave,
  position: NativePosition,
  nativePos: NativePosData | null | undefined,
): "exact" | "fuzzy" | "choice" {
  if (position.anchor) return position.anchor;
  if (position.confidence === "choice") return "choice";
  // `findNativeCandidates` marks only a unique ScriptPos-ranked winner with
  // `anchor:"exact"`. A non-best candidate that merely has a label below the
  // pointer must not be re-graded here (the duplicate-offset guard would be
  // lost). Without that explicit marker the position is text/fuzzy evidence.
  return "fuzzy";
}

export function nativeToSave(
  native: NativeSave,
  position: NativePosition,
  fileName = "",
  candidate = 1,
  candidateCount = 1,
  options?: NativeToSaveOptions,
): SaveData {
  const script = position.script ?? native.script;
  const save = newSave("Imported", { script, event: position.event });
  save.visited = [script];
  const meta: NativeSaveMeta = {
    file: fileName || undefined,
    script,
    route: native.route || undefined,
    preview: native.preview || undefined,
    speaker: native.speaker || undefined,
    options: native.options.length ? native.options : undefined,
    timestamp: native.timestamp || undefined,
    playtime: native.playtime || undefined,
    version: native.version || undefined,
    ambiguous: position.ambiguous || undefined,
    confidence: position.confidence,
    candidate: candidateCount > 1 ? candidate : undefined,
    candidateCount: candidateCount > 1 ? candidateCount : undefined,
    scriptPos: native.scriptPos,
    anchor: anchorFor(native, position, options?.nativePos),
  };
  save.native = meta;

  const cfg = options?.cfg ?? options?.router?.cfg ?? null;
  if (native.globalVars?.length) {
    const vars = cfg?.vars ?? STANDARD_GLOBAL_VARS;
    const byName = new Map(vars.map((v) => [v.name, v.idx]));
    const g = new Array(Math.max(29, vars.length, native.globalVars.length)).fill(0);
    for (const v of vars) g[v.idx] = v.init ?? 0;
    native.globalVars.forEach((gv, i) => {
      const idx = byName.get(gv.name) ?? (i < g.length ? i : -1);
      if (idx >= 0) g[idx] = gv.value;
    });
    save.flags.g = g;
    syncAffFromG(save.flags);
    for (const [idxStr, nodeId] of Object.entries(G_TO_PICK_NODE)) {
      const val = g[Number(idxStr)] ?? 0;
      if (val > 0) save.picks[nodeId] = val;
    }
  }

  const profileGameFlags = options?.profileGameFlags ?? options?.router?.profileGameFlags;
  if (cfg && Object.keys(cfg.scripts[script] ?? {}).length > 0) {
    seekCfg(cfg, save.position, save.flags, {
      profileGameFlags,
      endingSlots: options?.router?.endingSlots,
      terminals: options?.router?.terminals,
      replay: options?.router?.replay,
      picks: save.picks,
      preserveG: Boolean(native.globalVars?.length),
    });
  } else if (options?.router) {
    options.router.seek(save.position, save.flags, save.picks);
  }
  // The seek replays the script from the top; the save's own VM locals are
  // the authoritative state for the line being restored, so they overwrite
  // whatever the replay inferred. A fuzzy position is a guess, so its frame
  // belongs to a different point and must not seed later conditions.
  if (position.confidence !== "fuzzy") seedCfgLocals(save.flags, native.locals);

  return save;
}
