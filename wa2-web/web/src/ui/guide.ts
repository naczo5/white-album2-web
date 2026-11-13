// Guide screen: endings, recommended order, per-route pick tables.

import { chapterOfScript } from "../engine/router";
import type { FlowData, SaveData, SysProfile } from "../engine/types";
import { displayDate, plainText } from "../engine/text";
import { optionSeen } from "./flowchart";

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

/** Ending ids the guide marks as seen: this run's set unioned with the
 * global profile (an imported `Sys.sav`). */
export function guideEndings(save: SaveData, profile?: SysProfile | null): Set<string> {
  const got = new Set(save.endings);
  for (const id of profile?.endings ?? []) got.add(id);
  return got;
}

/** Whether a choice option's text may be shown: chosen in this run, seen in
 * an imported choice bitmask, or spoilers are on. */
export function guideOptionSeen(
  save: SaveData,
  profile: SysProfile | null | undefined,
  nodeId: string,
  n: number,
  spoiler: boolean,
): boolean {
  return optionSeen(save, profile, nodeId, n, spoiler);
}

export interface GuideOptions {
  /** Global progress from an imported `Sys.sav` (endings + seen choices). */
  profile?: SysProfile | null;
  /** Dev mode: show the raw flow annotation (`12/24 ROUTER`) instead of
   * the clean story date the player should read. */
  dev?: boolean;
}

export function renderGuide(
  el: HTMLElement,
  flow: FlowData,
  guide: GuideData,
  save: SaveData,
  spoiler: boolean,
  onBack: () => void,
  /** Profile and dev flag. A bare `SysProfile` is still accepted so older
   * callers (and tests) keep working. */
  options: GuideOptions | SysProfile | null = null,
): void {
  const opts: GuideOptions = options && "version" in options
    ? { profile: options as SysProfile }
    : (options as GuideOptions | null) ?? {};
  const profile = opts.profile ?? null;
  const dev = !!opts.dev;
  const gotEndings = guideEndings(save, profile);
  let html = `<header class="screen-head"><div><h2>Guide</h2>
    <p class="screen-sub">Route tables join the engine's choices to walkthrough
    research. Rows marked unverified still need a play-test before you trust them.
    ${spoiler ? "Spoilers are on." : "Spoilers are off, so unvisited options stay hidden."}</p></div></header>`;

  if (guide.recommended_order) {
    const names = new Map(guide.endings.map((e) => [e.id, e.name]));
    html += `<h3>Recommended order</h3><ol class="rec">` +
      guide.recommended_order.map((id) => `<li>${escapeHtml(names.get(id) ?? id)}${gotEndings.has(id) ? ' <span class="badge ok">seen</span>' : ""}</li>`).join("") +
      `</ol>`;
  }

  html += `<h3>Endings</h3><ol class="endings">`;
  for (const e of guide.endings) {
    const got = gotEndings.has(e.id);
    const badgeCls = e.status === "EXPERT_SOURCED" ? "ok" : "warn";
    const badgeTitle = e.status === "EXPERT_SOURCED"
      ? "Sourced from walkthrough consensus + engine text"
      : "Needs in-game verification before trusting";
    html += `<li class="ending${got ? " got" : ""}">
      <b>${escapeHtml(e.name)}</b> ${got ? '<span class="badge ok">seen</span>' : ""}
      <span class="badge ${badgeCls}" title="${badgeTitle}">${e.status === "EXPERT_SOURCED" ? "sourced" : "unverified"}</span>
      <div class="dim">${escapeHtml(e.unlock)}</div></li>`;
  }
  html += `</ol>`;

  // Per-route pick tables, grouped by chapter from engine flow nodes.
  const chapterName: Record<string, string> = {
    demo: "Demo",
    intro: "Introductory chapter",
    closing: "Closing chapter",
    coda: "Coda",
    special: "Special",
  };
  const groups = new Map<string, typeof flow.nodes>();
  for (const n of flow.nodes) {
    const ch = n.engine.script.startsWith("demo") ? "demo" : chapterOfScript(n.engine.script);
    if (!groups.has(ch)) groups.set(ch, []);
    groups.get(ch)!.push(n);
  }
  for (const [ch, nodes] of groups) {
    html += `<h3>${chapterName[ch] ?? "Special"} choices</h3><ol class="chart">`;
    for (const n of nodes) {
      const picked = save.picks[n.id];
      // `displayDate` strips the annotator's flow notes (`12/24 ROUTER`,
      // `1/29 FINAL ROUTER`, `12/18~19? (drifts)`) unless dev mode is on;
      // a standalone keyword is mechanics, not a scene date.
      const date = displayDate(n.date, dev);
      html += `<li class="node${picked ? " picked" : ""}"><div class="node-head"><code>${escapeHtml(n.engine.script)}:${n.engine.event}</code>
        ${date ? `<span class="date">${escapeHtml(date)}</span>` : ""}</div>`;
      for (const o of n.options) {
        const chosen = picked === o.n;
        const seen = guideOptionSeen(save, profile, n.id, o.n, spoiler);
        html += `<div class="opt${chosen ? " chosen" : ""}"><b>${o.n}.</b> ${
          seen ? escapeHtml(plainText(o.text)) : "Not seen yet"}</div>`;
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
