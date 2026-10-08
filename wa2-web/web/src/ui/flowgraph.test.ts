// Flowchart graph builder: pure layout (tsukiweb-style chart), test-pinned.

import { describe, expect, it } from "vitest";
import { buildChartGraph, NODE_H, NODE_W } from "./flowchart";
import { buildSpine } from "../engine/router";
import type { LinkSite, TerminalsData } from "../engine/types";

const link = (script: string, targets: string[]): LinkSite => ({
  id: `${script}-x`, engine: { script, events: [0] },
  targets, missing: [], default: targets[0] ?? null, status: "HINT",
});

describe("buildChartGraph", () => {
  const spine = buildSpine(["1002", "1003", "1004", "2001"]);
  const links = [link("1002", ["1003"]), link("1003", ["1004", "2001"])];
  const terminals: TerminalsData["terminals"] = {};

  it("BFS depth columns from the IC root; both branch targets reachable", () => {
    const g = buildChartGraph(["1002", "1003", "1004", "2001"], spine, links, terminals);
    expect(g.depth["1002"]).toBe(0);
    expect(g.depth["1003"]).toBe(1);
    expect(g.depth["1004"]).toBe(2);
    expect(g.depth["2001"]).toBe(2);
    // branch siblings share a row but never overlap
    expect(g.pos["1004"]!.y).toBe(g.pos["2001"]!.y);
    expect(g.pos["1004"]!.x).not.toBe(g.pos["2001"]!.x);
  });

  it("spine edges fill gaps left by decoded links (no duplicates)", () => {
    const g = buildChartGraph(["1002", "1003", "1004"], buildSpine(["1002", "1003", "1004"]), [link("1002", ["1003"])], {});
    const kinds = g.edges.filter((e) => e.from === "1003").map((e) => e.kind);
    expect(kinds).toEqual(["spine"]); // 1003->1004 via spine, no link for it
    expect(g.edges.filter((e) => e.from === "1002").map((e) => e.kind)).toEqual(["link"]);
  });

  it("terminal chains extend the graph", () => {
    const t: TerminalsData["terminals"] = { "1004": { action: "chain", to: "2001" } };
    const g = buildChartGraph(["1002", "1003", "1004", "2001"], spine, [link("1002", ["1003"]), link("1003", ["1004"])], t);
    expect(g.edges.some((e) => e.from === "1004" && e.to === "2001" && e.kind === "chain")).toBe(true);
    expect(g.depth["2001"]).toBe(3);
  });

  it("cycles do not loop forever and cross-edges are drawn once", () => {
    const g = buildChartGraph(["1002", "1003"], buildSpine(["1002", "1003"]), [link("1002", ["1003"]), link("1003", ["1002"])], {});
    expect(g.edges).toHaveLength(2);
    expect(g.nodes.length).toBe(2);
  });

  it("layout boxes never overlap within a row", () => {
    const many = ["1002", "1003", "1004", "2001", "2002", "2003"];
    const sp = buildSpine(many);
    const g = buildChartGraph(many, sp, [link("1003", ["1004", "2001", "2002", "2003"])], {});
    const row = Object.entries(g.pos).filter(([, p]) => p.y === g.pos["1004"]!.y);
    const xs = row.map(([, p]) => p.x);
    expect(new Set(xs).size).toBe(xs.length);
    for (const x of xs) expect(x).toBeGreaterThanOrEqual(0);
    expect(g.width).toBeGreaterThan(NODE_W);
    expect(g.height).toBeGreaterThan(NODE_H);
  });
});