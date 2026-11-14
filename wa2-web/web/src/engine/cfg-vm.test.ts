import { describe, expect, it } from "vitest";
import {
  applyAssign,
  choiceOptionsAt,
  evalExpr,
  getGameFlag,
  isEventInExecutedRanges,
  pickCfg,
  seekCfg,
  setGameFlag,
  stepCfg,
  syncAffFromG,
  syncGFromAff,
} from "./cfg-vm";
import { Router } from "./router";
import type { CfgData, Flags, FlowData, Scenario } from "./types";

function scen(script: string, events: Scenario["events"]): Scenario {
  return { script, tokens: events.length, events, warnings: [] };
}

describe("CFG VM primitives", () => {
  it("evaluates arithmetic, logical, G/L/gflag/replay expressions", () => {
    const ctx = {
      g: [0, 0, 0, 0, 0, 10, 2, 7],
      l: [4, 9, 0],
      gflags: { "1": 1, "21": 1 },
      profileGameFlags: { "0": 1, "5": 1 },
      replay: 1,
    };
    expect(evalExpr(42, ctx)).toBe(42);
    expect(evalExpr({ t: "G", idx: 5 }, ctx)).toBe(10);
    expect(evalExpr({ t: "L", idx: 1 }, ctx)).toBe(9);
    expect(evalExpr({ t: "L", idx: 0, off: { t: "un", op: "-", x: 0 } }, ctx)).toBe(4);
    expect(evalExpr({ t: "gflag", id: 0 }, ctx)).toBe(1);
    expect(evalExpr({ t: "gflag", id: 99 }, ctx)).toBe(0);
    expect(evalExpr({ t: "replay" }, ctx)).toBe(1);
    expect(evalExpr({ t: "un", op: "!", x: 0 }, ctx)).toBe(1);
    expect(evalExpr({ t: "bin", op: "&&", l: { t: "G", idx: 5 }, r: { t: "bin", op: ">", l: { t: "G", idx: 7 }, r: 5 } }, ctx)).toBe(1);
    expect(evalExpr({ t: "bin", op: "||", l: 0, r: { t: "gflag", id: 1 } }, ctx)).toBe(1);
    expect(evalExpr({ t: "bin", op: "/", l: 7, r: 2 }, ctx)).toBe(3);
    expect(evalExpr({ t: "bin", op: "/", l: 7, r: 0 }, ctx)).toBe(0);
  });

  it("applies assignment operators faithfully", () => {
    expect(applyAssign(10, "=", 3)).toBe(3);
    expect(applyAssign(10, "+=", 3)).toBe(13);
    expect(applyAssign(10, "-=", 3)).toBe(7);
    expect(applyAssign(10, "*=", 3)).toBe(30);
    expect(applyAssign(10, "/=", 3)).toBe(3);
    expect(applyAssign(10, "/=", 0)).toBe(0);
    expect(applyAssign(10, "%=", 3)).toBe(1);
    expect(applyAssign(6, "&=", 3)).toBe(2);
    expect(applyAssign(4, "|=", 1)).toBe(5);
  });

  it("enforces GetGameFlag(99) === 0 and overlays save gflags over profileGameFlags", () => {
    const flags: Flags = { aff: {}, set: {} };
    setGameFlag(99, 1, flags);
    expect(getGameFlag(99, flags.gflags, { "99": 1 })).toBe(0);
    setGameFlag(1, 1, flags);
    expect(getGameFlag(1, flags.gflags, { "1": 0 })).toBe(1);
    expect(getGameFlag(5, flags.gflags, { "5": 1 })).toBe(1);
  });

  it("syncs G[5..10] <-> flags.aff", () => {
    const flags: Flags = { aff: { s: 4 }, set: {} };
    syncGFromAff(flags);
    expect(flags.g?.[7]).toBe(4);
    flags.g![5] = 8;
    syncAffFromG(flags);
    expect(flags.aff.k).toBe(8);
    expect(flags.aff.s).toBe(4);
  });

  it("checks executedRanges accurately", () => {
    expect(isEventInExecutedRanges(undefined, 5)).toBe(true);
    expect(isEventInExecutedRanges([[0, 3], [8, 12]], 2)).toBe(true);
    expect(isEventInExecutedRanges([[0, 3], [8, 12]], 5)).toBe(false);
    expect(isEventInExecutedRanges([[0, 3], [8, 12]], 9)).toBe(true);
  });
});

