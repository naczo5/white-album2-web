// Full-game playthrough on REAL built data (BYOA-gated).
// Exercises the shipped TS Router (not the Python mirror) across the
// whole scenario set: advance/pick/spine/terminals/endings.
//   WA2_DATA_DIR=/path/to/build/data npx vitest run playthrough
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { Router } from "./router";
import type { FlowData, LinksData, Scenario, TerminalsData } from "./types";

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
  return { scenarios, flow, links, terminals };
}

describe.runIf(DATA)("real-data playthrough (shipped Router)", () => {
  it("walks every strategy without throwing or stalling", () => {
    const { scenarios, flow, links, terminals } = load();
    expect(scenarios.length).toBeGreaterThan(200);
    const taken = new Map<string, Set<string>>();
    const pick = (script: string, ev: number, opts: { n: number; goto: string | null }[]) => {
      const key = `${script}:${ev}`;
      const node = r.flow.get(key);
      const got = taken.get(key) ?? new Set<string>();
      for (const o of opts) {
        const dest = node?.options.find((x) => x.n === o.n)?.play ?? o.goto;
        if (dest && !dest.startsWith("END:") && !got.has(dest)) {
          got.add(dest);
          taken.set(key, got);
          return o.n;
        }
      }
      return 1;
    };
    const starts = ["1001", "2019", "2019", "2019", "3001", "3016", "3016", "4000", "5201", "6001"];
    const visited = new Set<string>();
    const ends = new Set<string>();
    const r = new Router(scenarios, flow, links, terminals);
    for (const start of starts) {
      let pos = { script: start, event: 0 };
      const flags = { aff: {}, set: {} };
      for (let step = 0; step < 200000; step++) {
        const sc = r.scripts.get(pos.script);
        if (!sc) throw new Error(`missing script ${pos.script}`);
        visited.add(pos.script);
        const ev = r.at(pos);
        if (!ev) {
          const res = r.advance(pos, flags);
          if (res.ended) {
            ends.add(pos.script);
            break;
          }
          pos = res.pos;
          continue;
        }
        if (ev.t === "choice") {
          const n = pick(pos.script, pos.event, ev.options);
          const res = r.pick(pos, n, flags);
          if (res.ending) ends.add(`END:${res.ending}`);
          pos = res.next;
          continue;
        }
        pos = r.advance(pos, flags).pos;
      }
    }
    console.log(`visited ${visited.size}/${scenarios.length}, ends: ${[...ends].join(",")}`);
    expect(visited.size).toBeGreaterThan(150);
    expect([...ends]).toContain("2322");
  });
});
