import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "../engine/router";
import type { FlowData, LinksData, SaveData, Scenario, SysSlotsTable, TerminalsData } from "../engine/types";
import type { NativeSave } from "../engine/native-save";
import { readProfile, setSaveNamespace, writeProfile } from "../engine/save";
import { SYS_SIZE } from "../engine/sys-save";
import { nativeCandidates, importSysSave } from "./saves";

const emptyFlow: FlowData = { version: 1, nodes: [] };
const emptyLinks: LinksData = { version: 1, links: [] };
const emptyTerms: TerminalsData = { version: 1, terminals: {} };

afterEach(() => {
  vi.unstubAllGlobals();
  setSaveNamespace("");
});

function native(route: string, text = "Shared line."): NativeSave {
  return {
    version: 2,
    playtime: 0,
    timestamp: "",
    preview: text,
    text,
    speaker: "",
    options: [],
    script: "1007",
    route,
  };
}

function scenario(script: string, text: string, count = 1): Scenario {
  return {
    script,
    tokens: count,
    warnings: [],
    events: Array.from({ length: count }, () => ({ t: "narrate" as const, text })),
  };
}

describe("native route candidates", () => {
  it("prefers an exact route variant and exposes its position", () => {
    const router = new Router(
      [scenario("1007", "Base line.", 1), scenario("1007_030", "Shared line.", 3)],
      emptyFlow, emptyLinks, emptyTerms,
    );
    const out = nativeCandidates(router, native("030"));
    expect(out).toHaveLength(3);
    expect(out.every((p) => p.script === "1007_030")).toBe(true);
    expect(out.map((p) => p.event)).toEqual([0, 1, 2]);
  });

  it("returns every exact duplicate instead of choosing one", () => {
    const router = new Router(
      [scenario("1007", "Shared line.", 2)],
      emptyFlow, emptyLinks, emptyTerms,
    );
    const out = nativeCandidates(router, native("2"));
    expect(out.map((p) => p.event)).toEqual([0, 1]);
  });
});

// ---- Sys.sav import -------------------------------------------------------

const REGION_B_START = 0x080000;
const REGION_C_START = 0x268480;

function table(): SysSlotsTable {
  return {
    version: 1,
    scripts: ["UNTRUSTED", "1007"],
    choiceTable: { scriptIds: [], base: 900, stride: 4 },
    cgRows: [[100100, 0], [0, 0]],
    endingSlots: { "22": "cc-setsuna", "99": "coda-setsuna-true" },
    endingSlotsConfidence: { "22": "high", "99": "reserved" },
    gateSlots: { setsunaCcSlot: 22 },
  };
}

const sysFlow: FlowData = { version: 1, nodes: [] };

/** Five readable lines in 1007, so bits 0..4 are real and 5 is the sentinel. */
function scenarios(): Scenario[] {
  return [scenario("1007", "line", 5)];
}

function sysBuffer(opts: { sentinel?: boolean; coda?: boolean; truncated?: boolean } = {}): ArrayBuffer {
  const buf = new Uint8Array(opts.truncated ? 1024 : SYS_SIZE);
  const slot = 1; // scripts[1] = "1007"
  for (let bit = 0; bit < 5; bit++) {
    const base = slot * 0x200;
    buf[base + (bit >> 3)] = buf[base + (bit >> 3)]! | (0x80 >> (bit & 7));
  }
  if (opts.sentinel) {
    const base = slot * 0x200;
    buf[base + (5 >> 3)] = buf[base + (5 >> 3)]! | (0x80 >> (5 & 7));
  }
  if (opts.truncated) return buf.buffer;
  buf[REGION_B_START + 100100] = 1;
  const view = new DataView(buf.buffer);
  view.setUint32(REGION_C_START + 22 * 4, 1, true);
  if (opts.coda) view.setUint32(REGION_C_START + 99 * 4, 1, true);
  return buf.buffer;
}

function memoryStorage(): { storage: Storage; store: Map<string, string> } {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
  return { storage, store };
}

function runningSave(): SaveData {
  return {
    version: 1,
    name: "Run",
    updatedAt: "2026-11-13T00:00:00.000Z",
    position: { script: "1007", event: 3 },
    flags: { aff: { setsuna: 2 }, set: { seen: true } },
    picks: { "2019-1484": 2 },
    visited: ["1007"],
    endings: [],
    log: [{ speaker: "A", text: "line" }],
    lastLogged: "1007:3",
    bgm: { track: 12 },
  };
}

