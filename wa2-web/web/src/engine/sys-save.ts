// Parser for the native PC global save (`Sys.sav`).
//
// Format evidence (static WA2.exe .data + the BYOA sample, see
// docs/PARSING.md and data/sys-slots.json):
//   Region A 0x000000..0x07FFFF  4096 x 0x200 MSB-first read-line bitmaps;
//            slot s maps to sysSlots.scripts[s]; bit i lives at byte i>>3
//            with mask 0x80>>(i&7). Slot 0 is the engine's catch-all bucket
//            and is excluded. Bit m is the 0-based sequential say/narrate
//            message index plus one trailing sentinel bit at `msgs`.
//   Region B 0x080000..0x26847F  2,000,000 bytes, one byte per CG id with
//            index = part * 1_000_000 + cgId.
//   Region C 0x268480..0x26947F  1024 u32 LE global flags (Get/SetGameFlag).
//
// Nothing here knows about the UI: the module is pure so the import path,
// the profile merge and the gallery counters stay unit-testable.

import type { Router } from "./router";
import type { FlowData, FlowNode, Scenario, SysProfile, SysSlotsTable } from "./types";

export const SYS_SIZE = 0x269480; // 2,528,384 bytes, no header/magic/checksum

const REGION_A_START = 0x000000;
const REGION_A_END = 0x080000;
const REGION_A_SLOT_BYTES = 0x200;
const REGION_B_START = 0x080000;
const REGION_B_END = 0x268480;
const REGION_C_START = 0x268480;
const REGION_C_COUNT = 1024;

/** Band boundaries from Region C (see `gateSlots` in sys-slots.json). */
const MUSIC_FIRST = 101;
const MUSIC_LAST = 199;
const MOVIE_FIRST = 201;
const MOVIE_LAST = 224;
/** Slot 80 is the "every movie unlocked" sentinel, not a movie id. */
const MOVIE_SENTINEL_SLOT = 80;
const ERO_FIRST = 300;
const ERO_LAST = 322;

/** Gate-flag names carried into `SysProfile.gates`. */
const GATE_NAMES: Record<string, string> = {
  icClear: "icClearSlot",
  replay: "replaySlot",
  chiakiNormal: "chiakiNormalSlot",
  ccClear: "ccClearSlot",
  codaClear: "codaClearSlot",
  codaEntered: "codaEnteredSlot",
  setsunaCc: "setsunaCcSlot",
  codaSetsunaTrue: "codaSetsunaTrueSlot",
};

export interface SysReadSlot {
  /** Index into `SysSlotsTable.scripts`. */
  slot: number;
  script: string;
  /** Set bit indices (message index, plus a possible sentinel at `msgs`). */
  bits: number[];
}

/** Decoded raw content of one `Sys.sav`. */
export interface SysSave {
  /** Region A read bitmaps, slot 0 already dropped, empty slots omitted. */
  readBits: SysReadSlot[];
  /** Region B nonzero byte indices (`part * 1_000_000 + cgId`). */
  cgIds: number[];
  /** Region C: all 1024 u32 LE flags. */
  flags: number[];
}

/** Decode the three regions. Returns null when the buffer is not a full
 * 2,528,384-byte system save (a truncated copy cannot be trusted). */
export function parseSysSave(buffer: ArrayBuffer, table: SysSlotsTable): SysSave | null {
  if (buffer.byteLength < SYS_SIZE) return null;
  const bytes = new Uint8Array(buffer, 0, SYS_SIZE);
  const view = new DataView(buffer, 0, SYS_SIZE);
  const excluded = new Set(table.sysSav?.regions?.A?.excludedSlots ?? [0]);

  const readBits: SysReadSlot[] = [];
  for (let slot = 0; slot < table.scripts.length; slot++) {
    if (excluded.has(slot)) continue;
    const base = REGION_A_START + slot * REGION_A_SLOT_BYTES;
    if (base + REGION_A_SLOT_BYTES > REGION_A_END) break;
    const bits: number[] = [];
    for (let i = 0; i < REGION_A_SLOT_BYTES * 8; i++) {
      if ((bytes[base + (i >> 3)]! & (0x80 >> (i & 7))) !== 0) bits.push(i);
    }
    if (bits.length > 0) readBits.push({ slot, script: table.scripts[slot]!, bits });
  }

  const cgIds: number[] = [];
  for (let i = 0; i < REGION_B_END - REGION_B_START; i++) {
    if (bytes[REGION_B_START + i] !== 0) cgIds.push(i);
  }

  const flags: number[] = new Array(REGION_C_COUNT);
  for (let i = 0; i < REGION_C_COUNT; i++) {
    flags[i] = view.getUint32(REGION_C_START + i * 4, true);
  }

  return { readBits, cgIds, flags };
}

