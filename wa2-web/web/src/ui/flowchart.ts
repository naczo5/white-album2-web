// Flowchart screen: engine-derived route graph (tsukiweb-style node chart).
// Nodes = scenario scripts, edges = decoded script links + terminal chains
// (+ spine continuation when a script has no decoded link). Layout is a
// pure function (test-pinned): BFS depth columns, barycenter row ordering.

import { imageUrl } from "../engine/assets";
import { chapterOfScript, type Spine } from "../engine/router";
import { displayDate, plainText } from "../engine/text";
import type {
  BnrData, CfgData, CfgOp, FlowData, LinkSite, SaveData, Scenario,
  SysProfile, TerminalsData,
} from "../engine/types";

export interface ChartGraph {
  nodes: { id: string; chapter: string }[];
  edges: { from: string; to: string; kind: "link" | "chain" | "spine" }[];
  /** BFS depth from the IC root (columns). */
  depth: Record<string, number>;
  /** Pure layout: script -> {x, y} px. */
  pos: Record<string, { x: number; y: number }>;
  width: number;
  height: number;
}

export const NODE_W = 144;
/** Image plate: 16:9, the same frame as the reader stage. */
export const NODE_IMG_H = 81;
export const NODE_H = NODE_IMG_H + 31;
const GAP_X = 46;
const GAP_Y = 18;

const CHAPTER_SHORT: Record<string, string> = {
  intro: "Introductory",
  closing: "Closing",
  coda: "Coda",
  special: "Special",
};

/** Story-facing scene label for flowchart nodes, save slots, and Continue.
 * Dev mode surfaces raw script IDs; player mode hides them behind chapter,
 * story date (curated `flow.json` date, else the script's first `.bnr`
 * calendar stamp), and `???` when neither visited nor spoiled. */
export function sceneLabel(
  script: string,
  flow: FlowData | null | undefined,
  opts: {
    spoiler?: boolean; dev?: boolean; visited?: boolean;
    /** Presentation records for this script; supplies a date when
     * `flow.json` has no curated one (the intro chapter has no stamps). */
    bnr?: BnrData["recs"][string] | null;
  } = {},
): string {
  if (opts.dev) return script;
  if (script.startsWith("demo")) return "Demo";
  const ch = CHAPTER_SHORT[chapterOfScript(script)] ?? "Special";
  if (!opts.visited && !opts.spoiler) return `${ch} · ???`;
  const rawDate = flow?.nodes.find((n) => n.engine.script === script && n.date)?.date;
  const date = displayDate(rawDate, false) ?? calSceneDate(opts.bnr);
  return date ? `${ch} · ${date}` : ch;
}

/** First high-confidence calendar stamp in a script, formatted like the
 * `flow.json` dates (`M/D`). `.bnr` (4,203) is the in-game calendar plate;
 * the intro chapter never stamps one, so this returns null there rather
 * than guessing from prose. */
export function calSceneDate(
  bnr: BnrData["recs"][string] | null | undefined,
): string | null {
  let bestEv = Infinity;
  let best: { month: number; day: number } | null = null;
  for (const r of bnr ?? []) {
    if (r.conf !== "high" || !r.cal || r.ev >= bestEv) continue;
    bestEv = r.ev;
    best = r.cal;
  }
  return best ? `${best.month}/${best.day}` : null;
}

/** A script's visual cues in playback order: each entry is one image event,
 * with the candidate filenames in resolution order. Backdrops (`bak`, and
 * legacy layer-less txt images) come before overlay CGs (`grp`) at the same
 * event, matching the reader's stage resolver. Clears are not art and are
 * skipped — a scene that fades to black before its first backdrop should
 * still get the backdrop as its card. */
