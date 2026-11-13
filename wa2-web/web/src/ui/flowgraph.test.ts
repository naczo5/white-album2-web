// Flowchart graph builder: pure layout (tsukiweb-style chart), test-pinned.

import { describe, expect, it } from "vitest";
import { buildChartGraph, chartVisited, NODE_H, NODE_W, optionSeen } from "./flowchart";
import { guideEndings, guideOptionSeen } from "./guide";
import { buildSpine } from "../engine/router";
import type { LinkSite, SaveData, SysProfile, TerminalsData } from "../engine/types";

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

  it("roots at 1001 when present (the first script must be on the chart)", () => {
    const scripts = ["1001", "1002", "1003"];
    const sp = buildSpine(scripts);
    const g = buildChartGraph(scripts, sp, [], {});
    expect(g.depth["1001"]).toBe(0);
    expect(g.depth["1002"]).toBe(1);
    expect(g.depth["1003"]).toBe(2);
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

describe("global profile on the chart", () => {
  const save = (over: Partial<SaveData> = {}): SaveData => ({
    version: 1,
    name: "x",
    updatedAt: "2026-11-13T00:00:00.000Z",
    position: { script: "1002", event: 0 },
    flags: { aff: {}, set: {} },
    picks: {},
    visited: ["1002"],
    endings: [],
    log: [],
    ...over,
  });

  const profile = (over: Partial<SysProfile> = {}): SysProfile => ({
    version: 1,
    importedAt: "2026-11-13T00:00:00.000Z",
    readKeys: [],
    visited: [],
    endings: [],
    seenPicks: {},
    cg: [],
    music: [],
    movies: [],
    ero: [],
    gates: {},
    ...over,
  });

  it("unions profile.visited into the lit path without losing the run", () => {
    const lit = chartVisited(save(), profile({ visited: ["2001", "1002"] }));
    expect([...lit].sort()).toEqual(["1002", "2001"]);
    expect(chartVisited(save()).has("2001")).toBe(false);
  });

  it("treats a seen pick as visible while spoilers are off", () => {
    const p = profile({ seenPicks: { "2019-1484": [1, 2, 3] } });
    expect(optionSeen(save(), p, "2019-1484", 2, false)).toBe(true);
    expect(optionSeen(save(), p, "2019-1484", 1, false)).toBe(true);
    expect(optionSeen(save(), null, "2019-1484", 2, false)).toBe(false);
    expect(optionSeen(save(), null, "2019-1484", 2, true)).toBe(true);
  });

  it("keeps the run's own pick as .chosen and profile bits as seen only", () => {
    const s = save({ picks: { "2019-1484": 3 } });
    const p = profile({ seenPicks: { "2019-1484": [1, 2, 3] } });
    expect(s.picks["2019-1484"]).toBe(3);
    expect(optionSeen(s, p, "2019-1484", 1, false)).toBe(true);
    expect(optionSeen(s, p, "2019-1484", 3, false)).toBe(true);
  });
});

describe("global profile in the guide", () => {
  const save = (over: Partial<SaveData> = {}): SaveData => ({
    version: 1,
    name: "x",
    updatedAt: "2026-11-13T00:00:00.000Z",
    position: { script: "1002", event: 0 },
    flags: { aff: {}, set: {} },
    picks: {},
    visited: [],
    endings: [],
    log: [],
    ...over,
  });
  const profile = (over: Partial<SysProfile> = {}): SysProfile => ({
    version: 1,
    importedAt: "2026-11-13T00:00:00.000Z",
    readKeys: [],
    visited: [],
    endings: [],
    seenPicks: {},
    cg: [],
    music: [],
    movies: [],
    ero: [],
    gates: {},
    ...over,
  });

  it("unions profile.endings into the seen ending set", () => {
    const got = guideEndings(save({ endings: ["cc-mari"] }), profile({ endings: ["cc-setsuna"] }));
    expect([...got].sort()).toEqual(["cc-mari", "cc-setsuna"]);
    expect(guideEndings(save()).size).toBe(0);
  });

  it("shows profile-seen options with spoilers off", () => {
    const p = profile({ seenPicks: { "2019-1512": [2] } });
    expect(guideOptionSeen(save(), p, "2019-1512", 2, false)).toBe(true);
    expect(guideOptionSeen(save(), p, "2019-1512", 1, false)).toBe(false);
    expect(guideOptionSeen(save(), null, "2019-1512", 1, true)).toBe(true);
  });
});