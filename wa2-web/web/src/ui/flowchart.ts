// Flowchart screen: engine-derived route graph (tsukiweb-style node chart).
// Nodes = scenario scripts, edges = decoded script links + terminal chains
// (+ spine continuation when a script has no decoded link). Layout is a
// pure function (test-pinned): BFS depth columns, barycenter row ordering.

import { chapterOfScript, type Spine } from "../engine/router";
import { plainText } from "../engine/text";
import type { FlowData, LinkSite, SaveData, TerminalsData } from "../engine/types";

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

export const NODE_W = 128;
export const NODE_H = 34;
const GAP_X = 46;
const GAP_Y = 14;
const ROOT = "1002";

/** Build the route graph: reachable scripts from the IC root via decoded
 * links + terminal chains; spine edges fill scripts with no decoded exit. */
export function buildChartGraph(
  scripts: string[],
  spine: Spine,
  links: LinkSite[],
  terminals: TerminalsData["terminals"],
): ChartGraph {
  const out = new Map<string, { to: string; kind: ChartGraph["edges"][number]["kind"] }[]>();
  const add = (from: string, to: string, kind: ChartGraph["edges"][number]["kind"]) => {
    if (from === to) return;
    const list = out.get(from) ?? [];
    if (!list.some((e) => e.to === to)) list.push({ to, kind });
    out.set(from, list);
  };
  for (const l of links) {
    for (const t of l.targets) add(l.engine.script, t, "link");
  }
  for (const [sc, t] of Object.entries(terminals)) {
    if (t.action === "chain") add(sc, t.to, "chain");
  }
  for (const [sc, nxt] of Object.entries(spine.next)) {
    if (nxt) add(sc, nxt, "spine");
  }

  // BFS from the root over link/chain edges only (spine edges are fillers
  // that would pull every same-chapter script into depth order, wrong for
  // branch columns — but scripts reached ONLY via spine still belong).
  const depth: Record<string, number> = { [ROOT]: 0 };
  const queue = [ROOT];
  const reached = new Set([ROOT]);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of out.get(cur) ?? []) {
      if (e.kind === "spine") continue;
      if (reached.has(e.to)) continue;
      reached.add(e.to);
      depth[e.to] = depth[cur]! + 1;
      queue.push(e.to);
    }
  }
  // Spine-only scripts: attach at the depth that makes their incoming
  // spine edge drawable (parent depth + 1 if parent known, else skip).
  for (const [sc, nxt] of Object.entries(spine.next)) {
    if (!nxt || reached.has(nxt) || !reached.has(sc)) continue;
    reached.add(nxt);
    depth[nxt] = (depth[sc] ?? 0) + 1;
  }
  // terminals-only targets missed above (chain treated as link already).
  for (const l of links) {
    if (!reached.has(l.engine.script)) continue;
    for (const t of l.targets) {
      if (!reached.has(t)) {
        reached.add(t);
        depth[t] = (depth[l.engine.script] ?? 0) + 1;
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

  // Columns: group by depth; order within column by first-parent barycenter.
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
  const pos: ChartGraph["pos"] = {};
  let height = 0;
  for (const d of orderedDepths) {
    const col = cols.get(d)!;
    col.forEach((id, i) => {
      pos[id] = { x: d * (NODE_W + GAP_X), y: i * (NODE_H + GAP_Y) };
    });
    height = Math.max(height, col.length * (NODE_H + GAP_Y) - GAP_Y);
  }
  const maxDepth = orderedDepths[orderedDepths.length - 1] ?? 0;
  return {
    nodes, edges, depth, pos,
    width: (maxDepth + 1) * (NODE_W + GAP_X) - GAP_X,
    height,
  };
}

export interface FlowHooks {
  flow: FlowData;
  save: SaveData;
  spine: Spine;
  links: LinkSite[];
  terminals: TerminalsData["terminals"];
  spoiler: boolean;
  /** Dev mode: show a scene-jump button in the node detail panel. */
  dev?: boolean;
  onJump?(script: string): void;
  onBack(): void;
}

export function renderFlowchart(el: HTMLElement, h: FlowHooks): void {
  const g = buildChartGraph(
    [...new Set([...h.spine.order])],
    h.spine, h.links, h.terminals,
  );
  const visited = new Set(h.save.visited);
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
    const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
    const x2 = b.x, y2 = b.y + NODE_H / 2;
    const lit = visited.has(e.to) && visited.has(e.from);
    const mx = (x1 + x2) / 2;
    const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
    return `<path d="${d}" fill="none" stroke="${lit ? "var(--accent)" : "#26334a"}"
      stroke-width="${lit ? 2 : 1}" opacity="${lit ? 0.8 : 0.7}" ${
      e.kind === "chain" ? 'stroke-dasharray="4 3"' : ""
    } marker-end="url(#arrow)"/>`;
  }).join("");

  const nodesSvg = g.nodes.map((n) => {
    const p = g.pos[n.id]!;
    const isCur = n.id === cur;
    const seen = visited.has(n.id);
    const chColor = {
      intro: "#7fb4ff", closing: "#9fe0ae", coda: "#e8c87f", special: "#b9c7e4",
    }[n.chapter] ?? "#9aa3b2";
    const choices = choicesByScript.get(n.id) ?? [];
    const nChoices = choices.length;
    const date = choices.find((c) => c.date)?.date ?? n.chapter;
    return `<g transform="translate(${p.x},${p.y})" data-node="${n.id}" class="fc-node">
      <rect width="${NODE_W}" height="${NODE_H}" rx="5"
        fill="${seen ? "#1d2a3d" : "#131c2b"}"
        stroke="${isCur ? "var(--accent)" : seen ? "#3d5273" : "#26334a"}"
        stroke-width="${isCur ? 2.5 : 1}"/>
      ${isCur ? `<rect width="${NODE_W}" height="${NODE_H}" rx="5" fill="var(--accent)" opacity="0.12"/>` : ""}
      <text x="8" y="14" font-size="11" fill="${chColor}" font-family="monospace">${n.id}</text>
      <text x="8" y="27" font-size="9.5" fill="${
        seen ? "#9aa3b2" : "#5d6b80"
      }">${escapeHtml(date)}${nChoices ? ` · ${nChoices}✕` : ""}</text>
    </g>`;
  }).join("");

  el.innerHTML = `
    <div class="screen-head"><h2>Flowchart</h2>
    <div class="dim">Route graph from the decoded engine links. Boxes are
    scenario scripts; ● marks choice points. Highlighted = visited path.
    ${h.spoiler ? "Spoilers ON." : "Spoilers OFF - unvisited options hidden."}</div></div>
    <div class="fc-wrap"><svg class="fc-svg" width="${g.width + pad * 2}" height="${g.height + pad * 2}">
      <defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4"
        markerWidth="6" markerHeight="6" orient="auto">
        <path d="M0,0 L8,4 L0,8 z" fill="#26334a"/>
      </marker></defs>
      <g transform="translate(${pad},${pad})">${edgesSvg}${nodesSvg}</g>
    </svg></div>
    <div class="fc-detail dim" id="fc-detail">Click a node for its choices and link evidence.</div>
    <button class="back" data-back>← Back</button>`;

  el.querySelectorAll(".fc-node").forEach((nd) =>
    nd.addEventListener("click", () => {
      showDetail(el.querySelector("#fc-detail") as HTMLElement, (nd as HTMLElement).dataset.node!, h, g);
    }),
  );
  // Auto-scroll so the current position is in view.
  const wrap = el.querySelector(".fc-wrap") as HTMLElement | null;
  const curPos = g.pos[cur];
  if (wrap && curPos) {
    wrap.scrollLeft = Math.max(0, curPos.x - wrap.clientWidth / 2);
    wrap.scrollTop = Math.max(0, curPos.y - wrap.clientHeight / 2);
  }
  el.querySelector("[data-back]")?.addEventListener("click", h.onBack);
}

