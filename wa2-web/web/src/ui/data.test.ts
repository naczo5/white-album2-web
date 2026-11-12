import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGameData } from "./data";

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
});
