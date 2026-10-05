// Reader screen: dialogue/narration/choices/stage + backlog + quick menu.

import { bgmUrl, imageUrl, movieUrl, voiceUrl } from "../engine/assets";
import { Router, chapterOfScript } from "../engine/router";
import { plainText, renderText, spanize } from "../engine/text";
import type { Position, SaveData, ScenarioEvent } from "../engine/types";
import { writeAutosave } from "../engine/save";

export interface ReaderSettings {
  textSpeed: number; // chars per second, 0 = instant
  autoDelay: number; // ms after line completes, 0 = off
  voiceVol: number; // 0..1
}

let autoTimer: number | null = null;
let typeTimer: number | null = null;

function clearTimers(): void {
  if (autoTimer !== null) {
    clearTimeout(autoTimer);
    autoTimer = null;
  }
  if (typeTimer !== null) {
    clearInterval(typeTimer);
    typeTimer = null;
  }
}

// .AMP color-grade LUTs (sepia/nega/night/...) mapped to CSS filters.
// Unknown filters render unfiltered (logged once in console).
const FILTER_CSS: Record<string, string> = {
  sepia: "sepia(1)",
  sepia2: "sepia(0.7)",
  nega: "invert(1)",
  night: "brightness(0.65) saturate(0.8)",
  evening: "sepia(0.45) hue-rotate(-15deg)",
  indoor: "sepia(0.2)",
  blue: "hue-rotate(190deg) saturate(0.7)",
  blue2: "hue-rotate(190deg) saturate(0.5)",
  green: "hue-rotate(90deg) saturate(0.6)",
  red: "hue-rotate(-50deg) saturate(0.8)",
};

export interface ReaderHooks {
  router: Router;
  save: SaveData;
  settings: ReaderSettings;
  skipping: boolean;
  onChange(): void;
  open(screen: string): void;
  notify(msg: string): void;
}

