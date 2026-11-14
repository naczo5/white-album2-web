// File-based + localStorage saves. A save is a self-contained JSON document:
// export downloads it (Store progress in a file), import restores it.
// localStorage holds autosave + named slots for convenience; the FILE is
// the source of truth and the unit under test (round-trip stable).

import type {
  CfgCallFrame,
  CfgRuntimeState,
  CfgStackFrame,
  Flags,
  Position,
  SaveData,
  SysProfile,
} from "./types";

export const SAVE_VERSION = 1;
/** Default namespace for a local full build; setSaveNamespace() isolates
 * demo and external-pack progress on the same origin. */
let namespace = "wa2web";

export function setSaveNamespace(id: string): void {
  namespace = id ? `wa2web.${id}` : "wa2web";
}

export function storageKey(name: string): string {
  return `${namespace}.${name}`;
}

export const SLOT_KEY = (i: number) => storageKey(`slot.${i}`);

export function newSave(name: string, position: Position): SaveData {
  return {
    version: SAVE_VERSION,
    name,
    updatedAt: new Date().toISOString(),
    position,
    flags: { aff: {}, set: {} },
    picks: {},
    visited: [],
    endings: [],
    log: [],
  };
}

export function serialize(save: SaveData): string {
  return JSON.stringify({ ...save, updatedAt: new Date().toISOString() });
}

function sanitizeRanges(raw: unknown): [number, number][] {
  if (!Array.isArray(raw)) return [];
  const out: [number, number][] = [];
  for (const r of raw) {
    if (Array.isArray(r) && r.length >= 2 &&
      typeof r[0] === "number" && Number.isFinite(r[0]) &&
      typeof r[1] === "number" && Number.isFinite(r[1])) {
      out.push([r[0], r[1]]);
    }
  }
  return out;
}

function sanitizePcStack(raw: unknown): CfgStackFrame[] {
  if (!Array.isArray(raw)) return [];
  const out: CfgStackFrame[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const rec = f as { path?: unknown; idx?: unknown };
    if (!Array.isArray(rec.path) || typeof rec.idx !== "number" || !Number.isInteger(rec.idx)) continue;
    const path = rec.path.filter((x): x is number => typeof x === "number" && Number.isInteger(x));
    out.push({ path, idx: rec.idx });
  }
  return out;
}

function sanitizeCallFrame(raw: unknown): CfgCallFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Partial<CfgCallFrame>;
  if (typeof f.script !== "string" || typeof f.entry !== "string") return null;
  const l = Array.isArray(f.l) ? f.l.map((x) => (typeof x === "number" && Number.isFinite(x) ? x : 0)) : [];
  const frame: CfgCallFrame = {
    script: f.script,
    entry: f.entry,
    l,
    pcStack: sanitizePcStack(f.pcStack),
    event: typeof f.event === "number" && Number.isInteger(f.event) ? f.event : 0,
    executedRanges: sanitizeRanges(f.executedRanges),
  };
  if (typeof f.spanEnd === "number" && Number.isFinite(f.spanEnd)) {
    frame.spanEnd = f.spanEnd;
  }
  return frame;
}

function sanitizeCfgState(raw: unknown): CfgRuntimeState | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const c = raw as Partial<CfgRuntimeState>;
  if (typeof c.script !== "string" || typeof c.entry !== "string") return undefined;
  const l = Array.isArray(c.l) ? c.l.map((x) => (typeof x === "number" && Number.isFinite(x) ? x : 0)) : [];
  const callStack = Array.isArray(c.callStack)
    ? c.callStack.map(sanitizeCallFrame).filter((x): x is CfgCallFrame => x !== null)
    : [];
  const state: CfgRuntimeState = {
    script: c.script,
    entry: c.entry,
    l,
    pcStack: sanitizePcStack(c.pcStack),
    callStack,
    executedRanges: sanitizeRanges(c.executedRanges),
  };
  if (typeof c.spanEnd === "number" && Number.isFinite(c.spanEnd)) {
    state.spanEnd = c.spanEnd;
  }
  return state;
}

