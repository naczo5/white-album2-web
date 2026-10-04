// Reader screen: dialogue/narration/choices/stage + backlog + quick menu.

import { bgmUrl, imageUrl, movieUrl } from "../engine/assets";
import { Router, chapterOfScript } from "../engine/router";
import { plainText, renderText } from "../engine/text";
import type { Position, SaveData, ScenarioEvent } from "../engine/types";
import { writeAutosave } from "../engine/save";

export interface ReaderHooks {
  router: Router;
  save: SaveData;
  onChange(): void;
  open(screen: string): void;
  notify(msg: string): void;
}

export function renderReader(el: HTMLElement, h: ReaderHooks): void {
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
    // Past the end of a script without a terminal: offer wayfinding
    // instead of stranding the player.
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
    if (ev.t === "say") {
      const who = ev.speaker ? `<div class="speaker">${escapeAttr(ev.speaker)}</div>` : "";
      box.innerHTML = `${who}<div class="say${ev.style === "whisper" ? " whisper" : ""}">${renderText(ev.text)}</div>`;
    } else {
      box.innerHTML = `<div class="narrate${ev.style === "whisper" ? " whisper" : ""}">${renderText(ev.text)}</div>`;
    }
    el.onclick = () => stepForward(h);
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
    ev.t === "bgm" ? `♪ ${ev.file}` :
    ev.t === "anim" ? `✦ ${ev.file} [${ev.layer ?? "?"}]` :
    ev.t === "latch" ? `— ${ev.name} —` :
    ev.t === "jump" ? `⇢ ${ev.kind} ${ev.targets.join(" ")}` :
    ev.t === "layer" ? `▤ ${ev.layer}` : "…";
  box.innerHTML = `<div class="narrate dim">${escapeAttr(label)}</div>`;
  el.onclick = () => stepForward(h);
}

export function stepForward(h: ReaderHooks): void {
  const { router, save } = h;
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
    if (ev.t === "latch" || ev.t === "image" || ev.t === "bgm" || ev.t === "anim" || ev.t === "layer") {
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
  if (url) {
    stage.style.backgroundImage = `url("${url}")`;
    stage.innerHTML = "";
  } else {
    stage.style.backgroundImage = "";
    stage.innerHTML = `<div class="stage-ph">${stageImageHintLabel(save)}</div>`;
  }
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
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.t === "image") return imageUrl(e.file);
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

function stageBgmHint(save: SaveData): string | null {
  const evs = eventsBefore(save);
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.t === "bgm") return bgmUrl(e.file);
  }
  return null;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