export function renderReader(el: HTMLElement, h: ReaderHooks): void {
  clearTimers();
  const { router, save } = h;
  const pos = save.position;
  const ev = router.at(pos);
  const sc = router.scripts.get(pos.script);

  const total = sc ? sc.events.length : 1;
  const pct = sc
    ? Math.max(0, Math.min(100, Math.round((pos.event / total) * 100)))
    : 0;
  const where = sc
    ? `${chapterOfScript(pos.script)} · ${pos.script} · ${pct}%`
    : `unknown position ${pos.script}:${pos.event}`;

  el.innerHTML = `
    <div class="stage" id="stage"></div>
    <div class="hud">
      <span>${where}</span>
      <span class="hud-btns">
        <button data-act="auto">${h.settings.autoDelay > 0 ? "⏸ Auto" : "▶ Auto"}</button>
        <button data-act="skip">${h.skipping ? "⏸ Skip" : "⏩ Skip"}</button>
        <button data-act="log">Log</button>
        <button data-act="saves">Save</button>
        <button data-act="flow">Chart</button>
        <button data-act="guide">Guide</button>
        <button data-act="title">Title</button>
      </span>
    </div>
    <div class="textbox" id="textbox"></div>
    <div class="choices" id="choices"></div>
    <div class="advance-hint" id="hint">click / space to continue</div>`;

  paintStage(el.querySelector("#stage") as HTMLElement, save);
  const box = el.querySelector("#textbox") as HTMLElement;
  const ch = el.querySelector("#choices") as HTMLElement;
  const hint = el.querySelector("#hint") as HTMLElement;

  el.querySelectorAll("[data-act]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      h.open((b as HTMLElement).dataset.act as string);
    }),
  );

  if (!ev) {
    // Past the end of a script: try to keep going (heals stale saves),
    // else offer wayfinding instead of stranding the player.
    const cont = router.advance(pos, save.flags);
    if (!cont.ended) {
      save.position = skipLatches(router, cont.pos, save.flags);
      pushLog(router, save);
      writeAutosave(localStorage, save);
      h.onChange();
      return;
    }
    box.innerHTML = `<div class="narrate">— End of ${escapeAttr(pos.script)} —</div>
      <div class="dim">The story continues in another file; use the chart or title.</div>`;
    hint.style.display = "none";
    const back = document.createElement("button");
    back.className = "choice-btn";
    back.textContent = "← Back to title";
    back.onclick = (e) => {
      e.stopPropagation();
      h.open("title");
    };
    ch.appendChild(back);
    el.onclick = null;
    return;
  }

  if (ev.t === "choice") {
    hint.style.display = "none";
    const node = router.flowNode(pos);
    box.innerHTML = `<div class="narrate choice-prompt">— Choose —${
      node?.date ? ` <span class="dim">${escapeAttr(node.date)}</span>` : ""
    }</div>`;
    for (const o of ev.options) {
      const gate = node?.gated?.[String(o.n)] ?? null;
      const b = document.createElement("button");
      b.className = "choice-btn";
      b.innerHTML = renderText(o.text) + (gate ? ` <span class="lock">🔒 ${escapeAttr(gate)}</span>` : "");
      b.onclick = (e) => {
        e.stopPropagation();
        cutVoice();
        const r = router.pick(pos, o.n, save.flags);
        save.picks[node?.id ?? `${pos.script}:${pos.event}`] = o.n;
        if (r.ending && !save.endings.includes(r.ending)) {
          save.endings.push(r.ending);
          h.notify(`Ending recorded: ${r.ending}`);
        }
        save.position = skipLatches(router, r.next, save.flags);
        pushLog(router, save);
        writeAutosave(localStorage, save);
        h.onChange();
      };
      ch.appendChild(b);
    }
    el.onclick = null;
    return;
  }

  if (ev.t === "say" || ev.t === "narrate") {
    playVoice(save, ev, h.settings.voiceVol);
    const cls = ev.t === "say" ? "say" : "narrate";
    const who = ev.t === "say" && ev.speaker
      ? `<div class="speaker">${escapeAttr(ev.speaker)}</div>` : "";
    const full = `${who}<div class="${cls}${ev.style === "whisper" ? " whisper" : ""}">${renderText(ev.text)}</div>`;
    const speed = h.skipping ? 0 : h.settings.textSpeed;
    if (speed > 0) {
      startTypewriter(box, full, ev.text, speed, () => scheduleAuto(h));
      el.onclick = () => {
        if (completeTypewriter(box, full)) return; // first click completes
        stepForward(h);
      };
    } else {
      box.innerHTML = full;
      el.onclick = () => stepForward(h);
      scheduleAuto(h);
    }
    return;
  }

  if (ev.t === "movie") {
    const url = movieUrl(ev.id);
    box.innerHTML = `<div class="narrate">▶ Movie <b>${escapeAttr(ev.id)}</b>${
      url ? "" : ' <span class="dim">(not installed - placeholder; install movies to watch)</span>'
    }</div>`;
    if (url) {
      const v = document.createElement("video");
      v.src = url;
      v.controls = true;
      v.className = "movie";
      v.addEventListener("click", (e) => e.stopPropagation());
      box.appendChild(v);
    }
    el.onclick = () => stepForward(h);
    return;
  }

  // Directives / latches auto-advance on click.
  const label =
    ev.t === "image" ? `🖼 ${ev.file} [${ev.layer ?? "?"}]` :
    ev.t === "filter" ? `◐ ${ev.file}` :
    ev.t === "anim" ? `✦ ${ev.file} [${ev.layer ?? "?"}]` :
    ev.t === "latch" ? `— ${ev.name} —` :
    ev.t === "jump" ? `⇢ ${ev.kind} ${ev.targets.join(" ")}` :
    ev.t === "layer" ? `▤ ${ev.layer}` : "…";
  box.innerHTML = `<div class="narrate dim">${escapeAttr(label)}</div>`;
  el.onclick = () => stepForward(h);
}