export function sceneImageCues(
  scenario: Scenario | undefined,
  bnr: BnrData["recs"][string] | null | undefined,
): string[][] {
  type Cue = { ev: number; rank: number; files: string[] };
  const cues: Cue[] = [];
  scenario?.events.forEach((e, i) => {
    if (e.t !== "image") return;
    const grp = e.layer === "grp";
    cues.push({
      ev: i,
      rank: grp ? 1 : 0,
      // txt events carry the full file id; the v* stem prefix below is
      // only for .bnr grp records (4,148).
      files: [e.file],
    });
  });
  for (const r of bnr ?? []) {
    if (r.conf !== "high" || r.clear || !r.stems?.length) continue;
    if (r.layer === "bak") {
      cues.push({ ev: r.ev, rank: 0, files: r.stems.map((s) => `b${s}.tga`) });
    } else if (r.layer === "grp") {
      cues.push({
        ev: r.ev,
        rank: 1,
        files: r.stems.flatMap((s) => [`v${s}.tga`, `tv${s}.tga`]),
      });
    }
  }
  cues.sort((a, b) => a.ev - b.ev || a.rank - b.rank);
  return cues.map((c) => c.files);
}

/** Engine white-fade plates: flat white images used for transitions, never
 * scene art. 192 scripts put `B990000.tga` at event 0, so treating it as a
 * backdrop paints their card white. */
const TRANSITION_PLATE = /^b99000[0-3]\.tga$/i;

function isTransitionPlate(file: string): boolean {
  return TRANSITION_PLATE.test(file);
}

/** Resolve the first installed image a script shows. Unresolvable cues fall
 * through to the next one, so a partial install still yields a card when a
 * later backdrop exists. `resolve` is injectable for tests. */
export function firstSceneImage(
  script: string,
  scenario: Scenario | undefined,
  bnr: BnrData["recs"][string] | null | undefined,
  resolve: (file: string, chapter: string) => string | null = imageUrl,
): string | null {
  const chapter = chapterOfScript(script);
  for (const files of sceneImageCues(scenario, bnr)) {
    for (const file of files) {
      if (isTransitionPlate(file)) continue;
      const url = resolve(file, chapter);
      if (url) return url;
    }
  }
  return null;
}

/** Resolve each script's scene frame with parent inheritance.
 *
 * Each id keeps its own art (`ownArt`); an id without art inherits the
 * first parent's (transitively), so a continuation scene with no cue shows
 * the scene it continues. The parent graph has real cycles (the coda
 * routes loop: 3015 ↔ 3014_2/_3 ↔ 3024 …), so the walk is cycle-guarded.
 * A null reached through the guard is provisional — the blocked ancestor
 * may still resolve art from another parent — and is therefore not
 * memoized; a later top-level pass re-derives it from the now-complete
 * cache. Found art is always final and always memoized. Pure; test-pinned. */
export function resolveInheritedArt(
  ids: string[],
  parentsOf: (id: string) => string[],
  ownArt: (id: string) => string | null,
): Map<string, string | null> {
  const cache = new Map<string, string | null>();
  const resolve = (id: string, ctx: { stack: Set<string>; blocked: boolean }): string | null => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    if (ctx.stack.has(id)) {
      ctx.blocked = true;
      return null;
    }
    ctx.stack.add(id);
    let url = ownArt(id);
    if (!url) {
      for (const p of parentsOf(id)) {
        const fromParent = resolve(p, ctx);
        if (fromParent) {
          url = fromParent;
          break;
        }
      }
    }
    ctx.stack.delete(id);
    if (url !== null || !ctx.blocked) cache.set(id, url);
    return url;
  };
  for (const id of ids) resolve(id, { stack: new Set<string>(), blocked: false });
  return cache;
}

function collectCfgEdges(
  ops: CfgOp[],
  from: string,
  add: (from: string, to: string, kind: ChartGraph["edges"][number]["kind"]) => void,
): void {
  for (const op of ops) {
    if (op.t === "sload") add(from, op.script, "link");
    else if (op.t === "scall") add(from, op.script, "chain");
    else if (op.t === "if") {
      for (const br of op.branches) collectCfgEdges(br.ops, from, add);
    }
  }
}

