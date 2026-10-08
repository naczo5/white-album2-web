// Reader screen: dialogue/narration/choices/stage + backlog + quick menu.

import { bgmTrackUrl, imageUrl, movieUrl, seUrl, voiceUrl, voiceUrlByKey } from "../engine/assets";
import { Router, chapterOfScript } from "../engine/router";
import { plainText, renderText, spanize } from "../engine/text";
import type { BgmData, BnrData, Position, SaveData, ScenarioEvent } from "../engine/types";
import { writeAutosave } from "../engine/save";

export interface ReaderSettings {
  textSpeed: number; // chars per second, 0 = instant
  autoDelay: number; // ms after line completes, 0 = off
  voiceVol: number; // 0..1
  bgmVol: number; // 0..1
  /** Skip mode: "all" skips everything, "read" stops at unread lines. */
  skipRead: boolean;
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
  /** Shared mutable skip state: main.ts flips `active` on Ctrl down/up and
   * the reader reads it live — a snapshot boolean went stale between
   * renders and made Ctrl-skip a no-op (and forced re-renders that
   * restarted the typewriter mid-line = the "flicker"). */
  skip: { active: boolean };
  onChange(): void;
  open(screen: string): void;
  notify(msg: string): void;
  /** Called when read-mode skip halts on an unread line (main clears Ctrl). */
  onSkipStop(): void;
}

// ---- Read-text tracking (for "skip read text only") -----------------------
// Keys are "script:event" for every line that has ever been displayed.
const READ_KEY = "wa2web.read";
let readSet: Set<string> | null = null;

function loadRead(): Set<string> {
  if (readSet) return readSet;
  try {
    readSet = new Set(JSON.parse(localStorage.getItem(READ_KEY) ?? "[]") as string[]);
  } catch {
    readSet = new Set();
  }
  return readSet!;
}

function markRead(save: SaveData): void {
  const key = `${save.position.script}:${save.position.event}`;
  const set = loadRead();
  if (set.has(key)) return;
  set.add(key);
  try {
    localStorage.setItem(READ_KEY, JSON.stringify([...set]));
  } catch {
    /* quota: skip-read degrades to skip-all, harmless */
  }
}

function isRead(save: SaveData): boolean {
  return loadRead().has(`${save.position.script}:${save.position.event}`);
}

