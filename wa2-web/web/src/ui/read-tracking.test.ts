// Read-set ingest + namespace isolation: what a Sys.sav import feeds into
// skip-read, and why the cache must be keyed by the namespaced storage key.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestReadKeys } from "./reader";
import { setSaveNamespace, storageKey } from "../engine/save";

function memoryStorage() {
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

afterEach(() => {
  vi.unstubAllGlobals();
  setSaveNamespace("");
});

describe("ingestReadKeys", () => {
  it("persists imported keys immediately", () => {
    const { storage, store } = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    setSaveNamespace("pack-test");
    const res = ingestReadKeys(["1002:0", "1002:2", "2019:1484"]);
    expect(res).toEqual({ added: 3, persisted: true });
    const key = storageKey("read");
    expect(key).toBe("wa2web.pack-test.read");
    expect(JSON.parse(store.get(key)!)).toEqual(["1002:0", "1002:2", "2019:1484"]);
  });

  it("counts only keys that were not already read", () => {
    const { storage, store } = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    setSaveNamespace("pack-dedupe");
    store.set(storageKey("read"), JSON.stringify(["1002:0"]));
    expect(ingestReadKeys(["1002:0", "1002:1"]).added).toBe(1);
    expect(JSON.parse(store.get(storageKey("read"))!).sort()).toEqual(["1002:0", "1002:1"]);
    expect(ingestReadKeys(["1002:0", "1002:1"]).added).toBe(0);
  });

  it("keeps namespaces apart instead of reusing a cached set", () => {
    const { storage, store } = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    setSaveNamespace("pack-a");
    expect(ingestReadKeys(["1002:0"]).added).toBe(1);
    // Same process, different pack: the cached set must be reloaded from
    // the new key, not reused (cross-namespace leakage in tests/boot).
    setSaveNamespace("pack-b");
    expect(ingestReadKeys(["1002:0"]).added).toBe(1);
    setSaveNamespace("pack-a");
    expect(ingestReadKeys(["1002:0"]).added).toBe(0);
    expect(JSON.parse(store.get("wa2web.pack-b.read")!)).toEqual(["1002:0"]);
    expect(JSON.parse(store.get("wa2web.pack-a.read")!)).toEqual(["1002:0"]);
  });

  it("ignores non-string keys from a foreign profile", () => {
    const { storage, store } = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    setSaveNamespace("pack-foreign");
    const res = ingestReadKeys([5 as unknown as string, "1002:0", null as unknown as string]);
    expect(res.added).toBe(1);
    expect(JSON.parse(store.get(storageKey("read"))!)).toEqual(["1002:0"]);
  });

  it("reports a failed write instead of claiming persistence", () => {
    // Quota errors are the realistic case: the in-memory set still accepts
    // the keys (skip-read works this session), but the caller must know the
    // browser never kept them.
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => { throw new Error("QuotaExceededError"); },
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      get length() { return 0; },
    } as unknown as Storage);
    setSaveNamespace("pack-quota");
    expect(ingestReadKeys(["1002:0"])).toEqual({ added: 1, persisted: false });
  });

  it("is harmless when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
    } as unknown as Storage);
    setSaveNamespace("pack-denied");
    // The in-memory set still accepts the keys; persistence fails cleanly.
    const res = ingestReadKeys(["1002:0"]);
    expect(res.added).toBe(1);
    expect(res.persisted).toBe(false);
  });
});