/** Sequential indices of `say`/`narrate` events — the Region A bit domain. */
function messageEvents(scenario: Scenario): number[] {
  const out: number[] = [];
  for (let i = 0; i < scenario.events.length; i++) {
    const t = scenario.events[i]!.t;
    if (t === "say" || t === "narrate") out.push(i);
  }
  return out;
}

/** Choice nodes of one script in engine order (the Region C node order). */
function choiceNodes(flow: FlowData, script: string): FlowNode[] {
  return flow.nodes
    .filter((n) => n.engine.script === script)
    .sort((a, b) => a.engine.event - b.engine.event);
}

/** Bitmask -> 1-based option numbers that exist on the node. */
function maskOptions(value: number, maxOption: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < 31; k++) {
    if ((value & (1 << k)) === 0) continue;
    const n = k + 1;
    if (n <= maxOption) out.push(n);
  }
  return out;
}

/** Build the global profile from a decoded system save. `readKeys` is the
 * `script:event` list (the read-set keys the reader understands). */
export function buildSysProfile(
  sys: SysSave,
  table: SysSlotsTable,
  router: Router,
  flow: FlowData,
  fileName?: string,
): { profile: SysProfile; readKeys: string[] } {
  const readKeys: string[] = [];
  const visited: string[] = [];
  for (const entry of sys.readBits) {
    const scenario = router.scripts.get(entry.script);
    if (!scenario) continue;
    const msgs = messageEvents(scenario);
    let any = false;
    for (const bit of entry.bits) {
      // The trailing sentinel (bit === msgs.length) marks a fully read
      // script; anything past it is garbage from a foreign table.
      if (bit >= msgs.length) continue;
      any = true;
      readKeys.push(`${entry.script}:${msgs[bit]!}`);
    }
    if (any && !visited.includes(entry.script)) visited.push(entry.script);
  }

  const endings: string[] = [];
  for (const [slot, id] of Object.entries(table.endingSlots)) {
    // Confidence gate: `hypothesis` / `reserved` slots are never evidence
    // (slot 99 is force-zeroed by the engine; slot 1 only implies ic-end).
    if (table.endingSlotsConfidence[slot] !== "high") continue;
    if ((sys.flags[Number(slot)] ?? 0) !== 0 && !endings.includes(id)) endings.push(id);
  }

  const seenPicks: Record<string, number[]> = {};
  const { scriptIds, base, stride } = table.choiceTable;
  scriptIds.forEach((script, choiceIdx) => {
    const nodes = choiceNodes(flow, script);
    const n = Math.min(nodes.length, stride);
    for (let nodeIdx = 0; nodeIdx < n; nodeIdx++) {
      const node = nodes[nodeIdx]!;
      const value = sys.flags[base + stride * choiceIdx + nodeIdx] ?? 0;
      if (value === 0) continue;
      const opts = maskOptions(value, node.options.length);
      if (opts.length > 0) seenPicks[node.id] = opts;
    }
  });

  const music: number[] = [];
  for (let slot = MUSIC_FIRST; slot <= MUSIC_LAST; slot++) {
    if ((sys.flags[slot] ?? 0) !== 0) music.push(slot - 100);
  }

  const movies: number[] = [];
  if ((sys.flags[MOVIE_SENTINEL_SLOT] ?? 0) !== 0) movies.push(0);
  for (let slot = MOVIE_FIRST; slot <= MOVIE_LAST; slot++) {
    if ((sys.flags[slot] ?? 0) !== 0) movies.push(slot - 200);
  }

  const ero: number[] = [];
  for (let slot = ERO_FIRST; slot <= ERO_LAST; slot++) {
    if ((sys.flags[slot] ?? 0) !== 0) ero.push(slot - 300);
  }

  const gates: Record<string, number> = {};
  for (const [name, key] of Object.entries(GATE_NAMES)) {
    const slot = table.gateSlots[key];
    if (typeof slot !== "number") continue;
    gates[name] = sys.flags[slot] ?? 0;
  }

  const gameFlags: Record<string, number> = {};
  for (let slot = 0; slot < 900; slot++) {
    const val = sys.flags[slot] ?? 0;
    if (val !== 0) gameFlags[String(slot)] = val;
  }

  const profile: SysProfile = {
    version: 1,
    ...(fileName ? { fileName } : {}),
    importedAt: new Date().toISOString(),
    readKeys,
    visited,
    endings,
    seenPicks,
    cg: sys.cgIds.slice(),
    music,
    movies,
    ero,
    gates,
    gameFlags,
  };
  return { profile, readKeys };
}

