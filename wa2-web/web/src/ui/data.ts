// Data loading: built scenario IR + flow/endings, with a built-in demo
// fallback so the UI runs (and tests pass) with zero user assets.
// Built data lives in /data (emitted by tools/build.py) and is gitignored;
// demo content below is original placeholder text, not game content.

import type { FlowData, LinksData, Scenario, TerminalsData } from "../engine/types";

export interface GameData {
  scenarios: Scenario[];
  flow: FlowData;
  links: LinksData;
  terminals: TerminalsData;
  endings: { endings: { id: string; name: string; unlock: string }[] };
  demo: boolean;
}

async function tryFetch<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const DEMO: Scenario[] = [
  {
    script: "demo-1",
    tokens: 6,
    warnings: [],
    events: [
      { t: "image", file: "demo-bg.tga", layer: "bak" },
      { t: "narrate", text: "Snow falls over the empty platform.\\nThis is demo content - install your assets to play." },
      { t: "latch", name: "Demo" },
      { t: "say", speaker: "Demo", text: "No game files were found, so this placeholder plays instead." },
      { t: "say", speaker: "Demo", text: "Run tools/build.py with your own copy, then reload.", style: "whisper" },
      { t: "choice", options: [{ n: 1, text: "See the flowchart", goto: null }, { n: 2, text: "Read the guide", goto: null }] },
      { t: "narrate", text: "The demo ends here. Thanks for checking the engine." },
    ],
  },
];

const DEMO_FLOW: FlowData = {
  version: 1,
  nodes: [
    {
      id: "demo-1-5", engine: { script: "demo-1", event: 5 },
      options: [{ n: 1, text: "See the flowchart", goto: null }, { n: 2, text: "Read the guide", goto: null }],
      date: null, effects: {}, gated: {}, walkthrough: null, status: "NEEDS_REVIEW",
    },
  ],
};

export async function loadGameData(): Promise<GameData> {
  const [index, flow, endings, links, terminals] = await Promise.all([
    tryFetch<string[]>("data/scripts/index.json"),
    tryFetch<FlowData>("data/flow.json"),
    tryFetch<GameData["endings"]>("data/endings.json"),
    tryFetch<LinksData>("data/links.json"),
    tryFetch<TerminalsData>("data/terminals.json"),
  ]);
  if (index && index.length > 0 && flow) {
    const scenarios: Scenario[] = [];
    for (const id of index) {
      const sc = await tryFetch<Scenario>(`data/scripts/${id}.json`);
      if (sc) scenarios.push(sc);
    }
    if (scenarios.length > 0) {
      return {
        scenarios, flow,
        links: links ?? { version: 1, links: [] },
        terminals: terminals ?? { version: 1, terminals: {} },
        endings: endings ?? { endings: [] },
        demo: false,
      };
    }
  }
  return {
    scenarios: DEMO,
    flow: DEMO_FLOW,
    links: { version: 1, links: [] },
    terminals: { version: 1, terminals: {} },
    endings: { endings: [] },
    demo: true,
  };
}