describe("CFG VM execution, choices, SCall/ret and Router integration", () => {
  const cfg: CfgData = {
    version: 1,
    vars: [
      { idx: 0, name: "FLG_00", init: 0 },
      { idx: 7, name: "FLG_雪菜好意度", init: 0 },
      { idx: 14, name: "FLG_choice", init: 0 },
    ],
    scripts: {
      "2001": {
        "0": [
          { t: "setG", idx: 7, op: "=", val: 1 },
          { t: "play", from: 0, to: 1 },
          {
            t: "choice",
            ev: 1,
            nodeIdx: 0,
            into: { t: "L", idx: 0 },
            options: [
              { n: 1, flagId: 99, cmp: 0, showWhenLocked: true },
              { n: 2, flagId: 1, cmp: 1, showWhenLocked: true },
              { n: 3, flagId: 2, cmp: 1, showWhenLocked: false },
            ],
          },
          { t: "setG", idx: 14, op: "=", val: { t: "L", idx: 0 } },
          {
            t: "if",
            branches: [
              {
                cond: { t: "bin", op: "==", l: { t: "L", idx: 0 }, r: 1 },
                ops: [
                  { t: "setG", idx: 7, op: "+=", val: 2 },
                  { t: "play", from: 2, to: 3 },
                ],
              },
              {
                cond: { t: "bin", op: "==", l: { t: "L", idx: 0 }, r: 2 },
                ops: [
                  { t: "play", from: 3, to: 4 },
                  { t: "scall", script: "2001_sub", entry: 10 },
                  { t: "setGFlag", id: 21, val: 1 },
                ],
              },
              {
                cond: null,
                ops: [{ t: "gotitle" }],
              },
            ],
          },
          { t: "sload", script: "2002", entry: 0 },
        ],
      },
      "2001_sub": {
        "10": [
          { t: "play", from: 0, to: 1 },
          { t: "ret" },
        ],
      },
      "2002": {
        "0": [
          { t: "play", from: 0, to: 1 },
          { t: "gotitle" },
        ],
      },
    },
  };

  const scenarios: Scenario[] = [
    scen("2001", [
      { t: "narrate", text: "Intro" },
      {
        t: "choice",
        options: [
          { n: 1, text: "Normal", goto: null },
          { n: 2, text: "Chiaki True", goto: null },
          { n: 3, text: "Hidden", goto: null },
        ],
      },
      { t: "narrate", text: "Branch 1" },
      { t: "narrate", text: "Branch 2" },
    ]),
    scen("2001_sub", [{ t: "narrate", text: "Subroutine line" }]),
    scen("2002", [{ t: "narrate", text: "Ending script" }]),
  ];
  const flow: FlowData = { version: 1, nodes: [] };

  it("gates locked & hidden choice options and supports unlockAll override", () => {
    const flags: Flags = { aff: {}, set: {} };
    seekCfg(cfg, { script: "2001", event: 1 }, flags);

    expect(choiceOptionsAt(cfg, { script: "2001", event: 1 }, flags)).toEqual([
      { n: 1, unlocked: true, visible: true, rawUnlocked: true },
      { n: 2, unlocked: false, visible: true, rawUnlocked: false },
      { n: 3, unlocked: false, visible: false, rawUnlocked: false },
    ]);

    expect(choiceOptionsAt(cfg, { script: "2001", event: 1 }, flags, { unlockAll: true })).toEqual([
      { n: 1, unlocked: true, visible: true, rawUnlocked: true },
      { n: 2, unlocked: true, visible: true, rawUnlocked: false },
      { n: 3, unlocked: true, visible: true, rawUnlocked: false },
    ]);

    // When profile gameFlag[1] == 1, option 2 unlocks while option 3 stays hidden.
    expect(choiceOptionsAt(cfg, { script: "2001", event: 1 }, flags, { profileGameFlags: { "1": 1 } })).toEqual([
      { n: 1, unlocked: true, visible: true, rawUnlocked: true },
      { n: 2, unlocked: true, visible: true, rawUnlocked: true },
      { n: 3, unlocked: false, visible: false, rawUnlocked: false },
    ]);
  });

  it("tracks executedRanges, SCall/ret stack, SetGameFlag callback and endings through Router", () => {
    const unlockedFlags: [number, number][] = [];
    const r = new Router(scenarios, flow, undefined, { version: 1, terminals: {} }, {
      cfg,
      profileGameFlags: { "1": 1 },
      endingSlots: { "21": "cc-setsuna" },
      onGameFlag: (id, val) => unlockedFlags.push([id, val]),
    });
    const flags: Flags = { aff: {}, set: {} };
    let pos = r.seek({ script: "2001", event: 0 }, flags);
    expect(pos).toEqual({ script: "2001", event: 0 });
    expect(flags.aff.s).toBe(1);

    const step1 = r.advance(pos, flags);
    expect(step1.pos).toEqual({ script: "2001", event: 1 });

    // Pick option 2 -> plays 2001:3, then SCalls 2001_sub:10 (event 0), then returns -> sets gflag 21 -> sloads 2002
    const pick2 = r.pick(step1.pos, 2, flags);
    expect(pick2.next).toEqual({ script: "2001", event: 3 });
    expect(flags.g?.[14]).toBe(2);
    expect(flags.cfg?.executedRanges).toEqual([[0, 1], [3, 4]]);

    const enterSub = r.advance(pick2.next, flags);
    expect(enterSub.pos).toEqual({ script: "2001_sub", event: 0 });
    expect(flags.cfg?.callStack).toHaveLength(1);

    const retAndSload = r.advance(enterSub.pos, flags);
    expect(retAndSload.pos).toEqual({ script: "2002", event: 0 });
    expect(flags.cfg?.callStack).toHaveLength(0);
    expect(unlockedFlags).toEqual([[21, 1]]);
    expect(retAndSload.unlockedEndings).toEqual(["cc-setsuna"]);

    const endRes = r.advance(retAndSload.pos, flags);
    expect(endRes.ended).toBe(true);
  });

  it("seeks mid-script while skipping unexecuted branch ranges and preserving restored g", () => {
    const flags: Flags = {
      aff: {},
      set: {},
      g: [0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 2],
    };
    const pos = seekCfg(cfg, { script: "2001", event: 3 }, flags, { preserveG: true });
    expect(pos).toEqual({ script: "2001", event: 3 });
    expect(flags.g![7]).toBe(5); // preserved instead of overwritten by leading setG=1
    expect(flags.cfg?.executedRanges).toEqual([[0, 1], [3, 4]]);
    expect(isEventInExecutedRanges(flags.cfg?.executedRanges, 2)).toBe(false);
    expect(isEventInExecutedRanges(flags.cfg?.executedRanges, 3)).toBe(true);

    // Stepping forward after seekCfg lands in 2001_sub cleanly!
    const next = stepCfg(cfg, pos, flags, {});
    expect(next.pos).toEqual({ script: "2001_sub", event: 0 });
  });
});
