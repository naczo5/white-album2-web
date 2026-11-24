import { afterEach, describe, expect, it, vi } from "vitest";
import { activeTranslationId, loadGameData, loadTranslations } from "./data";

const SCENARIO = (script: string, text: string) => ({
  script,
  tokens: 2,
  warnings: [],
  events: [{ t: "narrate", text }],
});
const FLOW = (nodes: unknown[] = []) => ({ version: 1, nodes });
const ALT_FLOW = {
  version: 1,
  nodes: [{
    id: "1001-0",
    engine: { script: "1001", event: 0 },
    options: [{ n: 1, text: "alt choice", goto: null }],
    date: null, effects: {}, gated: {}, walkthrough: null, status: "NEEDS_REVIEW",
  }],
};
const CATALOG = {
  version: 1,
  translations: [
    { id: "mao", name: "MAO-TLs", label: "Machine translation" },
    { id: "todokanai", name: "TodokanaiTL", label: "Human translation" },
  ],
};

/** Pack with a default script set and one alt translation on loose files. */
function mockDualPack(opts: { altPresent?: boolean } = {}): string[] {
  const calls: string[] = [];
  const alt = opts.altPresent !== false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    if (url.endsWith("/data/translations/index.json")) {
      return new Response(JSON.stringify(CATALOG), { status: 200 });
    }
    if (url.endsWith("/data/scripts/index.json")) {
      return new Response(JSON.stringify(["1001"]), { status: 200 });
    }
    if (url.endsWith("/data/scripts/1001.json")) {
      return new Response(JSON.stringify(SCENARIO("1001", "base text")), { status: 200 });
    }
    if (url.endsWith("/data/flow.json")) {
      return new Response(JSON.stringify(FLOW()), { status: 200 });
    }
    if (alt && url.endsWith("/data/translations/todokanai/scripts/index.json")) {
      return new Response(JSON.stringify(["1001"]), { status: 200 });
    }
    if (alt && url.endsWith("/data/translations/todokanai/scripts/1001.json")) {
      return new Response(JSON.stringify(SCENARIO("1001", "alt text")), { status: 200 });
    }
    if (alt && url.endsWith("/data/translations/todokanai/flow.json")) {
      return new Response(JSON.stringify(ALT_FLOW), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("activeTranslationId", () => {
  const list = CATALOG.translations;

  it("keeps a stored id the pack offers", () => {
    expect(activeTranslationId(list, "todokanai")).toBe("todokanai");
  });

  it("falls back to the pack default for unknown or empty stored ids", () => {
    expect(activeTranslationId(list, "gone")).toBe("mao");
    expect(activeTranslationId(list, "")).toBe("mao");
    expect(activeTranslationId(list, null)).toBe("mao");
  });

  it("returns an empty id for single-translation packs and demo", () => {
    expect(activeTranslationId([], "todokanai")).toBe("");
  });
});

describe("loadTranslations", () => {
  it("returns the published catalog", async () => {
    mockDualPack();
    const list = await loadTranslations("https://pack.example/dual");
    expect(list.map((t) => t.id)).toEqual(["mao", "todokanai"]);
    expect(list[1]?.label).toBe("Human translation");
  });

  it("returns an empty list when the pack has no catalog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    expect(await loadTranslations("https://pack.example/single")).toEqual([]);
  });
});

describe("loadGameData with a translation", () => {
  it("loads the alt scripts and flow instead of the default set", async () => {
    const calls = mockDualPack();
    const data = await loadGameData("https://pack.example/dualtwo", "todokanai");
    expect(data.demo).toBe(false);
    expect(data.translation).toBe("todokanai");
    expect(data.translationFallback).toBe(false);
    expect(data.scenarios[0]?.events[0]).toMatchObject({ text: "alt text" });
    expect(data.flow.nodes[0]?.options[0]?.text).toBe("alt choice");
    expect(calls).toContain("https://pack.example/dualtwo/data/translations/todokanai/scripts/1001.json");
    expect(calls).not.toContain("https://pack.example/dualtwo/data/scripts/1001.json");
  });

  it("keeps the default set and reports a fallback when alt data is missing", async () => {
    mockDualPack({ altPresent: false });
    const data = await loadGameData("https://pack.example/dual3", "todokanai");
    expect(data.demo).toBe(false);
    expect(data.translationFallback).toBe(true);
    expect(data.scenarios[0]?.events[0]).toMatchObject({ text: "base text" });
  });

  it("keeps the default data when no translation is requested", async () => {
    mockDualPack();
    const data = await loadGameData("https://pack.example/dual4");
    expect(data.translation).toBe("");
    expect(data.translationFallback).toBe(false);
    expect(data.scenarios[0]?.events[0]).toMatchObject({ text: "base text" });
  });
});

describe("loadGameData bundle packs", () => {
  const BUNDLE = {
    version: 1,
    scenarios: [SCENARIO("1001", "bundle text")],
    flow: FLOW(),
    links: { version: 1, links: [] },
    terminals: { version: 1, terminals: {} },
    endings: { endings: [] },
  };

  function mockBundlePack(altPresent: boolean): void {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/data/bundle.json")) {
        return new Response(JSON.stringify(BUNDLE), { status: 200 });
      }
      if (altPresent && url.endsWith("/data/translations/todokanai/scripts/index.json")) {
        return new Response(JSON.stringify(["1001"]), { status: 200 });
      }
      if (altPresent && url.endsWith("/data/translations/todokanai/scripts/1001.json")) {
        return new Response(JSON.stringify(SCENARIO("1001", "alt text")), { status: 200 });
      }
      if (altPresent && url.endsWith("/data/translations/todokanai/flow.json")) {
        return new Response(JSON.stringify(ALT_FLOW), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));
  }

  it("overlays alt scripts and flow on top of the bundle", async () => {
    mockBundlePack(true);
    const data = await loadGameData("https://pack.example/bundle1", "todokanai");
    expect(data.translation).toBe("todokanai");
    expect(data.translationFallback).toBe(false);
    expect(data.scenarios[0]?.events[0]).toMatchObject({ text: "alt text" });
    expect(data.flow.nodes[0]?.options[0]?.text).toBe("alt choice");
  });

  it("uses bundle data and flags a fallback when alt files are absent", async () => {
    mockBundlePack(false);
    const data = await loadGameData("https://pack.example/bundle2", "todokanai");
    expect(data.translationFallback).toBe(true);
    expect(data.scenarios[0]?.events[0]).toMatchObject({ text: "bundle text" });
  });
});
