// Data loading: built scenario IR + flow/endings, with a built-in demo
// fallback so the UI runs (and tests pass) with zero user assets.
// Built data lives in /data (emitted by tools/build.py) and is gitignored;
// demo content below is original placeholder text, not game content.

import type { BgmData, BnrData, CfgData, FlowData, LinksData, Scenario, SpeakersData, SysSlotsTable, TerminalsData, VoiceMapData } from "../engine/types";
import committedSysSlots from "../../../data/sys-slots.json";

export type LutMap = Record<string, { r: number[]; g: number[]; b: number[] }>;

export interface GameData {
  scenarios: Scenario[];
  flow: FlowData;
  links: LinksData;
  terminals: TerminalsData;
  endings: { endings: { id: string; name: string; unlock: string }[] };
  /** Compiled LSCR CFG AST (built by tools/build_cfg.py); null = legacy router fallback. */
  cfg: CfgData | null;
  /** BGM timeline (built by tools/build_bgm.py); null = no music data. */
  bgm: BgmData | null;
  /** Presentation records (built by tools/decode_bnr.py); null = none. */
  bnr: BnrData | null;
  /** Per-line voice map (built by tools/build_voice.py); null = tok fallback. */
  voicemap: VoiceMapData | null;
  /** Display-name overrides (built by tools/build_voice.py); null = none. */
  speakers: SpeakersData | null;
  /** Color-grade LUTs (when delivered via data/bundle.json); null = fetch luts.json or fallback. */
  luts: LutMap | null;
  /** `Sys.sav` slot map (native global save import). Always present: the
   * committed table is the fallback, so the importer works with demo and
   * older packs that predate `bundle.sysSlots`. */
  sysSlots: SysSlotsTable;
  demo: boolean;
  /** Scripts listed in the index that failed to load (stale cache/partial
   * copy). Empty when healthy; boot warns otherwise. */
  incomplete: string[];
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

/** Bounded concurrency (254 scripts loaded one-by-one made boot wait on
 * ~254 round trips; an unbounded Promise.all can trip host connection
 * limits). Results keep input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const DEMO: Scenario[] = [
  {
    script: "demo-1",
    tokens: 10,
    warnings: [],
    events: [
      { t: "image", file: "demo-bg.tga", layer: "bak" },
      { t: "narrate", text: "Snow gathers on the empty platform. The last train has gone." },
      { t: "say", speaker: "Demo", text: "You came back." },
      { t: "narrate", text: "The city hums beyond the embankment. Neither of us moves." },
      { t: "say", speaker: "Demo", text: "I thought you'd be gone by now." },
      { t: "narrate", text: "The cold makes every word feel heavier than it should." },
      { t: "choice", options: [{ n: 1, text: "Tell the truth.", goto: null }, { n: 2, text: "Change the subject.", goto: null }] },
      { t: "say", speaker: "Demo", text: "Then stay a little longer." },
      { t: "narrate", text: "The snowfall fills the silence.\\nSomewhere behind us, a crossing bell starts to ring." },
      { t: "say", speaker: "Demo", text: "This is placeholder script data. Build the engine with your own copy to read the real story.", style: "whisper" },
      { t: "narrate", text: "End of demo. Open the flowchart, guide, or settings to see the rest of the shell." },
    ],
  },
];

const DEMO_FLOW: FlowData = {
  version: 1,
  nodes: [
    {
      id: "demo-1-6", engine: { script: "demo-1", event: 6 },
      options: [{ n: 1, text: "Tell the truth.", goto: null }, { n: 2, text: "Change the subject.", goto: null }],
      date: null, effects: {}, gated: {}, walkthrough: null, status: "NEEDS_REVIEW",
    },
  ],
};

export function parsePackBase(raw: string | null | undefined, baseHref = "https://localhost/"): string {
  const trimmed = raw?.trim();
  if (!trimmed) return "";
  try {
    const u = new URL(trimmed, baseHref);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    // A pack root is a path prefix; query/hash belong to the page URL and
    // would make `<root>/data/...` malformed. Signed per-object URLs are
    // not a pack root.
    u.search = "";
    u.hash = "";
    return u.href.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function resolvePackBase(
  envPackUrl?: string | null,
  search = "",
  baseHref = "https://localhost/",
): { packBase: string; fromQuery: boolean } {
  const queryPack = parsePackBase(new URLSearchParams(search).get("pack"), baseHref);
  if (queryPack) return { packBase: queryPack, fromQuery: true };
  const envPack = parsePackBase(envPackUrl, baseHref);
  return { packBase: envPack, fromQuery: false };
}

interface BundlePayload {
  version?: number;
  scenarios?: Scenario[];
  flow?: FlowData;
  links?: LinksData | null;
  terminals?: TerminalsData | null;
  endings?: GameData["endings"] | null;
  cfg?: CfgData | null;
  bgm?: BgmData | null;
  bnr?: BnrData | null;
  voicemap?: VoiceMapData | null;
  speakers?: SpeakersData | null;
  luts?: LutMap | { version?: number; luts?: LutMap } | null;
  sysSlots?: SysSlotsTable | null;
}

/** The committed table is the fallback for demo runs and packs built before
 * `bundle.sysSlots` existed, so importing `Sys.sav` always has a slot map. */
const FALLBACK_SYS_SLOTS = committedSysSlots as unknown as SysSlotsTable;

function usableSysSlots(raw: unknown): SysSlotsTable | null {
  const t = raw as Partial<SysSlotsTable> | null | undefined;
  if (!t || typeof t !== "object") return null;
  if (!Array.isArray(t.scripts) || t.scripts.length === 0) return null;
  if (!Array.isArray(t.choiceTable?.scriptIds)) return null;
  if (!Array.isArray(t.cgRows)) return null;
  if (!t.endingSlots || typeof t.endingSlots !== "object") return null;
  if (!t.endingSlotsConfidence || typeof t.endingSlotsConfidence !== "object") return null;
  if (!t.gateSlots || typeof t.gateSlots !== "object") return null;
  return t as SysSlotsTable;
}

export const DEFAULT_SYS_SLOTS: SysSlotsTable = usableSysSlots(FALLBACK_SYS_SLOTS) ?? FALLBACK_SYS_SLOTS;

function sanitizeFlow(flow: FlowData): FlowData {
  // A pack is linkable/importable input; keep malformed nodes out of
  // Router construction instead of throwing on a missing engine/options.
  return {
    ...flow,
    nodes: flow.nodes.filter((n) =>
      n && n.engine &&
      typeof n.engine.script === "string" &&
      typeof n.engine.event === "number" &&
      Array.isArray(n.options)
    ),
  };
}

function unwrapLuts(raw: BundlePayload["luts"]): LutMap | null {
  if (!raw || typeof raw !== "object") return null;
  if ("luts" in raw && !("r" in raw) && raw.luts && typeof raw.luts === "object") {
    return raw.luts as LutMap;
  }
  return raw as LutMap;
}

export async function loadGameData(base = ""): Promise<GameData> {
  const prefix = base ? `${base.replace(/\/+$/, "")}/` : "";
  const bundle = await tryFetch<BundlePayload>(`${prefix}data/bundle.json`);
  if (bundle && Array.isArray(bundle.scenarios) && bundle.flow && Array.isArray(bundle.flow.nodes)) {
    const scenarios = bundle.scenarios.filter((sc) =>
      sc && typeof sc.script === "string" && Array.isArray(sc.events)
    );
    const bundleSys = usableSysSlots(bundle.sysSlots);
    if (scenarios.length > 0) {
      const sysSlots = bundleSys
        ?? usableSysSlots(await tryFetch<SysSlotsTable>(`${prefix}data/sys-slots.json`))
        ?? DEFAULT_SYS_SLOTS;
      const cfg = bundle.cfg !== undefined
        ? (bundle.cfg ?? null)
        : (await tryFetch<CfgData>(`${prefix}data/cfg.json`)) ?? null;
      return {
        scenarios,
        flow: sanitizeFlow(bundle.flow),
        links: bundle.links ?? { version: 1, links: [] },
        terminals: bundle.terminals ?? { version: 1, terminals: {} },
        endings: bundle.endings ?? { endings: [] },
        cfg,
        bgm: bundle.bgm ?? null,
        bnr: bundle.bnr ?? null,
        voicemap: bundle.voicemap ?? null,
        speakers: bundle.speakers ?? null,
        luts: unwrapLuts(bundle.luts),
        sysSlots,
        demo: false,
        incomplete: [],
      };
    }
  }
  const [index, flow, endings, links, terminals, cfg, bgm, bnr, voicemap, speakers, sysSlotsRaw] =
    await Promise.all([
      tryFetch<string[]>(`${prefix}data/scripts/index.json`),
      tryFetch<FlowData>(`${prefix}data/flow.json`),
      tryFetch<GameData["endings"]>(`${prefix}data/endings.json`),
      tryFetch<LinksData>(`${prefix}data/links.json`),
      tryFetch<TerminalsData>(`${prefix}data/terminals.json`),
      tryFetch<CfgData>(`${prefix}data/cfg.json`),
      tryFetch<BgmData>(`${prefix}data/bgm.json`),
      tryFetch<BnrData>(`${prefix}data/bnr.json`),
      tryFetch<VoiceMapData>(`${prefix}data/voicemap.json`),
      tryFetch<SpeakersData>(`${prefix}data/speakers.json`),
      tryFetch<SysSlotsTable>(`${prefix}data/sys-slots.json`),
    ]);
  const sysSlots = usableSysSlots(sysSlotsRaw) ?? DEFAULT_SYS_SLOTS;
  if (Array.isArray(index) && index.length > 0 && flow && Array.isArray(flow.nodes)) {
    const scenarios: Scenario[] = [];
    const failed: string[] = [];
    const results = await mapLimit(index, 12, async (id) => {
      const sc = await tryFetch<Scenario>(`${prefix}data/scripts/${id}.json`);
      if (!sc || typeof sc.script !== "string" || !Array.isArray(sc.events)) {
        return [id, null] as const;
      }
      return [id, sc] as const;
    });
    for (const [id, sc] of results) {
      if (sc) scenarios.push(sc);
      else failed.push(id);
    }
    if (failed.length > 0) {
      console.warn(`[wa2] ${failed.length}/${index.length} scripts failed to load (hard-refresh?):`, failed.slice(0, 5));
    }
    if (scenarios.length > 0) {
      return {
        scenarios, flow: sanitizeFlow(flow),
        links: links ?? { version: 1, links: [] },
        terminals: terminals ?? { version: 1, terminals: {} },
        endings: endings ?? { endings: [] },
        cfg: cfg ?? null,
        bgm, bnr, voicemap, speakers, luts: null,
        sysSlots,
        demo: false,
        incomplete: failed,
      };
    }
  }
  return {
    scenarios: DEMO,
    flow: DEMO_FLOW,
    links: { version: 1, links: [] },
    terminals: { version: 1, terminals: {} },
    endings: { endings: [] },
    cfg: null,
    bgm: null, bnr: null, voicemap: null, speakers: null, luts: null,
    sysSlots: DEFAULT_SYS_SLOTS,
    demo: true,
    incomplete: [],
  };
}
