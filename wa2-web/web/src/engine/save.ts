// File-based + localStorage saves. A save is a self-contained JSON document:
// export downloads it (Store progress in a file), import restores it.
// localStorage holds autosave + named slots for convenience; the FILE is
// the source of truth and the unit under test (round-trip stable).

import type { Flags, Position, SaveData } from "./types";

export const SAVE_VERSION = 1;
export const AUTOSAVE_KEY = "wa2web.autosave";
export const SLOT_KEY = (i: number) => `wa2web.slot.${i}`;

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
  data.picks = data.picks ?? {};
  data.visited = Array.isArray(data.visited) ? data.visited : [];
  data.endings = Array.isArray(data.endings) ? data.endings : [];
  data.log = Array.isArray(data.log) ? data.log : [];
  if (data.lastLogged !== undefined && typeof data.lastLogged !== "string") {
    throw new Error("bad lastLogged");
  }
  return data;
}

/** Slot read that distinguishes corrupt data (reported) from empty. */
export function readSlotChecked(storage: Storage, i: number):
  | { ok: true; save: SaveData }
  | { ok: false; corrupt: boolean } {
  const raw = storage.getItem(SLOT_KEY(i));
  if (!raw) return { ok: false, corrupt: false };
  try {
    return { ok: true, save: deserialize(raw) };
  } catch {
    return { ok: false, corrupt: true };
  }
}

export function writeSlot(storage: Storage, i: number, save: SaveData): void {
  storage.setItem(SLOT_KEY(i), serialize(save));
}

export function readSlot(storage: Storage, i: number): SaveData | null {
  const raw = storage.getItem(SLOT_KEY(i));
  if (!raw) return null;
  try {
    return deserialize(raw);
  } catch {
    return null;
  }
}

export function writeAutosave(storage: Storage, save: SaveData): void {
  storage.setItem(AUTOSAVE_KEY, serialize(save));
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
