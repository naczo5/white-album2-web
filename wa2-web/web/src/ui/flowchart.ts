// Flowchart screen: engine-derived choice graph with progress + spoilers.

import { chapterOfScript } from "../engine/router";
import { plainText } from "../engine/text";
import type { FlowData, SaveData } from "../engine/types";

export interface FlowHooks {
  flow: FlowData;
  save: SaveData;
  spoiler: boolean;
  onBack(): void;
}

export function renderFlowchart(el: HTMLElement, h: FlowHooks): void {
  const groups = new Map<string, typeof h.flow.nodes>();
  for (const n of h.flow.nodes) {
    const ch = chapterOfScript(n.engine.script);
    if (!groups.has(ch)) groups.set(ch, []);
    groups.get(ch)!.push(n);
  }
  let html = `<div class="screen-head"><h2>Flowchart</h2>
    <div class="dim">Nodes come from the engine scripts; badges show verification.
    ${h.spoiler ? "Spoilers ON." : "Spoilers OFF - unvisited options hidden."}</div></div>`;
  for (const [ch, nodes] of groups) {
    html += `<h3 class="chart-ch">${ch}</h3><ol class="chart">`;
    for (const n of nodes) {
      const picked = h.save.picks[n.id];
      const badge = n.status === "EXPERT_SOURCED"
        ? `<span class="badge ok" title="Sourced from walkthrough consensus + engine text">sourced</span>`
        : `<span class="badge warn" title="Needs in-game verification before trusting">unverified</span>`;
      html += `<li class="node${picked ? " picked" : ""}" data-node="${n.id}">
        <div class="node-head"><code>${n.engine.script}:${n.engine.event}</code>
        ${n.date ? `<span class="date">${escapeHtml(n.date)}</span>` : ""} ${badge}</div>`;
      for (const o of n.options) {
        const seen = picked === o.n || h.spoiler;
        const label = seen ? escapeHtml(plainText(o.text)) : "??? (unvisited)";
        const dest = o.play ?? o.goto;
        const destShown = seen && dest ? ` <span class="dim">→ ${escapeHtml(dest)}</span>` : "";
        html += `<div class="opt${picked === o.n ? " chosen" : ""}">
          <b>${o.n}.</b> ${label}${destShown}
        </div>`;
      }
      if (n.note) html += `<div class="dim note">${escapeHtml(n.note)}</div>`;
      html += `</li>`;
    }
    html += `</ol>`;
  }
  html += `<button class="back" data-back>← Back</button>`;
  el.innerHTML = html;
  el.querySelector("[data-back]")?.addEventListener("click", h.onBack);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