function showDetail(box: HTMLElement, script: string, h: FlowHooks, g: ChartGraph): void {
  const nodes = h.flow.nodes.filter((n) => n.engine.script === script);
  const outs = g.edges.filter((e) => e.from === script);
  const term = h.terminals[script];
  const parts: string[] = [`<div class="fc-detail-h"><code>${script}</code> <span class="dim">${g.depth[script] !== undefined ? `depth ${g.depth[script]}` : ""}</span></div>`];
  if (term?.action === "end") parts.push(`<div class="opt">⏹ Ending: ${term.ending ?? "?"}</div>`);
  if (term?.action === "chain") parts.push(`<div class="opt">⇢ chains to <code>${term.to}</code></div>`);
  for (const n of nodes) {
    parts.push(`<div class="opt"><span class="date">${n.date ?? ""}</span> <code>${n.id}</code>
      ${n.status === "EXPERT_SOURCED" ? '<span class="badge ok">sourced</span>' : '<span class="badge warn">unverified</span>'}</div>`);
    for (const o of n.options) {
      const picked = h.save.picks[n.id] === o.n;
      const seen = picked || h.spoiler;
      const label = seen ? escapeHtml(plainText(o.text)) : "??? (unvisited)";
      parts.push(`<div class="opt${picked ? " chosen" : ""}"><b>${o.n}.</b> ${label}${
        o.goto && seen ? ` <span class="dim">→ ${o.goto}</span>` : ""
      }</div>`);
    }
  }
  if (outs.length) {
    parts.push(`<div class="dim note">links out:</div>`);
    for (const e of outs) parts.push(`<div class="opt dim">→ ${e.to}${e.kind !== "link" ? ` (${e.kind})` : ""}</div>`);
  }
  if (!nodes.length && !outs.length && !term) parts.push(`<div class="dim note">No decoded choices or links.</div>`);
  if (h.dev && h.onJump) {
    parts.push(`<button class="choice-btn" id="fc-jump">▶ Jump to <code>${script}</code></button>`);
  }
  box.innerHTML = parts.join("");
  box.querySelector("#fc-jump")?.addEventListener("click", () => h.onJump!(script));
  box.classList.remove("dim");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}