import { describe, expect, it } from "vitest";
import { Router, buildSpine, chapterOfScript, isExtraScenario, resolveTerminalChain } from "./router";
import type { Flags, FlowData, Scenario, TerminalRecord, TerminalsData } from "./types";

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

  it("labels the 5000-5104 digital novels special, not coda", () => {
    expect(chapterOfScript("3999")).toBe("coda");
    expect(chapterOfScript("5000")).toBe("special");
    expect(chapterOfScript("5004")).toBe("special");
    expect(chapterOfScript("5104")).toBe("special");
    expect(chapterOfScript("5300")).toBe("special");
  });

  it("lists every special-contents extra scenario incl. 5300-5303", () => {
    for (const id of ["4000", "4009", "5200", "5209", "5300", "5301", "5303", "5400", "5401", "6001", "6104", "7300"])
      expect(isExtraScenario(id), id).toBe(true);
    // novels (PDF links) and story chapters stay out
    for (const id of ["5000", "5004", "5100", "5104", "1001", "2501", "3901"])
      expect(isExtraScenario(id), id).toBe(false);
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

describe("router without cfg: curated flow goto wins over engine-event goto", () => {
  // The parsed IR historically attached goto to the wrong option (off by one).
  // flow.json is the curated source: option n -> L[0]==n -> SLoad in bytecode.
  const flowNode: FlowData = {
    version: 1,
    nodes: [
      {
        id: "2019-1", engine: { script: "2019", event: 1 },
        options: [
          { n: 1, text: "Call Chiaki", goto: "2401" },
          { n: 2, text: "Stop by", goto: "2501" },
          { n: 3, text: "No right", goto: null },
        ],
        date: "12/24 ROUTER", effects: {}, gated: {}, walkthrough: null,
        status: "EXPERT_SOURCED",
      },
    ],
  };
  // Engine event deliberately disagrees (shifted by one, like the old IR).
  const shifted = [
    { n: 1, text: "Call Chiaki", goto: null },
    { n: 2, text: "Stop by", goto: "2401" },
    { n: 3, text: "No right", goto: "2501" },
  ];
  const r = new Router(
    [
      scen("2019", [
        { t: "narrate", text: "Eve." },
        { t: "choice", options: shifted },
        { t: "narrate", text: "Morning." },
      ]),
      scen("2401", [{ t: "narrate", text: "Chiaki line." }]),
      scen("2501", [{ t: "narrate", text: "Mari line." }]),
    ],
    flowNode,
    { version: 1, links: [] },
    { version: 1, terminals: {} },
  );
  const at = { script: "2019", event: 1 };

  it("option 1 jumps to the flow goto even when the event has none", () => {
    expect(r.pick(at, 1, { aff: {}, set: {} }).next).toEqual({ script: "2401", event: 0 });
  });
  it("option 2 follows the flow goto, not the shifted event goto", () => {
    expect(r.pick(at, 2, { aff: {}, set: {} }).next).toEqual({ script: "2501", event: 0 });
  });
  it("option 3 falls through despite the shifted event goto", () => {
    expect(r.pick(at, 3, { aff: {}, set: {} }).next).toEqual({ script: "2019", event: 2 });
  });
});

describe("cfg-less spine: split chunk files chain in order", () => {
  it("links chunks and hands the chain tail to the next chapter file", () => {
    const spine = buildSpine(["1008", "1008_020", "1008_030", "1009", "3014", "3014_2", "3015"]);
    expect(spine.next["1008"]).toBe("1008_020");
    expect(spine.next["1008_020"]).toBe("1008_030");
    expect(spine.next["1008_030"]).toBe("1009");
    // SCall-only subroutine entries follow their base instead of chaining
    expect(spine.next["3014_2"]).toBe(spine.next["3014"] ?? null);
  });

  it("walks a split chunk chain end to end without cfg", () => {
    const r = new Router(
      [
        scen("1008", [{ t: "narrate", text: "a" }]),
        scen("1008_020", [{ t: "narrate", text: "b" }]),
        scen("1009", [{ t: "narrate", text: "c" }]),
      ],
      { version: 1, nodes: [] },
      { version: 1, links: [] },
      { version: 1, terminals: {} },
    );
    const flags: Flags = { aff: {}, set: {} };
    expect(r.advance({ script: "1008", event: 1 }, flags).pos).toEqual({ script: "1008_020", event: 0 });
    expect(r.advance({ script: "1008_020", event: 1 }, flags).pos).toEqual({ script: "1009", event: 0 });
  });
});

describe("conditional chain terminals (3023 shape)", () => {
  const terminals: TerminalsData = {
    version: 1,
    terminals: {
      "3023": { action: "chain", to: "3101", branches: [{ g: 27, eq: 1, to: "3201" }] },
    },
  };
  const mk = () =>
    new Router(
      [
        scen("3023", [{ t: "narrate", text: "proposal" }]),
        scen("3101", [{ t: "narrate", text: "kazusa tail" }]),
        scen("3201", [{ t: "narrate", text: "setsuna tail" }]),
      ],
      { version: 1, nodes: [] },
      { version: 1, links: [] },
      terminals,
    );

  it("takes the branch when G[27] == 1 (no cfg)", () => {
    const flags: Flags = { aff: {}, set: {}, g: [] };
    flags.g![27] = 1;
    expect(mk().advance({ script: "3023", event: 1 }, flags).pos).toEqual({ script: "3201", event: 0 });
  });

  it("falls back to `to` when G[27] is 0 or absent", () => {
    expect(mk().advance({ script: "3023", event: 1 }, { aff: {}, set: {} }).pos)
      .toEqual({ script: "3101", event: 0 });
    const flags: Flags = { aff: {}, set: {}, g: [] };
    expect(mk().advance({ script: "3023", event: 1 }, flags).pos).toEqual({ script: "3101", event: 0 });
  });

  it("resolves gflag conditions and the unconditional fallback", () => {
    const branched: TerminalRecord = { action: "chain", to: "3101", branches: [{ gflag: 2, eq: 1, to: "3201" }] };
    expect(resolveTerminalChain(branched, { aff: {}, set: {}, gflags: { "2": 1 } })).toBe("3201");
    expect(resolveTerminalChain(branched, { aff: {}, set: {} })).toBe("3101");
    expect(resolveTerminalChain({ action: "end", ending: null }, { aff: {}, set: {} })).toBeNull();
  });
});