export function deserialize(json: string): SaveData {
  const data = JSON.parse(json) as SaveData;
  if (data.version !== SAVE_VERSION) {
    throw new Error(`unsupported save version ${String(data.version)}`);
  }
  if (!data.position || typeof data.position.script !== "string") {
    throw new Error("save has no position.script");
  }
  if (!Number.isInteger(data.position.event) || data.position.event < 0) {
    throw new Error("save has a bad position.event");
  }
  const rawFlags = data.flags as Partial<Flags> | undefined;
  const flags: Flags = { aff: rawFlags?.aff ?? {}, set: rawFlags?.set ?? {} };
  for (const [k, v] of Object.entries(flags.aff)) {
    if (typeof v !== "number") throw new Error(`bad affection value for ${k}`);
  }
  if (Array.isArray(rawFlags?.g)) {
    flags.g = rawFlags.g.map((x) => (typeof x === "number" && Number.isFinite(x) ? x : 0));
  }
  if (rawFlags?.gflags && typeof rawFlags.gflags === "object" && !Array.isArray(rawFlags.gflags)) {
    const gflags: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawFlags.gflags)) {
      if (typeof v === "number" && Number.isFinite(v)) gflags[k] = v;
    }
    flags.gflags = gflags;
  }
  const cfgState = sanitizeCfgState(rawFlags?.cfg);
  if (cfgState) flags.cfg = cfgState;
  data.flags = flags;
  if (typeof data.name !== "string") data.name = "Haruki";
  if (typeof data.updatedAt !== "string") data.updatedAt = new Date().toISOString();
  data.picks = (data.picks && typeof data.picks === "object") ? data.picks : {};
  data.visited = Array.isArray(data.visited)
    ? data.visited.filter((x): x is string => typeof x === "string")
    : [];
  data.endings = Array.isArray(data.endings)
    ? data.endings.filter((x): x is string => typeof x === "string")
    : [];
  data.log = Array.isArray(data.log)
    ? data.log
      .filter((l) => l && typeof (l as { text?: unknown }).text === "string")
      .map((l) => ({
        speaker: typeof l.speaker === "string" ? l.speaker : "",
        text: l.text,
      }))
    : [];
  if (data.lastLogged !== undefined && typeof data.lastLogged !== "string") {
    throw new Error("bad lastLogged");
  }
  if (data.bgm !== undefined && data.bgm !== null) {
    if (typeof data.bgm !== "object" || !Number.isInteger((data.bgm as { track?: unknown }).track)) {
      throw new Error("bad bgm state");
    }
  }
  if (data.native !== undefined) {
    const n = data.native;
    if (!n || typeof n !== "object" || typeof n.script !== "string") {
      delete data.native;
    } else {
      data.native = {
        file: typeof n.file === "string" ? n.file : undefined,
        script: n.script,
        route: typeof n.route === "string" ? n.route : undefined,
        preview: typeof n.preview === "string" ? n.preview : undefined,
        speaker: typeof n.speaker === "string" ? n.speaker : undefined,
        options: Array.isArray(n.options)
          ? n.options.filter((x): x is string => typeof x === "string")
          : undefined,
        timestamp: typeof n.timestamp === "string" ? n.timestamp : undefined,
        playtime: typeof n.playtime === "number" ? n.playtime : undefined,
        version: typeof n.version === "number" ? n.version : undefined,
        ambiguous: n.ambiguous === true ? true : undefined,
        confidence: n.confidence === "exact" || n.confidence === "fuzzy" || n.confidence === "choice"
          ? n.confidence
          : undefined,
        candidate: Number.isInteger(n.candidate) ? n.candidate : undefined,
        candidateCount: Number.isInteger(n.candidateCount) ? n.candidateCount : undefined,
      };
    }
  }
  return data;
}

/** Slot read that distinguishes corrupt data (reported) from empty. */
export function readSlotChecked(storage: Storage, i: number):
  | { ok: true; save: SaveData }
  | { ok: false; corrupt: boolean } {
  let raw: string | null;
  try {
    raw = storage.getItem(SLOT_KEY(i));
  } catch {
    return { ok: false, corrupt: false };
  }
  if (!raw) return { ok: false, corrupt: false };
  try {
    return { ok: true, save: deserialize(raw) };
  } catch {
    return { ok: false, corrupt: true };
  }
}

export function writeSlot(storage: Storage, i: number, save: SaveData): boolean {
  try {
    storage.setItem(SLOT_KEY(i), serialize(save));
    return true;
  } catch {
    return false;
  }
}

