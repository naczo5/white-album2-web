// Guide screen: endings, recommended order, per-route pick tables.

import { chapterOfScript } from "../engine/router";
import type { FlowData, SaveData } from "../engine/types";
import { plainText } from "../engine/text";

export interface GuideData {
  endings: {
    id: string;
    chapter: string;
    name: string;
    unlock: string;
    epilogue?: boolean;
    status: string;
  }[];
  recommended_order?: string[];
}

export function renderGuide(
  el: HTMLElement,
  flow: FlowData,
  guide: GuideData,
  save: SaveData,
  spoiler: boolean,
  onBack: () => void,
): void {
  let html = `<div class="screen-head"><h2>Guide</h2>
    <div class="dim">Route tables join engine choices to walkthrough research.
    Unverified rows are marked - see docs/QA.md before trusting them.${spoiler ? "" : " Spoilers OFF: unvisited options hidden."}</div></div>`;

  if (guide.recommended_order) {
    const names = new Map(guide.endings.map((e) => [e.id, e.name]));
    html += `<h3>Recommended order</h3><ol class="rec">` +
      guide.recommended_order.map((id) => `<li>${escapeHtml(names.get(id) ?? id)}${save.endings.includes(id) ? " ✓" : ""}</li>`).join("") +
      `</ol>`;
  }

  html += `<h3>Endings</h3><ol class="endings">`;
  for (const e of guide.endings) {
    const got = save.endings.includes(e.id);
    const badgeCls = e.status === "EXPERT_SOURCED" ? "ok" : "warn";
    const badgeTitle = e.status === "EXPERT_SOURCED"
      ? "Sourced from walkthrough consensus + engine text"
      : "Needs in-game verification before trusting";
    html += `<li class="ending${got ? " got" : ""}">
      <b>${escapeHtml(e.name)}</b> ${got ? "✓" : ""}
      <span class="badge ${badgeCls}" title="${badgeTitle}">${escapeHtml(e.status)}</span>
      <div class="dim">${escapeHtml(e.unlock)}</div></li>`;
  }
  html += `</ol>`;

  // Per-route pick tables, grouped by chapter from engine flow nodes.
  const groups = new Map<string, typeof flow.nodes>();
  for (const n of flow.nodes) {
    const ch = chapterOfScript(n.engine.script);
    if (!groups.has(ch)) groups.set(ch, []);
    groups.get(ch)!.push(n);
  }
  for (const [ch, nodes] of groups) {
    html += `<h3>Route choices — ${ch}</h3><ol class="chart">`;
    for (const n of nodes) {
      const picked = save.picks[n.id];
      html += `<li class="node${picked ? " picked" : ""}"><div class="node-head"><code>${n.engine.script}:${n.engine.event}</code>
        ${n.date ? `<span class="date">${escapeHtml(n.date)}</span>` : ""}</div>`;
      for (const o of n.options) {
        const seen = picked === o.n || spoiler;
        html += `<div class="opt${picked === o.n ? " chosen" : ""}"><b>${o.n}.</b> ${
          seen ? escapeHtml(plainText(o.text)) : "??? (unvisited)"}</div>`;
      }
      html += `</li>`;
    }
    html += `</ol>`;
  }
  html += `<button class="back" data-back>← Back</button>`;
  el.innerHTML = html;
  el.querySelector("[data-back]")?.addEventListener("click", onBack);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