/** Gallery rows unlocked by a CG id set (a row counts when any nonzero cell
 * id has a set byte in Region B). */
export function countGalleryRows(
  cgSet: Set<number> | number[],
  cgRows: number[][],
): { unlocked: number; total: number } {
  const has = cgSet instanceof Set ? (id: number) => cgSet.has(id) : (id: number) => cgSet.includes(id);
  let unlocked = 0;
  for (const row of cgRows) {
    if (row.some((cid) => cid !== 0 && has(cid))) unlocked++;
  }
  return { unlocked, total: cgRows.length };
}

function unionStrings(a: string[], b: string[]): string[] {
  const out = [...a];
  const seen = new Set(a);
  for (const v of b) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function unionNumbers(a: number[], b: number[]): number[] {
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

/** Monotonic merge of two profiles: global progress only ever grows, so an
 * import can never clear read lines, endings, unlocks or choice history. */
export function mergeSysProfile(existing: SysProfile | null, incoming: SysProfile): SysProfile {
  if (!existing) {
    return {
      ...incoming,
      readKeys: [...new Set(incoming.readKeys)],
      visited: [...new Set(incoming.visited)],
      endings: [...new Set(incoming.endings)],
      seenPicks: Object.fromEntries(
        Object.entries(incoming.seenPicks).map(([k, v]) => [k, unionNumbers([], v)]),
      ),
      cg: unionNumbers([], incoming.cg),
      music: unionNumbers([], incoming.music),
      movies: unionNumbers([], incoming.movies),
      ero: unionNumbers([], incoming.ero),
      gates: { ...incoming.gates },
      ...(incoming.gameFlags ? { gameFlags: { ...incoming.gameFlags } } : {}),
    };
  }
  const seenPicks: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(existing.seenPicks)) seenPicks[k] = unionNumbers([], v);
  for (const [k, v] of Object.entries(incoming.seenPicks)) {
    seenPicks[k] = unionNumbers(seenPicks[k] ?? [], v);
  }
  const gates: Record<string, number> = { ...existing.gates };
  for (const [k, v] of Object.entries(incoming.gates)) {
    gates[k] = ((gates[k] ?? 0) | v) >>> 0;
  }
  let gameFlags: Record<string, number> | undefined;
  if (existing.gameFlags !== undefined || incoming.gameFlags !== undefined) {
    gameFlags = { ...(existing.gameFlags ?? {}) };
    for (const [k, v] of Object.entries(incoming.gameFlags ?? {})) {
      if (typeof v === "number" && Number.isFinite(v)) {
        gameFlags[k] = Math.max(gameFlags[k] ?? 0, v);
      }
    }
  }
  return {
    version: 1,
    fileName: incoming.fileName ?? existing.fileName,
    importedAt: incoming.importedAt || existing.importedAt,
    readKeys: unionStrings(existing.readKeys, incoming.readKeys),
    visited: unionStrings(existing.visited, incoming.visited),
    endings: unionStrings(existing.endings, incoming.endings),
    seenPicks,
    cg: unionNumbers(existing.cg, incoming.cg),
    music: unionNumbers(existing.music, incoming.music),
    movies: unionNumbers(existing.movies, incoming.movies),
    ero: unionNumbers(existing.ero, incoming.ero),
    gates,
    ...(gameFlags ? { gameFlags } : {}),
  };
}