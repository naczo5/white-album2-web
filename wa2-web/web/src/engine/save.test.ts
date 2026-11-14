import { describe, expect, it } from "vitest";
import type { SysProfile } from "./types";
import {
  deserialize,
  newSave,
  readSlot,
  serialize,
  saveFilename,
  writeSlot,
} from "./save";

describe("saves", () => {
  it("round-trips through a file", () => {
    const s = newSave("Haruki", { script: "2019", event: 736 });
    s.picks["2019-736"] = 3;
    s.flags.aff["setsuna"] = 4;
    s.bgm = { track: 41 };
    const back = deserialize(serialize(s));
    expect(back.position).toEqual({ script: "2019", event: 736 });
    expect(back.picks["2019-736"]).toBe(3);
    expect(back.flags.aff["setsuna"]).toBe(4);
    expect(back.bgm).toEqual({ track: 41 });
  });

  it("accepts an explicit BGM stop and rejects malformed state", () => {
    const s = newSave("x", { script: "2019", event: 1 });
    expect(deserialize(JSON.stringify({ ...s, bgm: null })).bgm).toBeNull();
    expect(() => deserialize(JSON.stringify({ ...s, bgm: { track: "x" } }))).toThrow();
  });

  it("repairs a missing updatedAt from an imported file", () => {
    const s = newSave("x", { script: "2019", event: 1 });
    const raw = JSON.stringify({ ...s, updatedAt: undefined });
    expect(deserialize(raw).updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("drops malformed backlog rows instead of crashing the log screen", () => {
    const s = newSave("x", { script: "2019", event: 1 });
    const raw = JSON.stringify({
      ...s, log: [{ speaker: 1, text: "ok" }, { text: 2 }, null],
    });
    expect(deserialize(raw).log).toEqual([{ speaker: "", text: "ok" }]);
  });

  it("rejects wrong versions and malformed positions", () => {
    expect(() => deserialize('{"version":2}')).toThrow();
    expect(() => deserialize('{"version":1}')).toThrow();
    const s = newSave("x", { script: "2019", event: 1 });
    expect(() => deserialize(JSON.stringify({ ...s, position: { script: "2019", event: "x" } }))).toThrow();
    expect(() => deserialize(JSON.stringify({ ...s, position: { script: 5, event: 1 } }))).toThrow();
  });

  it("records END: destinations as endings", async () => {
    const { Router } = await import("./router");
    const r = new Router(
      [{ script: "2019", tokens: 2, warnings: [], events: [
        { t: "choice", options: [{ n: 1, text: "End it", goto: null }] },
        { t: "narrate", text: "after" },
      ] }],
      { version: 1, nodes: [{
        id: "2019-0", engine: { script: "2019", event: 0 },
        options: [{ n: 1, text: "End it", goto: null, play: "END:test-end" }],
        date: null, effects: {}, gated: {}, walkthrough: null,
        note: "test", status: "NEEDS_PLAYTEST",
      }] },
    );
    const res = r.pick({ script: "2019", event: 0 }, 1, { aff: {}, set: {} });
    expect(res.ending).toBe("test-end");
    expect(res.next).toEqual({ script: "2019", event: 1 });
  });

  it("filenames identify position", () => {
    const s = newSave("x", { script: "3016", event: 664 });
    expect(saveFilename(s)).toMatch(/^wa2web-3016-664-.*\.json$/);
  });

  it("slots persist in storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    } as Storage;
    const s = newSave("slot", { script: "1001", event: 0 });
    writeSlot(storage, 0, s);
    expect(readSlot(storage, 0)?.name).toBe("slot");
    expect(readSlot(storage, 1)).toBeNull();
  });

  it("quick save and autosave are separate round-trip stores", async () => {
    const { readAutosave, readQuicksave, writeAutosave, writeQuicksave } = await import("./save");
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    } as Storage;
    expect(readQuicksave(storage)).toBeNull();
    expect(readAutosave(storage)).toBeNull();
    const quick = newSave("quick", { script: "2003", event: 241 });
    const auto = newSave("auto", { script: "2024", event: 83 });
    writeQuicksave(storage, quick);
    writeAutosave(storage, auto);
    expect(readQuicksave(storage)?.name).toBe("quick");
    expect(readAutosave(storage)?.name).toBe("auto");
    expect(store.has("wa2web.quicksave")).toBe(true);
    expect(store.has("wa2web.autosave")).toBe(true);
  });

  it("namespaces demo and pack saves away from the local build", async () => {    const { setSaveNamespace, readAutosave, readQuicksave, writeAutosave, writeQuicksave } = await import("./save");
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    } as Storage;
    setSaveNamespace("demo");
    writeSlot(storage, 0, newSave("demo slot", { script: "demo-1", event: 0 }));
    writeQuicksave(storage, newSave("demo quick", { script: "demo-1", event: 1 }));
    writeAutosave(storage, newSave("demo auto", { script: "demo-1", event: 2 }));
    expect(store.has("wa2web.demo.slot.0")).toBe(true);
    expect(store.has("wa2web.demo.quicksave")).toBe(true);
    expect(readQuicksave(storage)?.name).toBe("demo quick");
    expect(readAutosave(storage)?.name).toBe("demo auto");
    setSaveNamespace("");
    expect(readSlot(storage, 0)).toBeNull();
    expect(readQuicksave(storage)).toBeNull();
    expect(readAutosave(storage)).toBeNull();
    writeSlot(storage, 0, newSave("local slot", { script: "1001", event: 0 }));
    expect(readSlot(storage, 0)?.name).toBe("local slot");
    expect(store.has("wa2web.slot.0")).toBe(true);
  });

  it("persists, reads back and clears the global profile", async () => {
    const { clearProfile, readProfile, setSaveNamespace, writeProfile } = await import("./save");
    setSaveNamespace("");
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    } as Storage;
    expect(readProfile(storage)).toBeNull();
    const p: SysProfile = {
      version: 1,
      fileName: "Sys.sav",
      importedAt: "2026-11-13T10:00:00.000Z",
      readKeys: ["1001:0", "1001:2"],
      visited: ["1001"],
      endings: ["cc-setsuna"],
      seenPicks: { "2019-1484": [1, 2, 3] },
      cg: [100100],
      music: [1, 2],
      movies: [0],
      ero: [3],
      gates: { replay: 1 },
    };
    expect(writeProfile(storage, p)).toBe(true);
    expect(store.has("wa2web.profile")).toBe(true);
    expect(readProfile(storage)).toEqual(p);
    clearProfile(storage);
    expect(readProfile(storage)).toBeNull();
    expect(store.has("wa2web.profile")).toBe(false);
  });

  it("sanitizes a malformed stored profile instead of throwing", async () => {
    const { readProfile } = await import("./save");
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    } as Storage;
    store.set("wa2web.profile", "{not json");
    expect(readProfile(storage)).toBeNull();
    store.set("wa2web.profile", JSON.stringify({ version: 2, readKeys: ["x"] }));
    expect(readProfile(storage)).toBeNull();
    store.set("wa2web.profile", JSON.stringify({
      version: 1,
      readKeys: ["1001:0", 5, null],
      visited: "nope",
      endings: ["cc-mari", "cc-mari"],
      seenPicks: { a: [2, "x", 0], b: "nope" },
      cg: [100100, -1, "x"],
      music: null,
      movies: [2.5, 3],
      ero: [7],
      gates: { replay: 1, bad: "x" },
      importedAt: 42,
    }));
    const fixed = readProfile(storage)!;
    expect(fixed.version).toBe(1);
    expect(fixed.readKeys).toEqual(["1001:0"]);
    expect(fixed.visited).toEqual([]);
    expect(fixed.endings).toEqual(["cc-mari"]);
    expect(fixed.seenPicks).toEqual({ a: [2] });
    expect(fixed.cg).toEqual([100100]);
    expect(fixed.music).toEqual([]);
    expect(fixed.movies).toEqual([3]);
    expect(fixed.ero).toEqual([7]);
    expect(fixed.gates).toEqual({ replay: 1 });
    expect(fixed.importedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps the profile under the active namespace", async () => {
    const { readProfile, setSaveNamespace, writeProfile } = await import("./save");
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    } as Storage;
    const p: SysProfile = {
      version: 1, importedAt: new Date().toISOString(),
      readKeys: [], visited: [], endings: [], seenPicks: {},
      cg: [], music: [], movies: [], ero: [], gates: {},
    };
    setSaveNamespace("pack-abc");
    writeProfile(storage, { ...p, visited: ["2019"] });
    expect(store.has("wa2web.pack-abc.profile")).toBe(true);
    setSaveNamespace("demo");
    expect(readProfile(storage)).toBeNull();
    setSaveNamespace("");
  });

  it("round-trips flags.g, flags.gflags, and flags.cfg with callStack cleanly", () => {
    const s = newSave("Haruki", { script: "1012_030_2", event: 4 });
    s.flags.g = [0, 0, 0, 0, 0, 7, 1, 5];
    s.flags.gflags = { "0": 1, "21": 1 };
    s.flags.cfg = {
      script: "1012_030_2",
      entry: "10",
      l: [2, 0, 1],
      pcStack: [{ path: [2, 0], idx: 1 }],
      callStack: [
        {
          script: "1012_030",
          entry: "0",
          l: [1],
          pcStack: [{ path: [], idx: 5 }],
          event: 12,
          executedRanges: [[0, 12]],
          spanEnd: 12,
        },
      ],
      executedRanges: [[0, 10]],
      spanEnd: 10,
    };
    const back = deserialize(serialize(s));
    expect(back.flags.g).toEqual([0, 0, 0, 0, 0, 7, 1, 5]);
    expect(back.flags.gflags).toEqual({ "0": 1, "21": 1 });
    expect(back.flags.cfg).toEqual(s.flags.cfg);
  });

  it("preserves and sanitizes SysProfile.gameFlags", async () => {
    const { readProfile, setSaveNamespace, writeProfile } = await import("./save");
    setSaveNamespace("");
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    } as Storage;
    const p: SysProfile = {
      version: 1,
      importedAt: "2026-11-13T10:00:00.000Z",
      readKeys: [],
      visited: [],
      endings: [],
      seenPicks: {},
      cg: [],
      music: [],
      movies: [],
      ero: [],
      gates: { replay: 1 },
      gameFlags: { "0": 1, "21": 1 },
    };
    writeProfile(storage, p);
    expect(readProfile(storage)?.gameFlags).toEqual({ "0": 1, "21": 1 });

    store.set("wa2web.profile", JSON.stringify({
      ...p,
      gameFlags: { "0": 1, "bad": "nope", "2": 3.5 },
    }));
    expect(readProfile(storage)?.gameFlags).toEqual({ "0": 1 });
  });
});