/** Build the route graph: reachable scripts from the first scenario
 * (1001 in the real set; callers pass a sorted list). When `cfg` is
 * supplied, engine `sload`/`scall` edges replace `links` and `spine.next`. */
export function buildChartGraph(
  scripts: string[],
  spine: Spine,
  links: LinkSite[],
  terminals: TerminalsData["terminals"],
  cfg?: CfgData | null,
): ChartGraph {
  const root = scripts[0] ?? "1001";
  const out = new Map<string, { to: string; kind: ChartGraph["edges"][number]["kind"] }[]>();
  const add = (from: string, to: string, kind: ChartGraph["edges"][number]["kind"]) => {
    if (from === to) return;
    const list = out.get(from) ?? [];
    if (!list.some((e) => e.to === to)) list.push({ to, kind });
    out.set(from, list);
  };
  if (cfg) {
    for (const [sc, entries] of Object.entries(cfg.scripts)) {
      for (const ops of Object.values(entries)) {
        collectCfgEdges(ops, sc, add);
      }
    }
    for (const [sc, t] of Object.entries(terminals)) {
      if (t.action === "chain") add(sc, t.to, "chain");
    }
  } else {
    for (const l of links) {
      for (const t of l.targets) add(l.engine.script, t, "link");
    }
    for (const [sc, t] of Object.entries(terminals)) {
      if (t.action === "chain") add(sc, t.to, "chain");
    }
    for (const [sc, nxt] of Object.entries(spine.next)) {
      if (nxt) add(sc, nxt, "spine");
    }
  }

  // Reachability closure: one worklist over link/chain edges (and spine
  // successors only when cfg is absent).
  const depth: Record<string, number> = { [root]: 0 };
  const queue = [root];
  const reached = new Set([root]);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of out.get(cur) ?? []) {
      if (reached.has(e.to)) continue;
      reached.add(e.to);
      depth[e.to] = depth[cur]! + 1;
      queue.push(e.to);
    }
    if (!cfg) {
      const sp = spine.next[cur];
      if (sp && !reached.has(sp)) {
        reached.add(sp);
        depth[sp] = depth[cur]! + 1;
        queue.push(sp);
      }
    }
  }

  const nodes = [...reached].sort((a, b) => (depth[a] ?? 0) - (depth[b] ?? 0))
    .map((id) => ({ id, chapter: spine.chapterOf[id] ?? chapterOfScript(id) }));
  const edges: ChartGraph["edges"] = [];
  for (const [from, list] of out) {
    if (!reached.has(from)) continue;
    for (const { to, kind } of list) {
      if (reached.has(to)) edges.push({ from, to, kind });
    }
  }

  // Rows: group by depth; order within row by first-parent barycenter.
  const cols = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth[n.id] ?? 0;
    (cols.get(d) ?? cols.set(d, []).get(d)!).push(n.id);
  }
  const parents = new Map<string, string[]>();
  for (const e of edges) (parents.get(e.to) ?? parents.set(e.to, []).get(e.to)!).push(e.from);
  const colIndex = new Map<string, number>();
  const orderedDepths = [...cols.keys()].sort((a, b) => a - b);
  for (const d of orderedDepths) {
    const col = cols.get(d)!;
    col.sort((a, b) => {
      const pa = parents.get(a) ?? [];
      const pb = parents.get(b) ?? [];
      const ba = pa.length ? Math.min(...pa.map((p) => colIndex.get(p) ?? 0)) : 1e9;
      const bb = pb.length ? Math.min(...pb.map((p) => colIndex.get(p) ?? 0)) : 1e9;
      return ba - bb || a.localeCompare(b);
    });
    col.forEach((id, i) => colIndex.set(id, i));
  }
  // Vertical flow: depth -> row (the route is a long linear chain — a
  // horizontal strip would be tens of thousands of px wide); branch
  // siblings spread across the row horizontally.
  const pos: ChartGraph["pos"] = {};
  let width = 0;
  for (const d of orderedDepths) {
    const col = cols.get(d)!;
    col.forEach((id, i) => {
      pos[id] = { x: i * (NODE_W + GAP_X), y: d * (NODE_H + GAP_Y) };
    });
    width = Math.max(width, col.length * (NODE_W + GAP_X) - GAP_X);
  }
  const maxDepth = orderedDepths[orderedDepths.length - 1] ?? 0;
  return {
    nodes, edges, depth, pos,
    width,
    height: (maxDepth + 1) * (NODE_H + GAP_Y) - GAP_Y,
  };
}

