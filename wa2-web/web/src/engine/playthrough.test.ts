// Full-game playthrough on REAL built data (BYOA-gated).
// Exercises the shipped TS Router (with compiled CFG VM) across the
// whole scenario set: all 11 endings, IC replay variants, special scripts,
// and intra-script branch executedRanges filtering.
//   WA2_DATA_DIR=/path/to/build/data npx vitest run playthrough
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { isEventInExecutedRanges } from "./cfg-vm";
import { Router } from "./router";
import type { CfgData, Flags, FlowData, LinksData, Scenario, SysSlotsTable, TerminalsData } from "./types";

const DATA = process.env.WA2_DATA_DIR;

function load() {
  const dir = DATA!;
  const index = JSON.parse(fs.readFileSync(path.join(dir, "scripts", "index.json"), "utf8")) as string[];
  const scenarios = index.map((id) =>
    JSON.parse(fs.readFileSync(path.join(dir, "scripts", `${id}.json`), "utf8")) as Scenario);
  const flow = JSON.parse(fs.readFileSync(path.join(dir, "flow.json"), "utf8")) as FlowData;
  const links = JSON.parse(fs.readFileSync(path.join(dir, "links.json"), "utf8")) as LinksData;
  const terminals = JSON.parse(
    fs.readFileSync(path.join(dir, "terminals.json"), "utf8")) as TerminalsData;
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "cfg.json"), "utf8")) as CfgData;
  const sysSlots = JSON.parse(fs.readFileSync(path.join(dir, "sys-slots.json"), "utf8")) as SysSlotsTable;
  return { scenarios, flow, links, terminals, cfg, sysSlots };
}

function runRouter(
  r: Router,
  start: string,
  profileGameFlags: Record<string, number>,
  picks: Record<string, number>,
) {
  r.setProfileGameFlags(profileGameFlags);
  const flags: Flags = { aff: {}, set: {} };
  let pos = r.seek({ script: start, event: 0 }, flags);
  const visited = new Set<string>([pos.script]);
  const endings = new Set<string>();
  const seenRanges: Record<string, [number, number][]> = {};
  let ended = false;
  let lastScript = pos.script;

  for (let step = 0; step < 300000; step++) {
    const sc = r.scripts.get(pos.script);
    if (!sc) throw new Error(`missing script ${pos.script}`);
    visited.add(pos.script);
    if (flags.cfg?.executedRanges && flags.cfg.script === pos.script) {
      seenRanges[pos.script] = flags.cfg.executedRanges.map((x) => [x[0], x[1]]);
    }
    const ev = r.at(pos);
    if (ev?.t === "choice") {
      const key = `${pos.script}:${pos.event}`;
      const opts = r.choiceOptions(pos, flags);
      const n = picks[key] ?? opts.find((o) => o.unlocked)?.n ?? 1;
      const chosen = opts.find((o) => o.n === n);
      expect(chosen?.unlocked, `${key} opt ${n} locked`).toBe(true);
      const res = r.pick(pos, n, flags);
      for (const e of res.unlockedEndings ?? []) endings.add(e);
      if (res.ending) endings.add(res.ending);
      if (res.ended) {
        ended = true;
        break;
      }
      pos = res.next;
      lastScript = pos.script;
      continue;
    }
    const res = r.advance(pos, flags);
    for (const e of res.unlockedEndings ?? []) endings.add(e);
    if (res.ending) endings.add(res.ending);
    if (res.ended) {
      ended = true;
      break;
    }
    pos = res.pos;
    lastScript = pos.script;
  }

  return { visited, endings, flags, ended, lastScript, seenRanges };
}

const BASE_NEUTRAL_CC: Record<string, number> = {
  "2003:242": 2,
  "2003:982": 2,
  "2004:66": 1,
  "2005:389": 2,
  "2007:231": 2,
  "2009:1618": 2,
  "2011:182": 1,
  "2013:198": 1,
  "2014:271": 2,
  "2015:351": 2,
  "2016:467": 1,
  "2017:239": 1,
  "2018:548": 1,
  "2019:1484": 3,
  "2019:1512": 2,
};

