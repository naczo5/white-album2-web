// Flowchart graph builder: pure layout (tsukiweb-style chart), test-pinned.

import { describe, expect, it } from "vitest";
import { buildChartGraph, calSceneDate, chartVisited, firstSceneImage, NODE_H, NODE_W, optionSeen, resolveInheritedArt, sceneImageCues, sceneLabel } from "./flowchart";
import { guideEndings, guideOptionSeen } from "./guide";
import { buildSpine } from "../engine/router";
import type { CfgData, FlowData, LinkSite, SaveData, Scenario, ScenarioEvent, SysProfile, TerminalsData } from "../engine/types";

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

describe("scene thumbnails", () => {
  const sc = (events: ScenarioEvent[]): Scenario => ({
    script: "1002", tokens: 0, events, warnings: [],
  });

  it("orders cues by playback position, txt before bnr at one event", () => {
    const scenario = sc([
      { t: "narrate", text: "x" },
      { t: "image", file: "B000002.tga", layer: "bak" },
      { t: "image", file: "B000003.tga", layer: "bak" },
    ]);
    const cues = sceneImageCues(scenario, [
      { ev: 1, layer: "bak", stems: ["000001"], conf: "high" },
    ]);
    expect(cues).toEqual([["B000002.tga"], ["b000001.tga"], ["B000003.tga"]]);
  });

  it("skips clears and low-confidence records; grp stems fall back to v/tv", () => {
    const cues = sceneImageCues(undefined, [
      { ev: 0, layer: "bak", clear: true, conf: "high" },
      { ev: 1, layer: "grp", stems: ["123456"], conf: "hypothesis" },
      { ev: 2, layer: "grp", stems: ["123456"], conf: "high" },
    ]);
    expect(cues).toEqual([["v123456.tga", "tv123456.tga"]]);
  });

  it("resolves the first installed image and passes the chapter namespace", () => {
    const scenario = sc([{ t: "image", file: "B000009.tga", layer: "bak" }]);
    const seen: string[] = [];
    const url = firstSceneImage("1002", scenario, [
      { ev: 3, layer: "bak", stems: ["000001"], conf: "high" },
    ], (file, chapter) => {
      seen.push(`${chapter}:${file}`);
      // First cue is missing from a partial install; the .bnr falls through.
      return file === "b000001.tga" ? "assets/bg/b000001.png" : null;
    });
    expect(url).toBe("assets/bg/b000001.png");
    expect(seen).toEqual(["intro:B000009.tga", "intro:b000001.tga"]);
  });

  it("returns null when nothing resolves", () => {
    expect(firstSceneImage("1010_040", sc([]), [], () => null)).toBeNull();
  });

  it("skips engine transition plates (white/black fades) for real art", () => {
    const scenario = sc([
      { t: "image", file: "B990000.tga", layer: "bak" },
      { t: "image", file: "B101300.tga", layer: "bak" },
    ]);
    const bnr = [{ ev: 1, layer: "bak" as const, stems: ["990000"], conf: "high" as const }];
    expect(firstSceneImage("2003", scenario, bnr, (f) => (f === "B101300.tga" ? "art" : null))).toBe("art");
  });

  it("inherits a parent's frame, cycle-safe (no stale nulls)", () => {
    const own: Record<string, string | null> = { d: "d.png" };
    const parents: Record<string, string[]> = {
      c: ["a"],
      a: ["b", "d"], // b first: the cycle arm is walked before d resolves
      b: ["a"], // cycle a <-> b
      d: [],
    };
    const got = resolveInheritedArt(
      ["c", "a", "b", "d"],
      (id) => parents[id] ?? [],
      (id) => own[id] ?? null,
    );
    // b's only parent is a, which gets art from d AFTER the cycle guard
    // fired inside b — b must not be stuck with the provisional null.
    expect(got.get("b")).toBe("d.png");
    expect(got.get("a")).toBe("d.png");
    expect(got.get("c")).toBe("d.png");
    expect(got.get("d")).toBe("d.png");
    // An artless leaf with no parents stays null (a final null, memoized).
    const lone = resolveInheritedArt(["x"], () => [], () => null);
    expect(lone.get("x")).toBeNull();
  });
});