/** Progressive typewriter that preserves markup: reveal span by span. */
function startTypewriter(box: HTMLElement, full: string, raw: string, cps: number, onDone: () => void): void {
  if (typeTimer !== null) {
    clearInterval(typeTimer);
    typeTimer = null;
  }
  const spans = spanize(raw);
  const total = spans.reduce((a, s) => a + plainLength(s.text), 0);
  if (total === 0) {
    box.innerHTML = full;
    onDone();
    return;
  }
  const t0 = performance.now();
  const render = (shown: number) => {
    let rest = shown;
    let html = "";
    for (const sp of spans) {
      const len = plainLength(sp.text);
      const take = Math.max(0, Math.min(len, rest));
      rest -= take;
      html += renderSpanPartial(sp, take);
      if (rest <= 0 && take < len) break;
    }
    // speaker label + style wrapper match renderText() output shape
    box.innerHTML = html;
    void full;
  };
  box.dataset.typing = "1";
  const tick = () => {
    const shown = Math.floor(((performance.now() - t0) / 1000) * cps);
    if (shown >= total) {
      box.innerHTML = full;
      delete box.dataset.typing;
      typeTimer = null;
      onDone();
      return;
    }
    render(shown);
  };
  typeTimer = window.setInterval(tick, 30);
  tick();
}

function plainLength(s: string): number {
  return s.replace(/\\n/g, " ").length;
}

function renderSpanPartial(sp: { text: string; whisper?: boolean; ruby?: string }, take: number): string {
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let t = esc(sp.text.replace(/\\n/g, "<br>"));
  // cut visible chars (approximate on escaped text; fine for latin + JP)
  const cut = (html: string, n: number) => {
    let out = "", count = 0, i = 0;
    while (i < html.length && count < n) {
      if (html.startsWith("<br>", i)) { out += "<br>"; i += 4; continue; }
      if (html[i] === "&") {
        const semi = html.indexOf(";", i);
        if (semi > 0) { out += html.slice(i, semi + 1); i = semi + 1; count++; continue; }
      }
      out += html[i]; i++; count++;
    }
    return out;
  };
  t = cut(t, take);
  if (sp.ruby !== undefined) {
    t = `<ruby>${t}<rt>${esc(sp.ruby)}</rt></ruby>`;
  }
  return `<span${sp.whisper ? ' class="whisper"' : ""}>${t}</span>`;
}

/** Complete in-progress typing; returns true if it was typing. */
function completeTypewriter(box: HTMLElement, full: string): boolean {
  if (!box.dataset.typing) return false;
  if (typeTimer !== null) {
    clearInterval(typeTimer);
    typeTimer = null;
  }
  box.innerHTML = full;
  delete box.dataset.typing;
  return true;
}

/** Auto-advance scheduling (auto mode + skip mode). */
function scheduleAuto(h: ReaderHooks): void {
  clearAuto();
  const delay = h.skipping ? 120 : h.settings.autoDelay;
  if (delay <= 0) return;
  const ev = h.router.at(h.save.position);
  if (!ev || ev.t === "choice") return; // never auto-pick
  autoTimer = window.setTimeout(() => {
    autoTimer = null;
    if (h.skipping) {
      const cur = h.router.at(h.save.position);
      if (cur && cur.t !== "choice") stepForward(h);
      return;
    }
    stepForward(h);
  }, delay);
}

function clearAuto(): void {
  if (autoTimer !== null) {
    clearTimeout(autoTimer);
    autoTimer = null;
  }
}

export function stepForward(h: ReaderHooks): void {
  const { router, save } = h;
  cutVoice();
  const r = router.advance(save.position, save.flags);
  if (r.ended) {
    if (r.ending && !save.endings.includes(r.ending)) {
      save.endings.push(r.ending);
    }
    writeAutosave(localStorage, save);
    h.notify(r.ending ? `Ending reached: ${r.ending}` : "Route end reached.");
    h.open("title");
    return;
  }
  save.position = skipLatches(router, r.pos, save.flags);
  if (!save.visited.includes(save.position.script)) save.visited.push(save.position.script);
  pushLog(router, save);
  writeAutosave(localStorage, save);
  h.onChange();
}