describe.runIf(DATA)("real-data playthrough (shipped CFG Router)", () => {
  it("reaches all 11 endings + special scenarios and visits > 150 scripts", () => {
    const { scenarios, flow, links, terminals, cfg, sysSlots } = load();
    expect(scenarios.length).toBeGreaterThan(200);
    const r = new Router(scenarios, flow, links, terminals, {
      cfg,
      endingSlots: sysSlots.endingSlots,
    });

    const routes: {
      ending: string;
      start: string;
      gflags: Record<string, number>;
      picks: Record<string, number>;
      lastScript: string;
    }[] = [
      { ending: "ic-end", start: "1001", gflags: {}, picks: {}, lastScript: "1013" },
      { ending: "cc-normal1", start: "2001", gflags: { "0": 1 }, picks: { ...BASE_NEUTRAL_CC }, lastScript: "2025" },
      {
        ending: "cc-setsuna",
        start: "2001",
        gflags: { "0": 1 },
        picks: {
          ...BASE_NEUTRAL_CC,
          "2003:982": 1,
          "2004:66": 2,
          "2005:389": 1,
          "2015:351": 1,
          "2024:84": 2,
          "3003:1006": 1,
          "3005:186": 1,
          "3009:1347": 1,
          "3012:605": 1,
          "3012:950": 2,
          "3013:747": 1,
          "3013:1843": 1,
          "3014:376": 1,
          "3016:822": 2,
          "3016:859": 1,
        },
        lastScript: "3024",
      },
      {
        ending: "cc-koharu",
        start: "2001",
        gflags: { "0": 1 },
        picks: {
          ...BASE_NEUTRAL_CC,
          "2005:389": 1,
          "2009:1618": 1,
          "2018:548": 2,
          "2019:1484": 3,
          "2019:1512": 1,
        },
        lastScript: "2322",
      },
      {
        ending: "cc-chiaki-normal",
        start: "2001",
        gflags: { "0": 1 },
        picks: {
          ...BASE_NEUTRAL_CC,
          "2003:242": 2,
          "2007:231": 1,
          "2014:271": 1,
          "2016:467": 2,
          "2019:1484": 1,
        },
        lastScript: "2413",
      },
      {
        ending: "cc-chiaki-true",
        start: "2001",
        gflags: { "0": 1, "1": 1 },
        picks: {
          ...BASE_NEUTRAL_CC,
          "2003:242": 1,
          "2007:231": 1,
          "2014:271": 1,
          "2016:467": 2,
          "2019:1484": 1,
        },
        lastScript: "2412",
      },
      {
        ending: "cc-mari",
        start: "2001",
        gflags: { "0": 1 },
        picks: {
          ...BASE_NEUTRAL_CC,
          "2004:66": 2,
          "2011:182": 2,
          "2013:198": 2,
          "2017:239": 2,
          "2019:1484": 2,
          "2503:126": 2,
        },
        lastScript: "2517",
      },
      {
        ending: "coda-normal",
        start: "3001",
        gflags: { "0": 1, "3": 1, "21": 1 },
        picks: {
          "3003:1006": 1,
          "3005:186": 1,
          "3009:1347": 1,
          "3012:605": 1,
          "3012:950": 2,
          "3013:747": 1,
          "3013:1843": 1,
          "3014:376": 1,
          "3016:822": 2,
          "3016:859": 1,
        },
        lastScript: "3024",
      },
      {
        ending: "coda-kazusa-true",
        start: "3001",
        gflags: { "0": 1, "3": 1, "21": 1 },
        picks: {
          "3003:1006": 2,
          "3005:186": 2,
          "3005:256": 1,
          "3005:265": 2,
          "3009:1347": 2,
          "3009:1474": 1,
          "3012:605": 2,
          "3012:950": 1,
          "3013:747": 2,
          "3013:801": 1,
          "3013:1843": 2,
          "3014:376": 1,
          "3016:822": 2,
          "3016:859": 2,
        },
        lastScript: "3111",
      },
      {
        ending: "coda-cheating",
        start: "3001",
        gflags: { "0": 1, "3": 1, "21": 1 },
        picks: {
          "3003:1006": 2,
          "3005:186": 2,
          "3005:256": 1,
          "3005:265": 2,
          "3009:1347": 2,
          "3009:1474": 1,
          "3012:605": 2,
          "3012:950": 1,
          "3013:747": 2,
          "3013:801": 1,
          "3013:1843": 2,
          "3014:376": 1,
          "3016:822": 1,
          "3904:386": 1,
        },
        lastScript: "3909",
      },
      {
        ending: "coda-setsuna-true",
        start: "3001",
        gflags: { "0": 1, "3": 1, "21": 1 },
        picks: {
          "3003:1006": 1,
          "3005:186": 2,
          "3005:256": 2,
          "3009:1347": 1,
          "3012:605": 1,
          "3012:950": 2,
          "3013:747": 1,
          "3013:1843": 1,
          "3014:376": 2,
          "3016:822": 2,
          "3016:859": 1,
        },
        lastScript: "3211",
      },
    ];

    const allVisited = new Set<string>();
    const allEndings = new Set<string>();
    for (const rt of routes) {
      const res = runRouter(r, rt.start, rt.gflags, rt.picks);
      expect(res.ended, rt.ending).toBe(true);
      expect(res.endings.has(rt.ending), `${rt.ending} not unlocked`).toBe(true);
      if (rt.ending === "ic-end") {
        // Finishing IC sets GFlag[0]=1 and continues directly into Closing Chapter (2001..2322).
        expect(res.visited.has("1013")).toBe(true);
      } else {
        expect(res.lastScript, rt.ending).toBe(rt.lastScript);
      }
      for (const s of res.visited) allVisited.add(s);
      for (const e of res.endings) allEndings.add(e);
    }

    for (const sp of ["4000", "5200", "6001"]) {
      const res = runRouter(r, sp, {}, {});
      expect(res.ended, sp).toBe(true);
      for (const s of res.visited) allVisited.add(s);
    }

    expect(allEndings.size).toBe(11);
    expect(allVisited.size).toBeGreaterThan(150);
  });

  it("switches IC replay variants on GFlag[1] and excludes skipped branches in 2402/3016", () => {
    const { scenarios, flow, links, terminals, cfg, sysSlots } = load();
    const r = new Router(scenarios, flow, links, terminals, {
      cfg,
      endingSlots: sysSlots.endingSlots,
    });

    const icFirst = runRouter(r, "1001", {}, {});
    expect(icFirst.visited.has("1008_020")).toBe(false);
    expect(icFirst.visited.has("1012_020")).toBe(false);
    expect(icFirst.seenRanges["1012_020"]).toBeUndefined();

    const icReplay = runRouter(r, "1001", { "0": 1, "1": 1 }, {});
    for (const rep of ["1008_020", "1008_030", "1009_030", "1010_030", "1011_030", "1012_030"]) {
      expect(icReplay.visited.has(rep), `missed ${rep}`).toBe(true);
    }
    expect(icReplay.seenRanges["1012_020"]).toEqual([[0, 92]]);

    // 2402: Chiaki True (2003:242=1) vs Chiaki Normal (2003:242=2) execute different ranges inside 2402
    const chiakiTrue = runRouter(
      r,
      "2001",
      { "0": 1, "1": 1 },
      { ...BASE_NEUTRAL_CC, "2003:242": 1, "2007:231": 1, "2014:271": 1, "2016:467": 2, "2019:1484": 1 },
    );
    const chiakiNormal = runRouter(
      r,
      "2001",
      { "0": 1 },
      { ...BASE_NEUTRAL_CC, "2003:242": 2, "2007:231": 1, "2014:271": 1, "2016:467": 2, "2019:1484": 1 },
    );
    const rTrue2402 = chiakiTrue.seenRanges["2402"]!;
    const rNorm2402 = chiakiNormal.seenRanges["2402"]!;
    expect(rTrue2402.length).toBeGreaterThan(0);
    expect(rNorm2402.length).toBeGreaterThan(0);
    expect(rTrue2402).not.toEqual(rNorm2402);

    // Every event executed exclusively in Chiaki Normal is excluded by Chiaki True's executedRanges
    const trueLastEv = Math.max(...rTrue2402.map(([, b]) => b));
    const normOnlyEv = Array.from({ length: trueLastEv }, (_, k) => k).find(
      (k) => isEventInExecutedRanges(rNorm2402, k) && !isEventInExecutedRanges(rTrue2402, k),
    );
    expect(normOnlyEv).toBeDefined();

    // 3016: Cheating (3016:822=1) vs Kazusa True (3016:822=2, 3016:859=2) execute different ranges inside 3016
    const cheating = runRouter(
      r,
      "3001",
      { "0": 1, "3": 1, "21": 1 },
      {
        "3003:1006": 2, "3005:186": 2, "3005:256": 1, "3005:265": 2,
        "3009:1347": 2, "3009:1474": 1, "3012:605": 2, "3012:950": 1,
        "3013:747": 2, "3013:801": 1, "3013:1843": 2, "3014:376": 1,
        "3016:822": 1, "3904:386": 1,
      },
    );
    const kazusaTrue = runRouter(
      r,
      "3001",
      { "0": 1, "3": 1, "21": 1 },
      {
        "3003:1006": 2, "3005:186": 2, "3005:256": 1, "3005:265": 2,
        "3009:1347": 2, "3009:1474": 1, "3012:605": 2, "3012:950": 1,
        "3013:747": 2, "3013:801": 1, "3013:1843": 2, "3014:376": 1,
        "3016:822": 2, "3016:859": 2,
      },
    );
    expect(cheating.seenRanges["3016"]).not.toEqual(kazusaTrue.seenRanges["3016"]);
    expect(isEventInExecutedRanges(cheating.seenRanges["3016"], 902)).toBe(false);
    expect(isEventInExecutedRanges(kazusaTrue.seenRanges["3016"], 860)).toBe(false);
    expect(isEventInExecutedRanges(kazusaTrue.seenRanges["3016"], 902)).toBe(true);
  });
});
