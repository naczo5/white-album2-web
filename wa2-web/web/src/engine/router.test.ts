import { describe, expect, it } from "vitest";
import { Router, buildSpine, chapterOfScript } from "./router";
import type { FlowData, Scenario } from "./types";

function scen(script: string, events: Scenario["events"]): Scenario {
  return { script, tokens: events.length, events, warnings: [] };
}

const FLOW: FlowData = {
  version: 1,
  nodes: [
    {
      id: "2019-1", engine: { script: "2019", event: 1 },
      options: [
        { n: 1, text: "Call Chiaki", goto: null },
        { n: 2, text: "Stop by", goto: "2401" },
        { n: 3, text: "No right", goto: "2501" },
      ],
      date: "12/24 ROUTER", effects: {}, gated: {}, walkthrough: "cc-c14",
      status: "EXPERT_SOURCED",
    },
  ],
};

describe("spine", () => {
  it("orders numerically and stops at chapter ends", () => {
    const spine = buildSpine(["1002", "1001", "2001"]);
    expect(spine.next["1001"]).toBe("1002");
    expect(spine.next["1002"]).toBeNull(); // chapter boundary
    expect(spine.next["2001"]).toBeNull();
  });

  it("classifies chapters", () => {
    expect(chapterOfScript("1001")).toBe("intro");
    expect(chapterOfScript("2501")).toBe("closing");
    expect(chapterOfScript("3901_2")).toBe("coda");
    expect(chapterOfScript("7300")).toBe("special");
  });
});

describe("router", () => {
  const scenarios = [
    scen("2019", [
      { t: "narrate", text: "Eve." },
      { t: "choice", options: FLOW.nodes[0].options },
      { t: "narrate", text: "Morning." },
    ]),
    scen("2401", [{ t: "narrate", text: "Editing dept." }]),
    scen("2501", [{ t: "narrate", text: "Common line." }]),
  ];
  const r = new Router(scenarios, FLOW, { version: 1, links: [] }, { version: 1, terminals: {} });
  const flags = { aff: {}, set: {} };

  it("blocks advance on choices", () => {
    expect(r.advance({ script: "2019", event: 1 }, flags).pos).toEqual({
      script: "2019", event: 1,
    });
  });

  it("routes option 2 to its file, option 1 falls through", () => {
    const two = r.pick({ script: "2019", event: 1 }, 2, { aff: {}, set: {} });
    expect(two.next).toEqual({ script: "2401", event: 0 });
    const one = r.pick({ script: "2019", event: 1 }, 1, { aff: {}, set: {} });
    expect(one.next).toEqual({ script: "2019", event: 2 });
  });

  it("reaches chapter end at the last script", () => {
    const res = r.advance({ script: "2501", event: 5 }, flags);
    expect(res.ended).toBe(true);
  });

  it("follows the spine between scripts", () => {
    const res = r.advance({ script: "2401", event: 5 }, flags);
    expect(res.ended).toBe(false);
    expect(res.pos.script).toBe("2501");
  });

  it("rejects unknown options", () => {
    expect(() => r.pick({ script: "2019", event: 1 }, 9, flags)).toThrow();
  });

  it("treats bare ids and CATCH as sync (flow-neutral)", () => {
    const r2 = new Router(
      [scen("2015", [
        { t: "image", file: "b.tga", layer: "bak" },
        { t: "jump", kind: "bare", targets: ["2016"] },
        { t: "narrate", text: "continues" },
      ])],
      { version: 1, nodes: [] },
      { version: 1, links: [] },
      { version: 1, terminals: {} },
    );
    const res = r2.advance({ script: "2015", event: 1 }, flags);
    expect(res).toEqual({ pos: { script: "2015", event: 2 }, ended: false });
  });

  it("ends at terminals and chains bridges", () => {
    const r3 = new Router(
      [scen("2322", [{ t: "narrate", text: "end" }]),
       scen("2033", [{ t: "narrate", text: "proposal" }]),
       scen("3001", [{ t: "narrate", text: "coda" }])],
      { version: 1, nodes: [] },
      { version: 1, links: [] },
      { version: 1, terminals: {
        "2322": { action: "end", ending: null },
        "2033": { action: "chain", to: "3001" },
      } },
    );
    expect(r3.advance({ script: "2322", event: 9 }, flags).ended).toBe(true);
    expect(r3.advance({ script: "2033", event: 9 }, flags).pos).toEqual({
      script: "3001", event: 0,
    });
  });
});