/** Skip consecutive latch/directive events so the box shows text first. */
export function skipLatches(router: Router, pos: Position, flags: { aff: Record<string, number>; set: Record<string, boolean> }): Position {
  let p = { ...pos };
  for (let i = 0; i < 200; i++) {
    const ev = router.at(p);
    if (!ev) break;
    if (ev.t === "latch" || ev.t === "image" || ev.t === "filter" || ev.t === "bgm" || ev.t === "anim" || ev.t === "layer") {
      p = { script: p.script, event: p.event + 1 };
      continue;
    }
    if (ev.t === "jump") {
      const r = router.advance(p, flags);
      if (r.ended) break;
      if (r.pos.script === p.script && r.pos.event === p.event) break;
      p = r.pos;
      continue;
    }
    break;
  }
  return p;
}

export function pushLog(router: Router, save: SaveData): void {
  const ev: ScenarioEvent | null = router.at(save.position);
  if (ev && (ev.t === "say" || ev.t === "narrate")) {
    const text = plainText(ev.text);
    const speaker = ev.t === "say" ? ev.speaker : "";
    const key = `${save.position.script}:${save.position.event}`;
    if (save.lastLogged !== key) {
      save.lastLogged = key;
      save.log.push({ speaker, text });
      if (save.log.length > 500) save.log.shift();
    }
  }
}

function paintStage(stage: HTMLElement, save: SaveData): void {
  const url = stageImageHint(save);
  const prevPh = stage.querySelector(":scope > .stage-ph");
  if (url) {
    stage.style.backgroundImage = `url("${url}")`;
    prevPh?.remove();
  } else {
    stage.style.backgroundImage = "";
    if (!prevPh) {
      const div = document.createElement("div");
      div.className = "stage-ph";
      stage.prepend(div);
    }
    const ph = stage.querySelector(":scope > .stage-ph") as HTMLElement;
    ph.textContent = stageImageHintLabel(save);
  }
  stage.style.filter = stageFilter(save);
  paintOverlay(stage, save);
  const bgm = stageBgmHint(save);
  const audio = document.getElementById("bgm") as HTMLAudioElement | null;
  if (!audio) return;
  if (bgm) {
    if (audio.dataset.cur !== bgm) {
      audio.dataset.cur = bgm;
      audio.src = bgm;
      audio.play().catch(() => undefined);
    }
  } else if (audio.dataset.cur) {
    delete audio.dataset.cur;
    audio.pause();
    audio.removeAttribute("src");
  }
}

// These walk the loaded scenarios via a module-level ref set by main.ts.
let scenarioLookup: ((script: string) => { events: ScenarioEvent[] } | undefined) | null = null;
export function setScenarioLookup(fn: typeof scenarioLookup): void {
  scenarioLookup = fn;
}

function eventsBefore(save: SaveData): ScenarioEvent[] {
  const sc = scenarioLookup?.(save.position.script);
  if (!sc) return [];
  return sc.events.slice(0, save.position.event);
}

function stageImageHint(save: SaveData): string | null {
  const evs = eventsBefore(save);
  const ch = chapterOfScript(save.position.script);
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.t === "image") {
      const url = imageUrl(e.file, ch);
      if (url) return url;
      // fall through to older backdrops when the latest is missing
    }
  }
  return null;
}

function stageImageHintLabel(save: SaveData): string {
  const evs = eventsBefore(save);
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.t === "image") return `🖼 ${e.file} [${e.layer ?? "?"}] — install assets for visuals`;
  }
  return "— no backdrop yet —";
}

/** Latest grp-layer overlay at/before position (event CGs, spotlights).
 * Cleared by backdrop changes (new scene = clean overlay slate). */
function stageOverlayHint(save: SaveData): string | null {
  const evs = eventsBefore(save);
  const ch = chapterOfScript(save.position.script);
  let overlay: string | null = null;
  for (const e of evs) {
    if (e.t === "image" && e.layer === "bak") overlay = null;
    else if (e.t === "image" && e.layer === "grp") {
      overlay = imageUrl(e.file, ch);
    }
  }
  return overlay;
}