export interface FlowHooks {
  flow: FlowData;
  save: SaveData;
  spine: Spine;
  links: LinkSite[];
  terminals: TerminalsData["terminals"];
  cfg?: CfgData | null;
  spoiler: boolean;
  /** Dev mode: show a scene-jump button in the node detail panel. */
  dev?: boolean;
  /** Scenario IR lookup, for the node scene thumbnails (router.scripts). */
  scenarios?: Map<string, Scenario>;
  /** Presentation records, for the first `.bnr` backdrop of a scene. */
  bnr?: BnrData | null;
  /** Unreached cards render a black plate instead of a frosted still, and
   * their frame is never fetched (default true = zero visual spoilers). */
  hideUnrevealed?: boolean;
  /** Global progress from an imported `Sys.sav`: visited scripts and choice
   * history that exist outside the current run. */
  profile?: SysProfile | null;
  onJump?(script: string): void;
  onBack(): void;
}

/** Scripts the chart lights up: this run's visited set unioned with the
 * global profile (an imported `Sys.sav`), so a route read in the original
 * build shows as read here too. */
export function chartVisited(save: SaveData, profile?: SysProfile | null): Set<string> {
  const visited = new Set(save.visited);
  for (const s of profile?.visited ?? []) visited.add(s);
  return visited;
}

/** Whether an option's text may be shown: picked in this run, seen in an
 * imported choice bitmask, or spoilers are on. */
export function optionSeen(
  save: SaveData,
  profile: SysProfile | null | undefined,
  nodeId: string,
  n: number,
  spoiler: boolean,
): boolean {
  return save.picks[nodeId] === n || profile?.seenPicks?.[nodeId]?.includes(n) === true || spoiler;
}

/** Window resize hook owned by the most recent flowchart render. `.fc-wrap`
 * is capped at 64vh, so a viewport resize can expose rows without any
 * scroll event; the hook is swapped on every render and self-removes once
 * its chart is detached. */
let fcResizeHook: (() => void) | null = null;

