// Data loading: built scenario IR + flow/endings, with a built-in demo
// fallback so the UI runs (and tests pass) with zero user assets.
// Built data lives in /data (emitted by tools/build.py) and is gitignored;
// demo content below is original placeholder text, not game content.

import type { BgmData, BnrData, CaptionData, CfgData, FlowData, LinksData, NativePosData, Scenario, SpeakersData, SysSlotsTable, TerminalsData, VoiceMapData } from "../engine/types";
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
  /** `.bnr` label-statement anchors (tools/build_native_pos.py); null = the
   * native-save importer falls back to plain text matching. */
  nativePos: NativePosData | null;
  /** BYOA timed captions for voice/SE clips (`data/captions.json`); null =
   * no captions in this pack. Presentation only, never playback gating. */
  captions: CaptionData | null;
  /** Color-grade LUTs (when delivered via data/bundle.json); null = fetch luts.json or fallback. */
  luts: LutMap | null;
  /** `Sys.sav` slot map (native global save import). Always present: the
   * committed table is the fallback, so the importer works with demo and
   * older packs that predate `bundle.sysSlots`. */
  sysSlots: SysSlotsTable;
  demo: boolean;
  /** Active alternative translation ("" when the pack default is in use).
   * Scripts, flow and speakers may come from `data/translations/<id>/`. */
  translation: string;
  /** True when a translation was requested but its data failed to load and
   * the pack default was used instead (boot shows a warning). */
  translationFallback: boolean;
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

/** Alternative translation metadata (from `data/translations/index.json`,
 * written by `tools/build.py --alt`). The first entry is the pack default. */
export interface TranslationInfo {
  id: string;
  name?: string;
  label?: string;
  desc?: string;
  repo?: string;
}

let translationsCache: { base: string; list: TranslationInfo[] } | null = null;

export async function loadTranslations(base = ""): Promise<TranslationInfo[]> {
  const prefix = base ? base.replace(/\/+$/, "") + "/" : "";
  if (translationsCache && translationsCache.base === prefix) return translationsCache.list;
  const raw = await tryFetch<{ version?: number; translations?: TranslationInfo[] }>(
    `${prefix}data/translations/index.json`);
  const list = raw && Array.isArray(raw.translations)
    ? raw.translations.filter((t): t is TranslationInfo => !!t && typeof t.id === "string")
    : [];
  translationsCache = { base: prefix, list };
  return list;
}

/** Pure pick: the stored id when the pack offers it, otherwise the pack
 * default (first entry), otherwise "" (single-translation pack/demo). */
export function activeTranslationId(
  list: TranslationInfo[],
  stored: string | null | undefined,
): string {
  if (stored && list.some((t) => t.id === stored)) return stored;
  return list.length > 0 ? list[0].id : "";
}

/** Per-translation overlay: scripts (+index), flow and optional speakers
 * from `data/translations/<id>/`. Everything else is shared. */
interface TranslationOverlay {
  scenarios: Scenario[];
  failed: string[];
  flow: FlowData;
  speakers: SpeakersData | null;
  /** Alt voice map (shared anchors minus scripts whose alt event stream
   * does not align with the default build); null = use the shared map. */
  voicemap: VoiceMapData | null;
}