function paintOverlay(stage: HTMLElement, save: SaveData): void {
  const prev = stage.querySelector(":scope > img.stage-ov");
  const url = stageOverlayHint(save);
  if (!url) {
    prev?.remove();
    return;
  }
  if (prev instanceof HTMLImageElement && prev.dataset.cur === url) return;
  prev?.remove();
  const img = document.createElement("img");
  img.className = "stage-ov";
  img.dataset.cur = url;
  img.src = url;
  img.alt = "";
  stage.appendChild(img);
}

function stageBgmHint(save: SaveData): string | null {
  const evs = eventsBefore(save);
  const ch = chapterOfScript(save.position.script);
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.t === "bgm") {
      const url = bgmUrl(e.file, ch);
      if (url) return url;
    }
  }
  return null;
}

/** Latest .AMP color-grade filter at/before position.
 * Exact engine LUTs via SVG feComponentTransfer when available
 * (data/luts.json), else the CSS approximation table. */
function stageFilter(save: SaveData): string {
  const evs = eventsBefore(save);
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.t === "filter") {
      const stem = e.file.replace(/\.[^.]+$/, "").toLowerCase();
      if (lutAvailable(stem)) return `url(#wa2lut-${stem})`;
      return FILTER_CSS[stem] ?? "";
    }
  }
  return "";
}

const knownLuts = new Set<string>();
let lutDefsInstalled = false;

export function setLuts(luts: Record<string, unknown>): void {
  for (const k of Object.keys(luts ?? {})) knownLuts.add(k.toLowerCase());
}

function lutAvailable(stem: string): boolean {
  return knownLuts.has(stem);
}

/** Inject hidden SVG defs with one feComponentTransfer filter per LUT. */
export function installLutFilters(luts: Record<string, { r: number[]; g: number[]; b: number[] }>): void {
  if (lutDefsInstalled) return;
  lutDefsInstalled = true;
  setLuts(luts);
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.style.position = "absolute";
  const defs = document.createElementNS(NS, "defs");
  const table = (ch: number[]) => ch.map((v) => (v / 255).toFixed(4)).join(" ");
  for (const [name, lut] of Object.entries(luts)) {
    const f = document.createElementNS(NS, "filter");
    f.setAttribute("id", `wa2lut-${name.toLowerCase()}`);
    const t = document.createElementNS(NS, "feComponentTransfer");
    for (const [tag, ch] of [["feFuncR", lut.r], ["feFuncG", lut.g], ["feFuncB", lut.b]] as const) {
      const fn = document.createElementNS(NS, tag);
      fn.setAttribute("type", "table");
      fn.setAttribute("tableValues", table(ch));
      t.appendChild(fn);
    }
    f.appendChild(t);
    defs.appendChild(f);
  }
  svg.appendChild(defs);
  document.body.appendChild(svg);
}

/** Play the voice clip for a displayed line, if the archive has it. */
function playVoice(save: SaveData, ev: ScenarioEvent, vol: number): void {
  const audio = document.getElementById("voice") as HTMLAudioElement | null;
  if (!audio) return;
  audio.volume = Math.max(0, Math.min(1, vol));
  const ch = chapterOfScript(save.position.script);
  const url = ev.t !== "say" && ev.t !== "narrate"
    ? null
    : voiceUrl(save.position.script, ev.tok, ch);
  if (url) {
    if (audio.dataset.cur !== url) {
      audio.dataset.cur = url;
      audio.src = url;
      audio.play().catch(() => undefined);
    }
  } else {
    cutVoice();
  }
}

function cutVoice(): void {
  const audio = document.getElementById("voice") as HTMLAudioElement | null;
  if (audio && audio.dataset.cur) {
    delete audio.dataset.cur;
    audio.pause();
    audio.removeAttribute("src");
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
