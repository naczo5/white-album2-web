// Flowchart screen: engine-derived route graph (tsukiweb-style node chart).
// Nodes = scenario scripts, edges = decoded script links + terminal chains
// (+ spine continuation when a script has no decoded link). Layout is a
// pure function (test-pinned): BFS depth columns, barycenter row ordering.

import { chapterOfScript, type Spine } from "../engine/router";
import { displayDate, plainText } from "../engine/text";
import type { CfgData, CfgOp, FlowData, LinkSite, SaveData, SysProfile, TerminalsData } from "../engine/types";

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
export const NODE_H = 38;
const GAP_X = 46;
const GAP_Y = 14;

const CHAPTER_SHORT: Record<string, string> = {
  intro: "Introductory",
  closing: "Closing",
  coda: "Coda",
  special: "Special",
};

/** Story-facing scene label for flowchart nodes, save slots, and Continue.
 * Dev mode surfaces raw script IDs; player mode hides them behind chapter,
 * story date (from flow.json), and `???` when neither visited nor spoiled. */
export function sceneLabel(
  script: string,
  flow: FlowData | null | undefined,
  opts: { spoiler?: boolean; dev?: boolean; visited?: boolean } = {},
): string {
  if (opts.dev) return script;
  if (script.startsWith("demo")) return "Demo";
  const ch = CHAPTER_SHORT[chapterOfScript(script)] ?? "Special";
  if (!opts.visited && !opts.spoiler) return `${ch} · ???`;
  const rawDate = flow?.nodes.find((n) => n.engine.script === script && n.date)?.date;
  const date = displayDate(rawDate, false);
  return date ? `${ch} · ${date}` : ch;
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

export function renderFlowchart(el: HTMLElement, h: FlowHooks): void {
  const g = buildChartGraph(
    [...new Set([...h.spine.order])],
    h.spine, h.links, h.terminals, h.cfg,
  );
  const visited = chartVisited(h.save, h.profile);
  const cur = h.save.position.script;
  const choicesByScript = new Map<string, typeof h.flow.nodes>();
  for (const n of h.flow.nodes) {
    (choicesByScript.get(n.engine.script) ?? choicesByScript.set(n.engine.script, []).get(n.engine.script)!).push(n);
  }

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
    const label = sceneLabel(n.id, h.flow, { spoiler: h.spoiler, dev: h.dev, visited: seen });
    const sub = h.dev
      ? `${displayDate(choices.find((c) => c.date)?.date, true) || n.chapter}${nChoices ? ` · ${nChoices} choice${nChoices === 1 ? "" : "s"}` : ""}`
      : `${nChoices ? `${nChoices} choice${nChoices === 1 ? "" : "s"}` : seen ? "Visited" : "Unvisited"}`;
    return `<g transform="translate(${p.x},${p.y})" data-node="${escapeAttr(n.id)}"
      class="fc-node" tabindex="0" role="button" aria-label="${escapeAttr(label)}">
      <rect width="${NODE_W}" height="${NODE_H}" rx="2"
        fill="${seen ? "#0f3d49" : "#082630"}"
        stroke="${isCur ? "#f0dc9a" : seen ? "#2d7d87" : "#17434f"}"
        stroke-width="${isCur ? 2 : 1}"/>
      ${isCur ? `<rect width="${NODE_W}" height="${NODE_H}" rx="2" fill="#f0dc9a" opacity="0.1"/>` : ""}
      <text x="9" y="16" font-size="12" fill="${chColor}" font-family="Georgia, 'Times New Roman', serif">${escapeHtml(label)}</text>
      <text x="9" y="30" font-size="10" fill="${
        seen ? "#8fb3b8" : "#4f7279"
      }" font-family="Georgia, 'Times New Roman', serif">${escapeHtml(sub)}</text>
    </g>`;
  }).join("");

  el.innerHTML = `
    <header class="screen-head"><div><h2>Flowchart</h2>
    <p class="screen-sub">Each box is a scenario scene. The lit path is where
    you have been; the gold outline is your current position.
    ${h.spoiler ? "Spoilers are on, so unvisited options are shown." : "Spoilers are off; unvisited options stay hidden."}</p></div></header>
    <div class="fc-wrap"><svg class="fc-svg" width="${g.width + pad * 2}" height="${g.height + pad * 2}">
      <defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4"
        markerWidth="6" markerHeight="6" orient="auto">
        <path d="M0,0 L8,4 L0,8 z" fill="#215a67"/>
      </marker></defs>
      <g transform="translate(${pad},${pad})">${edgesSvg}${nodesSvg}</g>
    </svg></div>
    <div class="fc-detail" id="fc-detail">Select a node to see its choices and route evidence.</div>
    <button class="back" data-back>← Back</button>`;

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
  const wrap = el.querySelector(".fc-wrap") as HTMLElement | null;
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
  const headLabel = sceneLabel(script, h.flow, { spoiler: h.spoiler, dev: h.dev, visited: seenScript });
  const parts: string[] = [
    `<div class="fc-detail-h">${h.dev ? `<code>${escapeHtml(script)}</code>` : `<b>${escapeHtml(headLabel)}</b>`} <span class="dim">${g.depth[script] !== undefined ? `depth ${g.depth[script]}` : ""}</span></div>`,
  ];
  if (term?.action === "end" && (seenScript || h.spoiler || h.dev)) {
    parts.push(`<div class="opt">Ending: ${escapeHtml(term.ending ?? "?")}</div>`);
  }
  if (term?.action === "chain" && (h.dev || seenScript || h.spoiler)) {
    const toLabel = sceneLabel(term.to, h.flow, { spoiler: h.spoiler, dev: h.dev, visited: visited.has(term.to) });
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
        ? sceneLabel(o.goto, h.flow, { spoiler: h.spoiler, dev: h.dev, visited: visited.has(o.goto) })
        : "";
      parts.push(`<div class="opt${picked ? " chosen" : ""}"><b>${o.n}.</b> ${label}${
        gotoLabel ? ` <span class="dim">→ ${escapeHtml(gotoLabel)}</span>` : ""
      }</div>`);
    }
  }
  if (outs.length) {
    parts.push(`<div class="dim note">Links out</div>`);
    for (const e of outs) {
      const toLabel = sceneLabel(e.to, h.flow, { spoiler: h.spoiler, dev: h.dev, visited: visited.has(e.to) });
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}