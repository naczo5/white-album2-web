import { describe, expect, it } from "vitest";
import { Router } from "../engine/router";
import type { FlowData, LinksData, Scenario, TerminalsData } from "../engine/types";
import type { NativeSave } from "../engine/native-save";
import { nativeCandidates } from "./saves";

const emptyFlow: FlowData = { version: 1, nodes: [] };
const emptyLinks: LinksData = { version: 1, links: [] };
const emptyTerms: TerminalsData = { version: 1, terminals: {} };

function native(route: string, text = "Shared line."): NativeSave {
  return {
    version: 2,
    playtime: 0,
    timestamp: "",
    preview: text,
    text,
    speaker: "",
    options: [],
    script: "1007",
    route,
  };
}

function scenario(script: string, text: string, count = 1): Scenario {
  return {
    script,
    tokens: count,
    warnings: [],
    events: Array.from({ length: count }, () => ({ t: "narrate" as const, text })),
  };
}

describe("native route candidates", () => {
  it("prefers an exact route variant and exposes its position", () => {
    const router = new Router(
      [scenario("1007", "Base line.", 1), scenario("1007_030", "Shared line.", 3)],
      emptyFlow, emptyLinks, emptyTerms,
    );
    const out = nativeCandidates(router, native("030"));
    expect(out).toHaveLength(3);
    expect(out.every((p) => p.script === "1007_030")).toBe(true);
    expect(out.map((p) => p.event)).toEqual([0, 1, 2]);
  });

  it("returns every exact duplicate instead of choosing one", () => {
    const router = new Router(
      [scenario("1007", "Shared line.", 2)],
      emptyFlow, emptyLinks, emptyTerms,
    );
    const out = nativeCandidates(router, native("2"));
    expect(out.map((p) => p.event)).toEqual([0, 1]);
  });
});