async function loadTranslationOverlay(
  prefix: string,
  id: string,
): Promise<TranslationOverlay | null> {
  const tPrefix = `${prefix}data/translations/${id}/`;
  const index = await tryFetch<string[]>(`${tPrefix}scripts/index.json`);
  const flow = await tryFetch<FlowData>(`${tPrefix}flow.json`);
  if (!index || index.length === 0 || !flow || !Array.isArray(flow.nodes)) return null;
  const results = await mapLimit(index, 12, async (sid) => {
    const sc = await tryFetch<Scenario>(`${tPrefix}scripts/${sid}.json`);
    return [sid, sc && typeof sc.script === "string" && Array.isArray(sc.events) ? sc : null] as const;
  });
  const scenarios: Scenario[] = [];
  const failed: string[] = [];
  for (const [sid, sc] of results) {
    if (sc) scenarios.push(sc);
    else failed.push(sid);
  }
  if (scenarios.length === 0) return null;
  return {
    scenarios,
    failed,
    flow: sanitizeFlow(flow),
    speakers: await tryFetch<SpeakersData>(`${tPrefix}speakers.json`),
    voicemap: await tryFetch<VoiceMapData>(`${tPrefix}voicemap.json`),
  };
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
  nativePos?: NativePosData | null;
  captions?: CaptionData | null;
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

/** Lazy native-save anchors (`data/native-pos.json`, ~1.6 MB). Only the
 * Save/Load importer needs them, so they must not inflate the boot payload.
 * The promise is cached per pack prefix (including a cached 404). */
const nativePosCache = new Map<string, Promise<NativePosData | null>>();
export function loadNativePos(base = ""): Promise<NativePosData | null> {
  const prefix = base ? `${base.replace(/\/+$/, "")}/` : "";
  let pending = nativePosCache.get(prefix);
  if (!pending) {
    pending = tryFetch<NativePosData>(`${prefix}data/native-pos.json`);
    nativePosCache.set(prefix, pending);
  }
  return pending;
}

export async function loadGameData(base = "", translation = ""): Promise<GameData> {
  const prefix = base ? `${base.replace(/\/+$/, "")}/` : "";
  const bundle = await tryFetch<BundlePayload>(`${prefix}data/bundle.json`);
  if (bundle && Array.isArray(bundle.scenarios) && bundle.flow && Array.isArray(bundle.flow.nodes)) {
    const baseScenarios = bundle.scenarios.filter((sc) =>
      sc && typeof sc.script === "string" && Array.isArray(sc.events)
    );
    let scenarios = baseScenarios;
    let flow = sanitizeFlow(bundle.flow);
    let speakers = bundle.speakers ?? null;
    let voicemap = bundle.voicemap ?? null;
    let incomplete: string[] = [];
    let translationFallback = false;
    if (translation && baseScenarios.length > 0) {
      // Loose per-file alt layer next to the bundle (the bundler prunes
      // only the pack default's files). All or nothing per file.
      const alt = await loadTranslationOverlay(prefix, translation);
      if (alt) {
        if (alt.failed.length > 0) {
          console.warn(`[wa2] translation ${translation}: ${alt.failed.length} script(s) failed to load:`, alt.failed.slice(0, 5));
        }
        scenarios = baseScenarios.map((sc) =>
          alt.scenarios.find((a) => a.script === sc.script) ?? sc);
        flow = alt.flow;
        speakers = alt.speakers ?? speakers;
        voicemap = alt.voicemap ?? voicemap;
        incomplete = alt.failed;
      } else {
        translationFallback = true;
      }
    }
    const bundleSys = usableSysSlots(bundle.sysSlots);
    if (scenarios.length > 0) {
      const sysSlots = bundleSys
        ?? usableSysSlots(await tryFetch<SysSlotsTable>(`${prefix}data/sys-slots.json`))
        ?? DEFAULT_SYS_SLOTS;
      const cfg = bundle.cfg !== undefined
        ? (bundle.cfg ?? null)
        : (await tryFetch<CfgData>(`${prefix}data/cfg.json`)) ?? null;
      // Captions are presentation data loaded at boot (small). Native-save
      // anchors are import-only and ~1.6 MB; they are lazy-loaded by
      // `loadNativePos()` when the Save/Load importer needs them.
      const captions = bundle.captions !== undefined
        ? bundle.captions
        : await tryFetch<CaptionData>(`${prefix}data/captions.json`);
      return {
        scenarios,
        flow,
        links: bundle.links ?? { version: 1, links: [] },
        terminals: bundle.terminals ?? { version: 1, terminals: {} },
        endings: bundle.endings ?? { endings: [] },
        cfg,
        bgm: bundle.bgm ?? null,
        bnr: bundle.bnr ?? null,
        voicemap,
        speakers,
        nativePos: null,
        captions: captions ?? null,
        luts: unwrapLuts(bundle.luts),
        sysSlots,
        demo: false,
        translation,
        translationFallback,
        incomplete,
      };
    }
  }
  // Loose per-file layout. With a translation selected, scripts + flow +
  // speakers come from the translation dir; everything else is shared. A
  // missing/broken alt set falls back to the pack default (and is flagged).
  const loadLoose = async (
    scriptPrefix: string,
    flowUrl: string,
    speakerUrl: string,
  ): Promise<{ scenarios: Scenario[]; flow: FlowData; speakers: SpeakersData | null; failed: string[] } | null> => {
    const [index, flowReq, speakersReq] = await Promise.all([
      tryFetch<string[]>(`${scriptPrefix}index.json`),
      tryFetch<FlowData>(flowUrl),
      tryFetch<SpeakersData>(speakerUrl),
    ]);
    if (!Array.isArray(index) || index.length === 0 || !flowReq || !Array.isArray(flowReq.nodes)) {
      return null;
    }
    const scenarios: Scenario[] = [];
    const failed: string[] = [];
    const results = await mapLimit(index, 12, async (id) => {
      const sc = await tryFetch<Scenario>(`${scriptPrefix}${id}.json`);
      if (!sc || typeof sc.script !== "string" || !Array.isArray(sc.events)) {
        return [id, null] as const;
      }
      return [id, sc] as const;
    });
    for (const [id, sc] of results) {
      if (sc) scenarios.push(sc);
      else failed.push(id);
    }
    if (scenarios.length === 0) return null;
    return { scenarios, flow: sanitizeFlow(flowReq), speakers: speakersReq, failed };
  };

  const [endings, links, terminals, cfg, bgm, bnr, voicemap, sysSlotsRaw, captions] =
    await Promise.all([
      tryFetch<GameData["endings"]>(`${prefix}data/endings.json`),
      tryFetch<LinksData>(`${prefix}data/links.json`),
      tryFetch<TerminalsData>(`${prefix}data/terminals.json`),
      tryFetch<CfgData>(`${prefix}data/cfg.json`),
      tryFetch<BgmData>(`${prefix}data/bgm.json`),
      tryFetch<BnrData>(`${prefix}data/bnr.json`),
      tryFetch<VoiceMapData>(`${prefix}data/voicemap.json`),
      tryFetch<SysSlotsTable>(`${prefix}data/sys-slots.json`),
      tryFetch<CaptionData>(`${prefix}data/captions.json`),
    ]);
  const sysSlots = usableSysSlots(sysSlotsRaw) ?? DEFAULT_SYS_SLOTS;
  let picked = null;
  let translationFallback = false;
  let vmOverride: VoiceMapData | null = null;
  if (translation) {
    // Alt set first: an alt user never downloads the default script set.
    picked = await loadLoose(
      `${prefix}data/translations/${translation}/scripts/`,
      `${prefix}data/translations/${translation}/flow.json`,
      `${prefix}data/translations/${translation}/speakers.json`,
    );
    if (picked) {
      vmOverride = await tryFetch<VoiceMapData>(
        `${prefix}data/translations/${translation}/voicemap.json`);
    } else {
      translationFallback = true;
    }
  }
  if (!picked) {
    picked = await loadLoose(`${prefix}data/scripts/`, `${prefix}data/flow.json`,
      `${prefix}data/speakers.json`);
  }
  if (picked) {
    if (picked.failed.length > 0) {
      console.warn(`[wa2] ${picked.failed.length}/${picked.scenarios.length + picked.failed.length} scripts failed to load (hard-refresh?):`, picked.failed.slice(0, 5));
    }
    return {
      scenarios: picked.scenarios,
      flow: picked.flow,
      links: links ?? { version: 1, links: [] },
      terminals: terminals ?? { version: 1, terminals: {} },
      endings: endings ?? { endings: [] },
      cfg: cfg ?? null,
      bgm, bnr, voicemap: vmOverride ?? voicemap,
      speakers: picked.speakers,
      luts: null,
      nativePos: null,
      captions: captions ?? null,
      sysSlots,
      demo: false,
      translation,
      translationFallback,
      incomplete: picked.failed,
    };
  }
  return {
    scenarios: DEMO,
    flow: DEMO_FLOW,
    links: { version: 1, links: [] },
    terminals: { version: 1, terminals: {} },
    endings: { endings: [] },
    cfg: null,
    bgm: null, bnr: null, voicemap: null, speakers: null, luts: null,
    nativePos: null, captions: null,
    sysSlots: DEFAULT_SYS_SLOTS,
    demo: true,
    translation: "",
    translationFallback: false,
    incomplete: [],
  };
}
