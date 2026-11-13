import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGameData, resolvePackBase } from "./data";

const SCENARIO = {
  script: "1001",
  tokens: 2,
  warnings: [],
  events: [{ t: "narrate", text: "placeholder" }],
};
const FLOW = { version: 1, nodes: [] };

function mockPack(): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    if (url.endsWith("/data/scripts/index.json")) {
      return new Response(JSON.stringify(["1001"]), { status: 200 });
    }
    if (url.endsWith("/data/flow.json")) {
      return new Response(JSON.stringify(FLOW), { status: 200 });
    }
    if (url.endsWith("/data/scripts/1001.json")) {
      return new Response(JSON.stringify(SCENARIO), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadGameData external pack", () => {
  it("prefixes the pack root exactly once", async () => {
    const calls = mockPack();
    const data = await loadGameData("https://pack.example/wa2/");
    expect(data.demo).toBe(false);
    expect(data.scenarios[0]?.script).toBe("1001");
    expect(calls).toContain("https://pack.example/wa2/data/scripts/index.json");
    expect(calls.some((u) => u.includes("/data/data/"))).toBe(false);
  });

  it("falls back to the asset-free demo when the pack has no data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    const data = await loadGameData("https://pack.example/empty");
    expect(data.demo).toBe(true);
    expect(data.scenarios[0]?.script).toBe("demo-1");
  });

  it("keeps the demo flow pointed at the choice event", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    const data = await loadGameData();
    const choice = data.scenarios[0]!.events.findIndex((e) => e.t === "choice");
    expect(data.flow.nodes[0]?.engine).toEqual({ script: "demo-1", event: choice });
  });

  it("loads data/bundle.json in a single request when available", async () => {
    const calls: string[] = [];
    const lut = { r: [0], g: [1], b: [2] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "https://pack.example/wa2/data/bundle.json") {
        return new Response(JSON.stringify({
          version: 1,
          scenarios: [SCENARIO],
          flow: FLOW,
          luts: { version: 1, luts: { sepia: lut } },
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));
    const data = await loadGameData("https://pack.example/wa2");
    expect(data.demo).toBe(false);
    expect(data.scenarios).toEqual([SCENARIO]);
    expect(data.luts).toEqual({ sepia: lut });
    // The bundle has no slot table, so the loose copy is fetched once; the
    // committed table backs it up when that 404s. Still no per-script calls.
    expect(calls).toEqual([
      "https://pack.example/wa2/data/bundle.json",
      "https://pack.example/wa2/data/sys-slots.json",
    ]);
    expect(data.sysSlots.scripts.length).toBeGreaterThan(0);
  });

  it("takes the slot table from the bundle without a second request", async () => {
    const calls: string[] = [];
    const sysSlots = {
      version: 1,
      scripts: ["1001"],
      choiceTable: { scriptIds: [], base: 900, stride: 4 },
      cgRows: [[0]],
      endingSlots: { "22": "cc-setsuna" },
      endingSlotsConfidence: { "22": "high" },
      gateSlots: { replaySlot: 3 },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "https://pack.example/wa2/data/bundle.json") {
        return new Response(JSON.stringify({
          version: 1,
          scenarios: [SCENARIO],
          flow: FLOW,
          sysSlots,
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));
    const data = await loadGameData("https://pack.example/wa2");
    expect(data.sysSlots).toEqual(sysSlots);
    expect(calls).toEqual(["https://pack.example/wa2/data/bundle.json"]);
  });

  it("always exposes a slot table, even for the asset-free demo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    const data = await loadGameData();
    expect(data.demo).toBe(true);
    // Committed data/sys-slots.json keeps Sys.sav import working offline.
    expect(data.sysSlots.scripts.length).toBe(185);
    expect(data.sysSlots.cgRows.length).toBe(168);
    expect(data.sysSlots.endingSlotsConfidence["22"]).toBe("high");
  });
});

describe("resolvePackBase", () => {
  it("uses VITE_PACK_URL as the configured main pack root", () => {
    expect(resolvePackBase("https://pack.example/wa2/?foo=1#bar", "")).toEqual({
      packBase: "https://pack.example/wa2",
      fromQuery: false,
    });
  });

  it("allows ?pack= to override VITE_PACK_URL and rejects non-http schemes", () => {
    expect(resolvePackBase("https://pack.example/wa2", "?pack=https://other.example/pack/")).toEqual({
      packBase: "https://other.example/pack",
      fromQuery: true,
    });
    expect(resolvePackBase("https://pack.example/wa2", "?pack=javascript:alert(1)")).toEqual({
      packBase: "https://pack.example/wa2",
      fromQuery: false,
    });
  });
});