export function renderFlowchart(el: HTMLElement, h: FlowHooks): void {
  const g = buildChartGraph(
    [...new Set([...h.spine.order])],
    h.spine, h.links, h.terminals, h.cfg,
  );
  const visited = chartVisited(h.save, h.profile);
  const cur = h.save.position.script;
  // Default is the spoiler-free chart: unreached cards are black. Dev mode
  // is the verification view (scene jumps, raw ids), so it always shows art.
  const hideUnrevealed = h.dev ? false : (h.hideUnrevealed ?? true);
  const choicesByScript = new Map<string, typeof h.flow.nodes>();
  for (const n of h.flow.nodes) {
    (choicesByScript.get(n.engine.script) ?? choicesByScript.set(n.engine.script, []).get(n.engine.script)!).push(n);
  }

  // Scene cards: each node shows the first frame its script actually paints
  // (earliest resolvable txt/bnr backdrop, then grp CG). Variants without
  // their own art borrow the base file's; continuation scenes with no cue at
  // all inherit the nearest parent's frame (resolveInheritedArt), so the
  // chart reads as a film strip instead of empty boxes.
  const parents = new Map<string, string[]>();
  for (const e of g.edges) {
    (parents.get(e.to) ?? parents.set(e.to, []).get(e.to)!).push(e.from);
  }
  const thumbLookup = (id: string) => {
    const base = id.replace(/_\d+$/, "");
    return firstSceneImage(id, h.scenarios?.get(id), h.bnr?.recs?.[id]) ??
      (base !== id
        ? firstSceneImage(base, h.scenarios?.get(base), h.bnr?.recs?.[base])
        : null);
  };
  const thumbs = resolveInheritedArt(
    g.nodes.map((n) => n.id),
    (id) => parents.get(id) ?? [],
    thumbLookup,
  );

  const pad = 16;
  const edgesSvg = g.edges.map((e) => {
    const a = g.pos[e.from];
    const b = g.pos[e.to];
    if (!a || !b) return "";
    const x1 = a.x + NODE_W / 2, y1 = a.y + NODE_H;
    const x2 = b.x + NODE_W / 2, y2 = b.y;
    const lit = visited.has(e.to) && visited.has(e.from);
    const my = (y1 + y2) / 2;
    const d = `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
    return `<path d="${d}" fill="none" stroke="${lit ? "#7ef3ec" : "#215a67"}"
      stroke-width="${lit ? 2 : 1}" opacity="${lit ? 0.85 : 0.7}" ${
      e.kind === "chain" ? 'stroke-dasharray="4 3"' : ""
    } marker-end="url(#arrow)"/>`;
  }).join("");

  const nodesSvg = g.nodes.map((n) => {
    const p = g.pos[n.id]!;
    const isCur = n.id === cur;
    const seen = visited.has(n.id);
    const chColor = {
      intro: "#7fe3e2", closing: "#a9d7ff", coda: "#f0dc9a", special: "#f3b6cf",
    }[n.chapter] ?? "#8fb3b8";
    const choices = choicesByScript.get(n.id) ?? [];
    const nChoices = choices.length;
    const label = sceneLabel(n.id, h.flow, {
      spoiler: h.spoiler, dev: h.dev, visited: seen,
      bnr: h.bnr?.recs?.[n.id],
    });
    const sub = h.dev
      ? `${displayDate(choices.find((c) => c.date)?.date, true) || n.chapter}${nChoices ? ` · ${nChoices} choice${nChoices === 1 ? "" : "s"}` : ""}`
      : `${nChoices ? `${nChoices} choice${nChoices === 1 ? "" : "s"}` : seen ? "Visited" : "Unvisited"}`;
    const thumb = thumbs.get(n.id) ?? null;
    // Hidden mode: an unreached card is a black plate and its PNG is never
    // requested — no frost to see through, and nothing to decode on scroll.
    // (A scene with no art at all keeps the placeholder plate either way.)
    const artHidden = !seen && hideUnrevealed;
    const showArt = !!thumb && !artHidden;
    const frame = isCur ? "#f0dc9a" : seen ? "#2d7d87" : "#17434f";
    // Dev sub lines carry raw flow annotations ("12/18~19 FINAL ROUTER ·
    // 4 choices") that overflow the 144px card, so they are clipped; the
    // full text stays in the <title> tooltip. The current card keeps the
    // "You are here" affordance in player mode.
    const devSub = clipCardText(sub);
    const subText = isCur
      ? `Now · ${h.dev ? devSub : "You are here"}`
      : h.dev ? devSub : sub;
    return `<g transform="translate(${p.x},${p.y})" data-node="${escapeAttr(n.id)}" data-y="${p.y}"
      class="fc-node ${seen ? "seen" : "locked"}${isCur ? " current" : ""}"
      tabindex="0" role="button" aria-label="${escapeAttr(label)}${seen ? "" : ", not reached yet"}">
      <title>${escapeHtml(label)} — ${seen ? "visited" : "not reached yet"}</title>
      <rect width="${NODE_W}" height="${NODE_H}" rx="2" fill="${seen ? "#0b303a" : "#071f28"}"/>
      <g clip-path="url(#fc-media-clip)">
        <rect width="${NODE_W}" height="${NODE_IMG_H}" fill="${
          artHidden ? "#000" : "url(#fc-plate)"
        }"/>
        <use href="#fc-flake" transform="translate(${NODE_W / 2},${NODE_IMG_H / 2})"
          stroke="${artHidden ? "#223b42" : seen ? "#5d9ba1" : "#3c646b"}" stroke-width="1.1" opacity="${artHidden ? 0.3 : seen ? 0.6 : 0.4}"/>
        ${showArt
          ? `<image class="fc-thumb" data-src="${escapeAttr(thumb)}" x="-6" y="-6"
              width="${NODE_W + 12}" height="${NODE_IMG_H + 12}"
              preserveAspectRatio="xMidYMid slice"/>`
          : ""}
        <rect width="${NODE_W}" height="${NODE_IMG_H}" fill="url(#fc-media-scrim)"/>
        <rect class="fc-veil" width="${NODE_W}" height="${NODE_IMG_H}" fill="#04161d"/>
      </g>
      <rect y="${NODE_IMG_H}" width="${NODE_W}" height="${NODE_H - NODE_IMG_H}" fill="${seen ? "#0b303a" : "#071f28"}"/>
      <rect y="${NODE_IMG_H}" width="${NODE_W}" height="1" fill="${chColor}" opacity="${seen ? 0.5 : 0.22}"/>
      <text x="9" y="${NODE_IMG_H + 14}" font-size="11.5" fill="${isCur ? "#f0dc9a" : seen ? chColor : "#54777d"}"
        font-family="Georgia, 'Times New Roman', serif">${escapeHtml(label)}</text>
      <text x="9" y="${NODE_IMG_H + 26}" font-size="9" letter-spacing="0.03em" fill="${
        isCur ? "#d8c283" : seen ? "#8fb3b8" : "#456a70"
      }" font-family="Georgia, 'Times New Roman', serif">${escapeHtml(subText)}</text>
      <rect class="fc-frame" x="0.5" y="0.5" width="${NODE_W - 1}" height="${NODE_H - 1}" rx="2" fill="none"
        stroke="${frame}" stroke-width="${isCur ? 2 : 1}"/>
      ${isCur ? `<rect x="1.5" y="1.5" width="${NODE_W - 3}" height="${NODE_H - 3}" rx="1.5"
        fill="none" stroke="#f0dc9a" stroke-opacity="0.18"/>` : ""}
    </g>`;
  }).join("");

  el.innerHTML = `
    <header class="screen-head"><div><h2>Flowchart</h2>
    <p class="screen-sub">Each card is the first frame of a scene. Seen scenes
    stay clear; ${hideUnrevealed
      ? "scenes you have not reached yet stay black."
      : "scenes you have not reached yet stay blurred and dark."}
    The lit path is where you have been; the gold outline is your current
    position.
    ${h.spoiler ? "Spoilers are on, so unvisited options are shown." : "Spoilers are off; unvisited options stay hidden."}</p></div></header>
    <div class="fc-wrap"><svg class="fc-svg" width="${g.width + pad * 2}" height="${g.height + pad * 2}">
      <defs>
        <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4"
          markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="#215a67"/>
        </marker>
        <clipPath id="fc-media-clip">
          <rect width="${NODE_W}" height="${NODE_IMG_H}" rx="2"/>
        </clipPath>
        <linearGradient id="fc-plate" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#12434e"/>
          <stop offset="1" stop-color="#061c25"/>
        </linearGradient>
        <linearGradient id="fc-media-scrim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.55" stop-color="#04161d" stop-opacity="0"/>
          <stop offset="1" stop-color="#04161d" stop-opacity="0.55"/>
        </linearGradient>
        <g id="fc-flake" fill="none" stroke-linecap="round">
          <path d="M0 -11V11M-9.5 -5.5L9.5 5.5M-9.5 5.5L9.5 -5.5"/>
          <path d="M0 -11l-3 -3M0 -11l3 -3M0 11l-3 3M0 11l3 3M-9.5 -5.5l-4 -1M-9.5 -5.5l-1 -4M9.5 5.5l4 1M9.5 5.5l1 4M-9.5 5.5l-4 1M-9.5 5.5l-1 4M9.5 -5.5l4 -1M9.5 -5.5l1 -4"/>
        </g>
      </defs>
      <g transform="translate(${pad},${pad})">${edgesSvg}${nodesSvg}</g>
    </svg></div>
    <div class="fc-detail" id="fc-detail">Select a node to see its choices and route evidence.</div>
    <button class="back" data-back>← Back</button>`;

  // Lazy scene frames: the chart can hold 170+ cards and each frame is a
  // full-size PNG. Only load cards near the .fc-wrap scroll viewport; the
  // node's chart y is precomputed (data-y), so a scroll pass is a numeric
  // compare, not a layout read per card. A scroll listener on the scroller
  // dies with the screen element — no detached observer targets retained.
  // A window resize hook covers the 64vh viewport growing without a scroll
  // event; only one is alive at a time and it removes itself once its chart
  // is detached (see fcResizeHook).
  const wrap = el.querySelector(".fc-wrap") as HTMLElement | null;
  const frames = [...el.querySelectorAll<SVGImageElement>("image[data-src]")];
  let pending = frames.length;
  const paintFrame = (img: SVGImageElement) => {
    const src = img.dataset.src;
    if (!src) return;
    img.setAttribute("href", src);
    delete img.dataset.src;
    pending -= 1;
  };
  if (!wrap) {
    frames.forEach(paintFrame);
  } else {
    const plates = frames.map((img) => ({
      img,
      y: pad + Number((img.closest(".fc-node") as SVGGElement | null)?.dataset.y ?? 0),
    }));
    const loadVisible = () => {
      if (pending <= 0) return;
      const top = wrap.scrollTop - 600;
      const bottom = wrap.scrollTop + wrap.clientHeight + 600;
      for (const plate of plates) {
        if (!plate.img.dataset.src) continue;
        if (plate.y + NODE_H >= top && plate.y <= bottom) paintFrame(plate.img);
      }
    };
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        loadVisible();
      });
    };
    wrap.addEventListener("scroll", schedule, { passive: true });
    // Drop the previous chart's resize hook, if any; its element is gone.
    fcResizeHook?.();
    fcResizeHook = null;
    const detach = () => {
      window.removeEventListener("resize", onResize);
      if (fcResizeHook === detach) fcResizeHook = null;
    };
    const onResize = () => {
      if (!wrap.isConnected) {
        detach();
        return;
      }
      schedule();
    };
    window.addEventListener("resize", onResize, { passive: true });
    fcResizeHook = detach;
    loadVisible();
    // The auto-scroll below centers the current card; run once more there.
    requestAnimationFrame(loadVisible);
  }

  el.querySelectorAll(".fc-node").forEach((nd) => {
    const open = () => showDetail(
      el.querySelector("#fc-detail") as HTMLElement,
      (nd as HTMLElement).dataset.node!,
      h,
      g,
      visited,
    );
    nd.addEventListener("click", open);
    nd.addEventListener("keydown", (ev) => {
      const ke = ev as KeyboardEvent;
      if (ke.key === "Enter" || ke.key === " " || ke.key === "Spacebar") {
        ke.preventDefault();
        open();
      }
    });
  });
  // Auto-scroll so the current position is in view.
  const curPos = g.pos[cur];
  if (wrap && curPos) {
    wrap.scrollLeft = Math.max(0, curPos.x - wrap.clientWidth / 2);
    wrap.scrollTop = Math.max(0, curPos.y - wrap.clientHeight / 2);
  }
  el.querySelector("[data-back]")?.addEventListener("click", h.onBack);
}

function showDetail(
  box: HTMLElement,
  script: string,
  h: FlowHooks,
  g: ChartGraph,
  visited: Set<string>,
): void {
  const nodes = h.flow.nodes.filter((n) => n.engine.script === script);
  const outs = g.edges.filter((e) => e.from === script);
  const term = h.terminals[script];
  const seenScript = visited.has(script);
  const headLabel = sceneLabel(script, h.flow, {
    spoiler: h.spoiler, dev: h.dev, visited: seenScript,
    bnr: h.bnr?.recs?.[script],
  });
  const parts: string[] = [
    `<div class="fc-detail-h">${h.dev ? `<code>${escapeHtml(script)}</code>` : `<b>${escapeHtml(headLabel)}</b>`} <span class="dim">${g.depth[script] !== undefined ? `depth ${g.depth[script]}` : ""}</span></div>`,
  ];
  if (term?.action === "end" && (seenScript || h.spoiler || h.dev)) {
    parts.push(`<div class="opt">Ending: ${escapeHtml(term.ending ?? "?")}</div>`);
  }
  if (term?.action === "chain" && (h.dev || seenScript || h.spoiler)) {
    const toLabel = sceneLabel(term.to, h.flow, {
      spoiler: h.spoiler, dev: h.dev, visited: visited.has(term.to),
      bnr: h.bnr?.recs?.[term.to],
    });
    parts.push(`<div class="opt">Chains to <code>${escapeHtml(toLabel)}</code></div>`);
  }
  for (const n of nodes) {
    parts.push(`<div class="opt"><span class="date">${escapeHtml(displayDate(n.date, !!h.dev) ?? "")}</span>${
      h.dev ? ` <code>${escapeHtml(n.id)}</code> ${n.status === "EXPERT_SOURCED" ? '<span class="badge ok">sourced</span>' : '<span class="badge warn">unverified</span>'}` : ""
    }</div>`);
    for (const o of n.options) {
      const picked = h.save.picks[n.id] === o.n;
      const seen = optionSeen(h.save, h.profile, n.id, o.n, h.spoiler);
      const label = seen ? escapeHtml(plainText(o.text)) : "Not seen yet";
      const gotoLabel = o.goto && seen
        ? sceneLabel(o.goto, h.flow, {
          spoiler: h.spoiler, dev: h.dev, visited: visited.has(o.goto),
          bnr: h.bnr?.recs?.[o.goto],
        })
        : "";
      parts.push(`<div class="opt${picked ? " chosen" : ""}"><b>${o.n}.</b> ${label}${
        gotoLabel ? ` <span class="dim">→ ${escapeHtml(gotoLabel)}</span>` : ""
      }</div>`);
    }
  }
  if (outs.length) {
    parts.push(`<div class="dim note">Links out</div>`);
    for (const e of outs) {
      const toLabel = sceneLabel(e.to, h.flow, {
        spoiler: h.spoiler, dev: h.dev, visited: visited.has(e.to),
        bnr: h.bnr?.recs?.[e.to],
      });
      parts.push(`<div class="opt dim">→ ${escapeHtml(toLabel)}${h.dev && e.kind !== "link" ? ` (${escapeHtml(e.kind)})` : ""}</div>`);
    }
  }
  if (!nodes.length && !outs.length && !term) parts.push(`<div class="dim note">No decoded choices or links here.</div>`);
  if (h.dev && h.onJump) {
    parts.push(`<button class="choice-btn" id="fc-jump">Jump to <code>${escapeHtml(script)}</code></button>`);
  }
  box.innerHTML = parts.join("");
  box.querySelector("#fc-jump")?.addEventListener("click", () => h.onJump!(script));
  box.classList.remove("dim");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Clip a card footer line: SVG text neither wraps nor clips itself, so a
 * long dev annotation would spill past the 144px frame. */
function clipCardText(s: string, max = 30): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}