// Parser for the original PC build's binary save files.
//
// Format evidence (samples from WA2.exe):
//   0x00000  u32 version (2)
//   0x00004  u32 playtime/serial
//   0x00008  SYSTEMTIME (8 x u16)
//   0x00018  CP932 current-line preview (64-byte buffer)
//   0x112c2  CP932 full current line
//   0x116c4  CP932 speaker
//   0x11714  CP932 choice option 1 (256-byte slot)
//   0x11814  choice option 2
//   0x11914  choice option 3
//   0x203d8  CP932 script id (e.g. "2003")
//   next     CP932 route/mode marker ("2" or "030")
// The file is fixed at 0x54fd0 bytes; Sys.sav is a separate global file.
// Text/choice buffers are the reliable position description: the engine's
// VM pointer is not stored as our script:event index.

import type { NativeSaveMeta, SaveData } from "./types";
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
const OPTION_STRIDE = 0x100;
const OFF_SCRIPT = 0x203d8;

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
}

const decoder = new TextDecoder("shift_jis");

function u16(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8);
}

function u32(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

function cstring(b: Uint8Array, off: number, max: number): string {
  if (off < 0 || off >= b.length) return "";
  let end = off;
  const limit = Math.min(b.length, off + max);
  while (end < limit && b[end] !== 0) end++;
  try {
    return decoder.decode(b.subarray(off, end)).trim();
  } catch {
    return "";
  }
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

function readOptions(b: Uint8Array): string[] {
  const out: string[] = [];
  for (let i = 0; i < 3; i++) {
    const raw = cstring(b, OFF_OPTION + i * OPTION_STRIDE, OPTION_STRIDE);
    if (raw) out.push(cleanNativeOption(raw));
  }
  return out;
}

/** Parse one native slot save. Returns null if the buffer is not a slot save
 * (e.g. Sys.sav or an unrelated .sav). */
export function parseNativeSave(buffer: ArrayBuffer): NativeSave | null {
  const b = new Uint8Array(buffer);
  if (b.length !== NATIVE_SAVE_SIZE || u32(b, 0) !== 2) return null;
  if (b.length < OFF_SCRIPT + 8) return null;
  const script = cstring(b, OFF_SCRIPT, 16);
  if (!/^\d{4}(?:_\d+)?$/.test(script)) return null;
  let route = "";
  const scriptEnd = b.indexOf(0, OFF_SCRIPT);
  if (scriptEnd >= 0) route = cstring(b, scriptEnd + 1, 8);
  return {
    version: u32(b, 0),
    playtime: u32(b, 4),
    timestamp: systemTime(b),
    preview: cstring(b, OFF_PREVIEW, 0x40),
    text: cstring(b, OFF_TEXT, 0x400),
    speaker: cstring(b, OFF_SPEAKER, 0x100),
    options: readOptions(b),
    script,
    route,
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

/** Locate every plausible scenario event for a native save. An exact line
 * can occur more than once; returning all candidates lets Save/Load show
 * them as separate options rather than silently choosing one. */
export function findNativeCandidates(save: NativeSave, scenario: Scenario): NativePosition[] {
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
    return exact.map((event) => ({
      event,
      script: scenario.script,
      confidence: "exact" as const,
      ambiguous: exact.length > 1,
      matches: exact.length,
    }));
  }
  if (best >= 0 && bestScore >= 2000) {
    return [{
      event: best,
      script: scenario.script,
      confidence: "fuzzy",
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
          ambiguous: false,
          matches: 1,
        }];
      }
    }
  }
  return [];
}

/** First candidate, for callers that only need one position. */
export function findNativePosition(save: NativeSave, scenario: Scenario): NativePosition | null {
  return findNativeCandidates(save, scenario)[0] ?? null;
}

export function nativeToSave(
  native: NativeSave,
  position: NativePosition,
  fileName = "",
  candidate = 1,
  candidateCount = 1,
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
  };
  save.native = meta;
  return save;
}
