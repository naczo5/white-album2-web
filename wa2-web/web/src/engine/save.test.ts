import { describe, expect, it } from "vitest";
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
    const back = deserialize(serialize(s));
    expect(back.position).toEqual({ script: "2019", event: 736 });
    expect(back.picks["2019-736"]).toBe(3);
    expect(back.flags.aff["setsuna"]).toBe(4);
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
});