export function renderReader(el: HTMLElement, h: ReaderHooks): void {
  clearTimers();
  curHooks = h;
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
        <button data-act="log">Log</button>
        <button data-act="saves">Save</button>
        <button data-act="flow">Chart</button>
        <button data-act="guide">Guide</button>
        <button data-act="title">Title</button>
      </span>
    </div>
    <div class="textbox" id="textbox"></div>
    <div class="choices" id="choices"></div>
    <div class="advance-hint" id="hint">click / enter to continue · hold Ctrl to skip · wheel up for log</div>`;

  paintStage(el.querySelector("#stage") as HTMLElement, save, h.settings.bgmVol);
  fireSe(save);
  updateAmbient(save);
  const box = el.querySelector("#textbox") as HTMLElement;
  const ch = el.querySelector("#choices") as HTMLElement;
  const hint = el.querySelector("#hint") as HTMLElement;

  el.querySelectorAll("[data-act]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      h.open((b as HTMLElement).dataset.act as string);
    }),
  );
  // Standard VN convention: wheel-up opens the backlog.
  el.addEventListener("wheel", (e) => {
    if (e.deltaY < 0) {
      e.preventDefault();
      h.open("log");
    }
  });

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
    markRead(save);
    const cls = ev.t === "say" ? "say" : "narrate";
    const who = ev.t === "say" && displaySpeaker(save, ev)
      ? `<div class="speaker">${escapeAttr(displaySpeaker(save, ev))}</div>` : "";
    const outer = `${cls}${ev.style === "whisper" ? " whisper" : ""}`;
    const full = `${who}<div class="${outer}">${renderText(ev.text)}</div>`;
    const speed = h.skip.active ? 0 : h.settings.textSpeed;
    if (speed > 0) {
      startTypewriter(box, full, ev.text, who, outer, speed, () => scheduleAuto(h));
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
function startTypewriter(box: HTMLElement, full: string, raw: string, who: string, outer: string, cps: number, onDone: () => void): void {
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
    // Same wrapper shape as the finished line: speaker label + style div.
    box.innerHTML = `${who}<div class="${outer}">${html}</div>`;
  };
  box.dataset.typing = "1";
  const tick = () => {
    const shown = Math.floor(((performance.now() - t0) / 1000) * cps);
    if (shown >= total) {
      // STOP THE INTERVAL before onDone: leaving it running re-fired
      // onDone -> scheduleAuto every 30 ms, which perpetually cleared the
      // pending auto-advance/skip timer (Ctrl-skip and auto mode never
      // fired) and re-rendered the finished box 30x/s (visible flicker).
      if (typeTimer !== null) {
        clearInterval(typeTimer);
        typeTimer = null;
      }
      box.innerHTML = full;
      delete box.dataset.typing;
      onDone();
      return;
    }
    render(shown);
  };
  typeTimer = window.setInterval(tick, 30);
  tick();
}

function plainLength(s: string): number {
  return s.replace(/\\k/g, "  ").replace(/\\n/g, " ").length;
}

/** Partial-span renderer for the typewriter (exported for unit tests).
 * Mirrors renderText(): escape first, then convert breaks. */
export function renderSpanPartial(sp: { text: string; whisper?: boolean; ruby?: string }, take: number): string {
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Mirror renderText(): escape first, THEN convert breaks (never the reverse).
  let t = esc(sp.text).replace(/\\k/g, "<br><br>").replace(/\\n/g, "<br>");
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

/** Auto-advance scheduling (auto mode + Ctrl-held skip mode).
 * Read-mode skip halts on the first unread line (never advances past it). */
function scheduleAuto(h: ReaderHooks): void {
  clearAuto();
  const delay = h.skip.active ? 120 : h.settings.autoDelay;
  if (delay <= 0) return;
  const ev = h.router.at(h.save.position);
  if (!ev || ev.t === "choice") return; // never auto-pick
  if (h.skip.active && h.settings.skipRead && !isRead(h.save)) {
    h.skip.active = false;
    h.onSkipStop();
    return;
  }
  autoTimer = window.setTimeout(() => {
    autoTimer = null;
    if (h.skip.active && h.settings.skipRead && !isRead(h.save)) {
      h.skip.active = false;
      h.onSkipStop();
      return;
    }
    if (h.skip.active) {
      const cur = h.router.at(h.save.position);
      if (cur && cur.t !== "choice") stepForward(h);
      return;
    }
    stepForward(h);
  }, delay);
}

/** Live skip control from main.ts (Ctrl down/up, window blur). Mutates the
 * shared state and (re)starts the 120 ms advance loop without re-rendering
 * — a re-render would restart the typewriter mid-line (the flicker bug). */
let curHooks: ReaderHooks | null = null;
export function setSkipping(active: boolean): void {
  if (!curHooks) return;
  curHooks.skip.active = active;
  if (active) scheduleAuto(curHooks);
  else clearAuto();
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
    const speaker = ev.t === "say" ? displaySpeaker(save, ev) : "";
    const key = `${save.position.script}:${save.position.event}`;
    if (save.lastLogged !== key) {
      save.lastLogged = key;
      save.log.push({ speaker, text });
      if (save.log.length > 500) save.log.shift();
    }
  }
}

function paintStage(stage: HTMLElement, save: SaveData, bgmVol: number): void {
  const st = stageImageState(save);
  const prevPh = stage.querySelector(":scope > .stage-ph");
  if (st.url) {
    stage.style.backgroundImage = `url("${st.url}")`;
    stage.style.backgroundColor = "";
    prevPh?.remove();
  } else {
    stage.style.backgroundImage = "";
    if (st.cleared) {
      // Engine clear-to-black (e.g. stage-play spotlight scenes).
      stage.style.backgroundColor = "#000";
      prevPh?.remove();
    } else {
      stage.style.backgroundColor = "";
      if (!prevPh) {
        const div = document.createElement("div");
        div.className = "stage-ph";
        stage.prepend(div);
      }
      const ph = stage.querySelector(":scope > .stage-ph") as HTMLElement;
      ph.textContent = st.missingFile
        ? `🖼 ${st.missingFile} — install assets for visuals`
        : "— no backdrop yet —";
    }
  }
  stage.style.filter = stageFilter(save);
  paintOverlay(stage, save);
  paintSprites(stage, save);
  paintBgm(save, bgmVol);
  paintFade(stage, save);
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

function stageImageState(save: SaveData): StageImageState {
  return resolveStageImageEx(
    eventsBefore(save).map((e, i) => ({ e, i })),
    bnrLookup?.(save.position.script) ?? null,
    save.position.event,
    chapterOfScript(save.position.script),
  );
}

/** Pure merged stage resolver (DOM-free; test-pinned).
 * Timeline = txt image events (exact indices) + .bnr bak records
 * (fractional indices). Latest resolvable cue at/before `event` wins;
 * a clear is a barrier (stage wiped — nothing older shows). Unresolvable
 * cues (assets not installed) fall through to older backdrops — that is
 * engine-true: op (4,146) builds "B%04d%1d%1d.tga" (mode 0 in primitive
 * 0x4167e0, exe .rdata 0x4a2a00), so a missing b*-file leaves the
 * previous backdrop standing. Same-event cues apply in statement order:
 * the LAST statement at an event wins (handlers run sequentially).
 * resolveStageImageEx additionally reports WHY the stage is empty:
 * cleared (engine clear-to-black) vs missing (asset not installed). */
export type StageImageState = {
  url: string | null;
  cleared: boolean;
  /** Last unresolvable cue's filename (install hint), if that's why. */
  missingFile?: string;
};

export function resolveStageImageEx(
  txt: { e: ScenarioEvent; i: number }[],
  bnr: BnrData["recs"][string] | null | undefined,
  event: number,
  chapter: string,
): StageImageState {
  type Cue = { ev: number; file?: string; stems?: string[]; clear?: boolean; rank: number; seq: number };
  const cues: Cue[] = [];
  let seq = 0;
  for (const { e, i } of txt) {
    if (e.t === "image") cues.push({ ev: i, file: e.file, rank: 0, seq: seq++ });
  }
  for (const r of bnr ?? []) {
    if (r.conf !== "high" || r.ev > event) continue;
    if (r.layer !== "bak") continue;
    if (r.clear) cues.push({ ev: r.ev, clear: true, rank: 1, seq: seq++ });
    else if (r.stems?.length) cues.push({ ev: r.ev, stems: r.stems, rank: 1, seq: seq++ });
  }
  // Newest ev first; same-event bnr cues in reverse statement order (last
  // statement wins); txt events keep priority over bnr at the same event.
  cues.sort((a, b) => b.ev - a.ev || a.rank - b.rank || b.seq - a.seq);
  let missingFile: string | undefined;
  for (const c of cues) {
    if (c.ev > event) continue;
    if (c.clear) return { url: null, cleared: true };
    if (c.file) {
      const url = imageUrl(c.file, chapter);
      if (url) return { url, cleared: false };
      missingFile = c.file;
    } else if (c.stems) {
      // Backdrop stems resolve to b* files ONLY: op (4,146) passes mode 0
      // to primitive 0x4167e0 which builds "B%04d%1d%1d.tga" (0x4a2a00).
      // No cross-prefix fall-through — the engine never loads a v* CG
      // here (that is op (4,147), decoded into the grp layer).
      for (const stem of c.stems) {
        const url = imageUrl(`b${stem}.tga`, chapter);
        if (url) return { url, cleared: false };
      }
      missingFile = `b${c.stems[0]}.tga`;
    }
  }
  return { url: null, cleared: false, missingFile };
}

export function resolveStageImage(
  txt: { e: ScenarioEvent; i: number }[],
  bnr: BnrData["recs"][string] | null | undefined,
  event: number,
  chapter: string,
): string | null {
  return resolveStageImageEx(txt, bnr, event, chapter).url;
}

/** Latest grp-layer overlay at/before position (event CGs, spotlights).
 * Merged timeline like the background: txt grp images + .bnr grp records;
 * any bak cue (txt or .bnr) or clear resets the overlay slate. */
function stageOverlayHint(save: SaveData): string | null {
  return resolveStageOverlay(
    eventsBefore(save).map((e, i) => ({ e, i })),
    bnrLookup?.(save.position.script) ?? null,
    save.position.event,
    chapterOfScript(save.position.script),
  );
}

export function resolveStageOverlay(
  txt: { e: ScenarioEvent; i: number }[],
  bnr: BnrData["recs"][string] | null | undefined,
  event: number,
  chapter: string,
): string | null {
  type Cue = { ev: number; file?: string; stems?: string[]; reset?: boolean; rank: number; seq: number };
  const cues: Cue[] = [];
  let seq = 0;
  for (const { e, i } of txt) {
    if (e.t !== "image") continue;
    if (e.layer === "bak") cues.push({ ev: i, reset: true, rank: 0, seq: seq++ });
    else if (e.layer === "grp") cues.push({ ev: i, file: e.file, rank: 0, seq: seq++ });
  }
  for (const r of bnr ?? []) {
    if (r.conf !== "high" || r.ev > event) continue;
    if (r.layer === "bak") cues.push({ ev: r.ev, reset: true, rank: 1, seq: seq++ });
    else if (r.layer === "grp") {
      if (r.clear) cues.push({ ev: r.ev, reset: true, rank: 1, seq: seq++ });
      else if (r.stems?.length) cues.push({ ev: r.ev, stems: r.stems, rank: 1, seq: seq++ });
    }
  }
  // Same ordering as the backdrop resolver (newest ev; last statement
  // wins within an event; txt keeps priority over bnr at one event).
  cues.sort((a, b) => b.ev - a.ev || a.rank - b.rank || b.seq - a.seq);
  for (const c of cues) {
    if (c.ev > event) continue;
    if (c.reset) return null;
    const files = c.file
      ? [c.file]
      // Overlay stems: ops (4,147)/(4,148) pass mode 1 to primitive
      // 0x4167e0 -> "v%06d.tga" (0x4a2a1c). No b* fall-through — the
      // engine never loads a backdrop file into the overlay layer.
      : (c.stems ?? []).flatMap((s) => [`v${s}.tga`, `tv${s}.tga`]);
    for (const f of files) {
      const url = imageUrl(f, chapter);
      if (url) return url;
    }
  }
  return null;
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
  const ms = bnrFadeAt(save) ?? 0;
  if (ms > 0) {
    img.style.opacity = "0";
    img.style.transition = `opacity ${ms}ms`;
    requestAnimationFrame(() => {
      img.style.opacity = "1";
    });
  }
  stage.appendChild(img);
}

/** BGM timeline state at the current position (data/bgm.json, .bnr (4,158)).
 * Latest cue at/before the event wins; files with no cue inherit prior BGM
 * (sustain); `missing` tracks (no file in BGM.PAKs) also sustain — the
 * player never inserts silence except on explicit stops. */
export function bgmCueAt(save: SaveData): { kind: "play"; url: string } | { kind: "stop" } | { kind: "sustain" } {
  const cues = bgmLookup?.(save.position.script);
  if (!cues || cues.length === 0) return { kind: "sustain" };
  const ch = chapterOfScript(save.position.script);
  return resolveBgmTimeline(cues, save.position.event, (t) => bgmTrackUrl(t, ch));
}

/** Pure BGM timeline resolver (DOM-free; test-pinned).
 * Latest cue at/before `event` wins; stops silence; missing tracks and
 * unresolvable files sustain previous BGM (never silence for a play cue). */
export function resolveBgmTimeline(
  cues: { ev: number; track?: number; stop?: boolean; missing?: boolean }[],
  event: number,
  resolve: (track: number) => string | null,
): { kind: "play"; url: string } | { kind: "stop" } | { kind: "sustain" } {
  let pending: { kind: "play"; url: string } | { kind: "stop" } | null = null;
  for (const c of cues) {
    if (c.ev > event) break;
    if (c.stop) {
      pending = { kind: "stop" };
    } else if (c.track !== undefined && !c.missing) {
      const url = resolve(c.track);
      if (url) pending = { kind: "play", url };
    }
  }
  return pending ?? { kind: "sustain" };
}

type BgmLookup = (script: string) => BgmData["cues"][string] | undefined;
let bgmLookup: BgmLookup | null = null;
export function setBgmLookup(fn: BgmLookup | null): void {
  bgmLookup = fn;
}

function paintBgm(save: SaveData, bgmVol: number): void {
  const audio = document.getElementById("bgm") as HTMLAudioElement | null;
  if (!audio) return;
  audio.volume = Math.max(0, Math.min(1, bgmVol));
  const cue = bgmCueAt(save);
  if (cue.kind === "play") {
    if (audio.dataset.cur !== cue.url) {
      audio.dataset.cur = cue.url;
      audio.src = cue.url;
      audio.play().catch(() => undefined);
    }
  } else if (cue.kind === "stop") {
    if (audio.dataset.cur) {
      delete audio.dataset.cur;
      audio.pause();
      audio.removeAttribute("src");
    }
  }
  // sustain: leave the current track playing (engine inherits BGM across
  // files; only explicit stops silence it).
}

/** Backdrop fade duration from high-confidence .bnr fade records.
 * Capped: a wrong semantic here must degrade to a slightly-off fade, never
 * a stuck stage. No record -> default CSS duration. */
export function bnrFadeAt(save: SaveData): number | null {
  const recs = bnrLookup?.(save.position.script);
  if (!recs) return null;
  return resolveFade(recs, save.position.event);
}

/** Pure fade resolver (DOM-free; test-pinned). */
export function resolveFade(
  recs: { ev: number; fadeMs?: number; fade?: number | null; stems?: string[]; clear?: boolean; se?: number[]; cam?: unknown; conf: string }[],
  event: number,
): number | null {
  const cap = (v: number) => Math.max(0, Math.min(2000, v));
  let pending: number | null = null;
  for (const r of recs) {
    if (r.ev > event || r.conf !== "high") continue;
    if (r.fadeMs) {
      pending = cap(r.fadeMs);
    } else if (r.stems?.length || r.clear) {
      // An image change carries its own transition (or the default when 0).
      pending = r.fade ? cap(r.fade) : null;
    }
    // se/cam-only recs are not visual timing: ignored, never reset.
  }
  return pending;
}

function paintFade(stage: HTMLElement, save: SaveData): void {
  const ms = bnrFadeAt(save);
  stage.style.transitionDuration = ms !== null ? `${ms}ms` : "";
}

/** Fire-and-forget high-confidence SE triggers (data/bnr.json).
 * Hypothesis-confidence records are deliberately ignored (docs/QA.md). */
export function seCueAt(save: SaveData): string | null {
  const recs = bnrLookup?.(save.position.script);
  if (!recs) return null;
  const ch = chapterOfScript(save.position.script);
  const id = resolveSeRec(recs, save.position.event);
  return id === null ? null : seUrl(id, ch);
}

/** Pure SE trigger resolver (DOM-free; test-pinned). Only high-confidence
 * records fire; hypothesis records are ignored by design. */
export function resolveSeRec(
  recs: { ev: number; se?: number[]; conf: string }[],
  event: number,
): number | null {
  for (const r of recs) {
    if (r.ev === event && r.conf === "high" && r.se?.length) {
      return r.se[0];
    }
  }
  return null;
}

type BnrLookup = (script: string) => BnrData["recs"][string] | undefined;
let bnrLookup: BnrLookup | null = null;
export function setBnrLookup(fn: BnrLookup | null): void {
  bnrLookup = fn;
}

function fireSe(save: SaveData): void {
  const url = seCueAt(save);
  if (!url) return;
  const audio = document.getElementById("se") as HTMLAudioElement | null;
  if (!audio) return;
  audio.src = url;
  audio.play().catch(() => undefined);
}

/** Pure ambient-channel resolvers (DOM-free; test-pinned). Only
 * high-confidence records drive playback (docs/QA.md). */
export interface AmbCue { se: number; ch: number; vol: number; loop: boolean }
export function resolveAmbCue(
  recs: { ev: number; amb?: AmbCue; ambStop?: number; conf: string }[],
  event: number,
): AmbCue | null {
  for (const r of recs) {
    if (r.ev === event && r.conf === "high" && r.amb) return r.amb;
  }
  return null;
}
export function resolveAmbStop(
  recs: { ev: number; amb?: AmbCue; ambStop?: number; conf: string }[],
  event: number,
): number | null {
  for (const r of recs) {
    if (r.ev === event && r.conf === "high" && r.ambStop !== undefined) {
      return r.ambStop;
    }
  }
  return null;
}

// Ambient channel state (engine .bnr (4,165)/(4,166)): up to four
// looping channel players; a script switch cuts them all (engine
// channel state does not carry across scripts).
const ambEls = new Map<number, HTMLAudioElement>();
let ambScript: string | null = null;

function stopAmbChannel(ch: number): void {
  const a = ambEls.get(ch);
  if (a) {
    a.pause();
    a.removeAttribute("src");
    delete a.dataset.cur;
  }
}

function stopAllAmb(): void {
  for (const ch of [...ambEls.keys()]) stopAmbChannel(ch);
}

function updateAmbient(save: SaveData): void {
  if (ambScript !== null && ambScript !== save.position.script) {
    stopAllAmb();
  }
  ambScript = save.position.script;
  const recs = bnrLookup?.(save.position.script);
  if (!recs) return;
  const stop = resolveAmbStop(recs, save.position.event);
  if (stop !== null) stopAmbChannel(stop);
  const cue = resolveAmbCue(recs, save.position.event);
  if (!cue) return;
  const ch = chapterOfScript(save.position.script);
  const url = seUrl(cue.se, ch);
  let a = ambEls.get(cue.ch);
  if (!a) {
    a = document.createElement("audio");
    a.dataset.ch = String(cue.ch);
    ambEls.set(cue.ch, a);
  }
  if (!url) {
    // missing asset: silence the channel rather than replay a stale cue
    stopAmbChannel(cue.ch);
    return;
  }
  a.dataset.cur = url;
  a.src = url;
  a.loop = cue.loop;
  a.volume = Math.max(0, Math.min(1, cue.vol / 255));
  a.play().catch(() => undefined);
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

/** Pure voice resolver (DOM-free; test-pinned). The voicemap decides
 * when present: a string is an exact archive key (voicemap v2), a number
 * is a legacy bnr NNN (played via the script_token path); null = unvoiced
 * step. Comma-tok is only a fallback for scripts with no map. */
export type VoiceRef = string | number;
export function resolveVoiceRef(
  mapped: VoiceRef | null | undefined,
  tok: number | undefined,
): VoiceRef | null {
  if (mapped !== undefined) return mapped;
  return tok ?? null;
}

type VoiceLookup = (
  script: string,
  ev: number,
) => VoiceRef | null | undefined;
let voiceLookup: VoiceLookup | null = null;
export function setVoiceLookup(fn: VoiceLookup | null): void {
  voiceLookup = fn;
}

/** Display-name overrides (data/speakers.json, built from the MAO
 * manuscript's speakerEn): JP speaker labels map to EN names by
 * script-scoped name votes. DOM-free. */
type SpeakerLookup = (script: string, ev: number) => string | undefined;
let speakerLookup: SpeakerLookup | null = null;
export function setSpeakerLookup(fn: SpeakerLookup | null): void {
  speakerLookup = fn;
}

function displaySpeaker(save: SaveData, ev: ScenarioEvent): string {
  if (ev.t !== "say" || !ev.speaker) return "";
  return speakerLookup?.(save.position.script, save.position.event) ??
    ev.speaker;
}

/** Engine-faithful standing sprites: (4,154)/(4,155) shows + (4,156)/(4,157)
 * hides decoded by tools/decode_bnr.py. Slot records are keyed by character
 * id (exe 0x402220 scans the 8 slot records by id): a show of the same char
 * replaces its pose/position; a hide clears the char; face 4000 hides too.
 * A backdrop show/clear wipes ALL standing sprites (exe: image primitive
 * 0x4167e0 reaches the clear-all slot loop 0x402680) — recs carry
 * sprClear on bak cues; recs are applied in statement order so same-event
 * re-shows after the wipe survive. Draw order = show order (Map insertion
 * order), matching the engine's slot-allocation draw order.
 * Hypothesis-confidence recs are ignored. DOM-free; test-pinned. */
export function resolveSprites(
  recs: BnrData["recs"][string] | null | undefined,
  event: number,
): { id: number; stem: string; pos: number | null }[] {
  const active = new Map<number, { stem: string; pos: number | null }>();
  for (const r of recs ?? []) {
    if (r.conf !== "high" || r.ev > event) continue;
    if (r.sprClear) active.clear();
    if (r.spr) active.set(r.spr.id, { stem: r.spr.stem, pos: r.spr.pos ?? null });
    else if (r.sprHide !== undefined) active.delete(r.sprHide);
  }
  return [...active.entries()].map(([id, s]) => ({ id, stem: s.stem, pos: s.pos }));
}

/** Sprite screen-x table (exe 0x4be0bc): px offsets from centre on the
 * 1280-wide stage, indexed by the statement's position arg (0..10). */
export const SPRITE_POS_X = [-288, 0, 288, -384, 384, -480, 480, -480, -160, 160, 480];

/** Pure position resolver (DOM-free; test-pinned): stage-% left coordinate
 * for a sprite position index, null -> centred. */
export function spriteLeftPct(pos: number | null): number {
  if (pos === null || pos < 0 || pos >= SPRITE_POS_X.length) return 50;
  return ((640 + SPRITE_POS_X[pos]) / 1280) * 100;
}

/** Paint standing sprites below the grp overlay, reconciled per character
 * id so advance/rollback never flickers. Position: engine x-table; sprites
 * are exactly stage-height and bottom-anchored (720px art on 720px stage). */
function paintSprites(stage: HTMLElement, save: SaveData): void {
  const active = resolveSprites(
    bnrLookup?.(save.position.script),
    save.position.event,
  );
  const seen = new Set<number>();
  active.forEach((s, i) => {
    const url = imageUrl(`${s.stem}.tga`);
    let img = stage.querySelector(
      `:scope > img.stage-spr[data-id="${s.id}"]`,
    ) as HTMLImageElement | null;
    if (!url) {
      img?.remove();
      return;
    }
    const fresh = !img;
    if (!img) {
      img = document.createElement("img");
      img.className = "stage-spr";
      img.alt = "";
      img.dataset.id = String(s.id);
      const ov = stage.querySelector(":scope > img.stage-ov");
      if (ov) stage.insertBefore(img, ov);
      else stage.appendChild(img);
    }
    if (img.getAttribute("src") !== url) img.setAttribute("src", url);
    img.style.left = `${spriteLeftPct(s.pos)}%`;
    img.style.zIndex = String(10 + i);
    if (fresh) {
      // Fade/rise in like the engine's sprite entrance.
      img.style.opacity = "0";
      img.style.translate = "0 2%";
      requestAnimationFrame(() => {
        img!.style.opacity = "";
        img!.style.translate = "";
      });
    }
    seen.add(s.id);
  });
  stage.querySelectorAll(":scope > img.stage-spr").forEach((el) => {
    const id = Number((el as HTMLElement).dataset.id);
    if (!seen.has(id)) el.remove();
  });
}

/** Play the voice clip for a displayed line, if the archive has it. */
function playVoice(save: SaveData, ev: ScenarioEvent, vol: number): void {
  const audio = document.getElementById("voice") as HTMLAudioElement | null;
  if (!audio) return;
  audio.volume = Math.max(0, Math.min(1, vol));
  const ch = chapterOfScript(save.position.script);
  const mapped = ev.t !== "say" && ev.t !== "narrate"
    ? null
    : voiceLookup?.(save.position.script, save.position.event);
  const ref = ev.t !== "say" && ev.t !== "narrate"
    ? null
    : resolveVoiceRef(mapped, ev.tok);
  const url = ref === null
    ? null
    : typeof ref === "string"
      ? voiceUrlByKey(ref)
      : voiceUrl(save.position.script, ref, ch);
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