describe("Sys.sav import", () => {
  it("records global progress without moving the reading position", () => {
    const { storage } = memoryStorage();
    const save = runningSave();
    const before = structuredClone(save);
    const res = importSysSave(
      sysBuffer({ sentinel: true }), "Sys.sav", table(),
      new Router(scenarios(), sysFlow), sysFlow, save, storage,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The run object is the same identity: position, log, flags, picks and
    // the BGM state are untouched; only the global arrays grow.
    expect(res.save).toBe(save);
    expect(save.position).toEqual(before.position);
    expect(save.log).toEqual(before.log);
    expect(save.flags).toEqual(before.flags);
    expect(save.picks).toEqual(before.picks);
    expect(save.bgm).toEqual(before.bgm);
    expect(save.visited).toEqual(["1007"]);
    expect(save.endings).toEqual(["cc-setsuna"]);
    // Five real lines; the sentinel bit at index 5 is not a line.
    expect(res.readKeys).toEqual([
      "1007:0", "1007:1", "1007:2", "1007:3", "1007:4",
    ]);
    expect(res.addedReadKeys).toBe(5);
    expect(res.gainedEndings).toBe(1);
    expect(res.profile.cg).toEqual([100100]);
    expect(res.profile.endings).toEqual(["cc-setsuna"]);
    expect(res.profile.endings).not.toContain("coda-setsuna-true");
    const stored = readProfile(storage)!;
    expect(stored.readKeys).toHaveLength(5);
    expect(stored.fileName).toBe("Sys.sav");
  });

  it("reports a truncated Sys.sav instead of pretending it was imported", () => {
    const { storage } = memoryStorage();
    const save = runningSave();
    const res = importSysSave(
      sysBuffer({ truncated: true }), "Sys.sav", table(),
      new Router(scenarios(), sysFlow), sysFlow, save, storage,
    );
    expect(res).toEqual({ ok: false, reason: "truncated", size: 1024, expected: SYS_SIZE });
    expect(readProfile(storage)).toBeNull();
    expect(save.visited).toEqual(["1007"]);
    expect(save.endings).toEqual([]);
  });

  it("flags a profile/read set that browser storage refused", () => {
    // A quota error must not be reported as a successful, durable import:
    // the caller shows "storage is full" instead of "Sys.sav imported".
    const save = runningSave();
    const denied = {
      getItem: () => null,
      setItem: () => { throw new Error("QuotaExceededError"); },
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      get length() { return 0; },
    } as unknown as Storage;
    // `ingestReadKeys` flushes the read set through the global storage, so
    // both must be denied for the test to mean anything.
    vi.stubGlobal("localStorage", denied);
    setSaveNamespace("pack-sys-denied");
    try {
      const res = importSysSave(
        sysBuffer(), "Sys.sav", table(),
        new Router(scenarios(), sysFlow), sysFlow, save, denied,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.profileSaved).toBe(false);
      expect(res.readKeysPersisted).toBe(false);
      // The in-memory read set still works for this session.
      expect(res.addedReadKeys).toBe(5);
    } finally {
      vi.unstubAllGlobals();
      setSaveNamespace("");
    }
  });

  it("reports a profile write success separately from the read-set write", () => {
    const { storage } = memoryStorage();
    // `ingestReadKeys` flushes through the global storage: point it at the
    // same in-memory store under a fresh namespace.
    vi.stubGlobal("localStorage", storage);
    setSaveNamespace("pack-sys-ok");
    const res = importSysSave(
      sysBuffer(), "Sys.sav", table(),
      new Router(scenarios(), sysFlow), sysFlow, runningSave(), storage,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.profileSaved).toBe(true);
    expect(res.readKeysPersisted).toBe(true);
    expect(JSON.parse(storage.getItem("wa2web.pack-sys-ok.read")!)).toHaveLength(5);
  });

  it("merges monotonically across imports", () => {    const { storage } = memoryStorage();
    const router = new Router(scenarios(), sysFlow);
    const save = runningSave();
    const first = importSysSave(sysBuffer(), "a.sav", table(), router, sysFlow, save, storage);
    expect(first.ok).toBe(true);
    // A second, smaller profile (no coda flag, same lines) must not erase.
    const second = importSysSave(sysBuffer({ coda: true }), "b.sav", table(), router, sysFlow, save, storage);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.profile.readKeys).toHaveLength(5);
    expect(second.profile.endings).toEqual(["cc-setsuna"]);
    expect(second.profile.fileName).toBe("b.sav");
    expect(second.addedReadKeys).toBe(0);
    expect(save.endings).toEqual(["cc-setsuna"]);
    // A stored profile with older fields is unioned on the next import.
    writeProfile(storage, { ...second.profile, endings: ["cc-koharu"] });
    const third = importSysSave(sysBuffer(), "c.sav", table(), router, sysFlow, save, storage);
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.profile.endings.sort()).toEqual(["cc-koharu", "cc-setsuna"]);
  });
});