export function readSlot(storage: Storage, i: number): SaveData | null {
  try {
    const raw = storage.getItem(SLOT_KEY(i));
    if (!raw) return null;
    return deserialize(raw);
  } catch {
    return null;
  }
}

export function writeAutosave(storage: Storage, save: SaveData): boolean {
  try {
    storage.setItem(storageKey("autosave"), serialize(save));
    return true;
  } catch {
    return false;
  }
}

export function writeQuicksave(storage: Storage, save: SaveData): boolean {
  try {
    storage.setItem(storageKey("quicksave"), serialize(save));
    return true;
  } catch {
    return false;
  }
}

function readStored(storage: Storage, key: string): SaveData | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return deserialize(raw);
  } catch {
    return null;
  }
}

export function readQuicksave(storage: Storage): SaveData | null {
  return readStored(storage, storageKey("quicksave"));
}

export function readAutosave(storage: Storage): SaveData | null {
  return readStored(storage, storageKey("autosave"));
}

// ---- Global profile (Sys.sav import) -------------------------------------
// Kept in its own key so a new game, a slot load or an autosave overwrite
// can never erase accumulated read lines, endings or unlock bands.

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function numberList(v: unknown): number[] {
  return Array.isArray(v)
    ? [...new Set(v.filter((x): x is number => Number.isInteger(x) && (x as number) >= 0))].sort((a, b) => a - b)
    : [];
}

/** Sanitize a stored profile field-by-field; malformed data degrades to an
 * empty (but usable) profile instead of throwing at boot. */
export function sanitizeProfile(raw: unknown): SysProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<SysProfile>;
  if (p.version !== 1) return null;
  const seenPicks: Record<string, number[]> = {};
  if (p.seenPicks && typeof p.seenPicks === "object" && !Array.isArray(p.seenPicks)) {
    for (const [k, v] of Object.entries(p.seenPicks)) {
      const opts = numberList(v).filter((n) => n >= 1);
      if (opts.length > 0) seenPicks[k] = opts;
    }
  }
  const gates: Record<string, number> = {};
  if (p.gates && typeof p.gates === "object" && !Array.isArray(p.gates)) {
    for (const [k, v] of Object.entries(p.gates)) {
      if (typeof v === "number" && Number.isFinite(v)) gates[k] = v;
    }
  }
  let gameFlags: Record<string, number> | undefined;
  if (p.gameFlags && typeof p.gameFlags === "object" && !Array.isArray(p.gameFlags)) {
    gameFlags = {};
    for (const [k, v] of Object.entries(p.gameFlags)) {
      if (typeof v === "number" && Number.isInteger(v)) gameFlags[k] = v;
    }
  }
  return {
    version: 1,
    ...(typeof p.fileName === "string" && p.fileName ? { fileName: p.fileName } : {}),
    importedAt: typeof p.importedAt === "string" ? p.importedAt : new Date().toISOString(),
    readKeys: [...new Set(stringList(p.readKeys))],
    visited: [...new Set(stringList(p.visited))],
    endings: [...new Set(stringList(p.endings))],
    seenPicks,
    cg: numberList(p.cg),
    music: numberList(p.music),
    movies: numberList(p.movies),
    ero: numberList(p.ero),
    gates,
    ...(gameFlags ? { gameFlags } : {}),
  };
}

export function readProfile(storage: Storage): SysProfile | null {
  let raw: string | null;
  try {
    raw = storage.getItem(storageKey("profile"));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return sanitizeProfile(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeProfile(storage: Storage, p: SysProfile): boolean {
  try {
    storage.setItem(storageKey("profile"), JSON.stringify(p));
    return true;
  } catch {
    /* quota: global progress is recoverable by re-importing Sys.sav */
    return false;
  }
}

export function clearProfile(storage: Storage): void {
  try {
    storage.removeItem(storageKey("profile"));
  } catch {
    /* storage unavailable: nothing to clear */
  }
}

export function download(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function saveFilename(save: SaveData): string {
  const stamp = save.updatedAt.replace(/[:.]/g, "-");
  const pos = `${save.position.script}-${save.position.event}`;
  const rand = Math.random().toString(36).slice(2, 8);
  return `wa2web-${pos}-${stamp}-${rand}.json`;
}

export function freshFlags(): Flags {
  return { aff: {}, set: {} };
}