describe("CFG flowchart graph and sceneLabel", () => {
  it("builds edges from CFG sload/scall + terminals and omits spine.next edges", () => {
    const scripts = ["1001", "1002", "1003", "1004"];
    const spine = buildSpine(scripts);
    const cfg: CfgData = {
      version: 1,
      vars: [],
      scripts: {
        "1001": {
          "0": [
            {
              t: "if",
              branches: [
                { cond: 1, ops: [{ t: "sload", script: "1002", entry: 0 }] },
                { cond: null, ops: [{ t: "scall", script: "1003", entry: 10 }] },
              ],
            },
          ],
        },
        "1002": { "0": [{ t: "gotitle" }] },
        "1003": { "10": [{ t: "ret" }] },
        "1004": { "0": [{ t: "gotitle" }] },
      },
    };
    // 1004 is in spine.next["1003"] but unreachable via CFG/terminals!
    const g = buildChartGraph(scripts, spine, [], {}, cfg);
    expect(g.nodes.map((n) => n.id)).toEqual(["1001", "1002", "1003"]);
    expect(g.edges).toEqual([
      { from: "1001", to: "1002", kind: "link" },
      { from: "1001", to: "1003", kind: "chain" },
    ]);
  });

  it("renders player-friendly sceneLabel vs dev script IDs", () => {
    const flow: FlowData = {
      version: 1,
      nodes: [
        {
          id: "2019-1",
          engine: { script: "2019", event: 1 },
          options: [],
          date: "12/24 ROUTER",
          effects: {},
          gated: {},
          walkthrough: null,
          status: "EXPERT_SOURCED",
        },
      ],
    };
    expect(sceneLabel("2019", flow, { dev: true, visited: false })).toBe("2019");
    expect(sceneLabel("2019", flow, { dev: false, visited: false, spoiler: false })).toBe("Closing · ???");
    expect(sceneLabel("2019", flow, { dev: false, visited: true })).toBe("Closing · 12/24");
    expect(sceneLabel("2019", flow, { dev: false, visited: false, spoiler: true })).toBe("Closing · 12/24");
    expect(sceneLabel("1001", flow, { dev: false, visited: true })).toBe("Introductory");
    expect(sceneLabel("demo-1", flow, { dev: false, visited: true })).toBe("Demo");
  });

  it("falls back to the first .bnr calendar stamp when flow has no date", () => {
    const flow: FlowData = { version: 1, nodes: [] };
    const bnr = [
      { ev: 62, cal: { year: 2010, month: 11, day: 26, dow: 5 }, conf: "high" as const },
      { ev: 438, cal: { year: 2010, month: 11, day: 27, dow: 6 }, conf: "high" as const },
      { ev: 1, cal: { year: 2010, month: 11, day: 25, dow: 4 }, conf: "hypothesis" as const },
    ];
    expect(calSceneDate(bnr)).toBe("11/26");
    expect(calSceneDate([])).toBeNull();
    expect(sceneLabel("2002", flow, { visited: true, bnr })).toBe("Closing · 11/26");
    // A curated flow date (with its range/uncertainty formatting) wins.
    const dated: FlowData = {
      version: 1,
      nodes: [{
        id: "x", engine: { script: "2019", event: 1 }, options: [],
        date: "12/24 ROUTER", effects: {}, gated: {}, walkthrough: null,
        status: "EXPERT_SOURCED",
      }],
    };
    const xmas = [{ ev: 1, cal: { year: 2010, month: 12, day: 25, dow: 6 }, conf: "high" as const }];
    expect(sceneLabel("2019", dated, { visited: true, bnr: xmas })).toBe("Closing · 12/24");
    // Spoiler-off still hides the date behind the chapter placeholder.
    expect(sceneLabel("2002", flow, { visited: false, bnr })).toBe("Closing · ???");
    expect(sceneLabel("2002", flow, { visited: false, spoiler: true, bnr })).toBe("Closing · 11/26");
  });
});
