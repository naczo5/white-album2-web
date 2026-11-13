// File-based + localStorage saves. A save is a self-contained JSON document:
// export downloads it (Store progress in a file), import restores it.
// localStorage holds autosave + named slots for convenience; the FILE is
// the source of truth and the unit under test (round-trip stable).

import type { Flags, Position, SaveData, SysProfile } from "./types";

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
  data.flags = { aff: data.flags?.aff ?? {}, set: data.flags?.set ?? {} };
  for (const [k, v] of Object.entries(data.flags.aff)) {
    if (typeof v !== "number") throw new Error(`bad affection value for ${k}`);
  }
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
