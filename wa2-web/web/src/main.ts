import { loadManifest } from "./engine/assets";
import { Router, chapterOfScript } from "./engine/router";
import { newSave, readAutosave, readQuicksave, setSaveNamespace, writeAutosave, writeQuicksave } from "./engine/save";
import type { SaveData } from "./engine/types";
import { loadGameData, type GameData } from "./ui/data";
import { renderFlowchart } from "./ui/flowchart";
import { renderGuide, type GuideData } from "./ui/guide";
import { installLutFilters, pushLog, renderReader, setBgmLookup, setBnrLookup, setScenarioLookup, setSpeakerLookup, setSkipping, setVoiceLookup, skipLatches } from "./ui/reader";
import { renderSaves } from "./ui/saves";
import "./style.css";

type Screen = "title" | "read" | "flow" | "guide" | "special" | "saves" | "log" | "settings";

interface Settings {
  spoiler: boolean;
  fontSize: number;
  textSpeed: number; // chars/sec, 0 = instant
  autoDelay: number; // ms, 0 = off
  voiceVol: number; // 0..1
  bgmVol: number; // 0..1
  skipRead: boolean; // true: Ctrl skips only already-read lines
  dev: boolean; // dev mode: scene-jump buttons in the flowchart
}

function safeStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storedNumber(key: string, fallback: number, min: number, max: number): number {
  const raw = safeStorageGet(key);
  const n = raw === null ? fallback : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

const settings: Settings = {
  spoiler: safeStorageGet("wa2web.spoiler") === "1",
  fontSize: clampFont(Number(safeStorageGet("wa2web.fontSize") ?? 18)),
  textSpeed: storedNumber("wa2web.textSpeed", 45, 0, 120),
  autoDelay: storedNumber("wa2web.autoDelay", 0, 0, 8000),
  voiceVol: storedNumber("wa2web.voiceVol", 0.9, 0, 1),
  bgmVol: storedNumber("wa2web.bgmVol", 0.7, 0, 1),
  skipRead: safeStorageGet("wa2web.skipRead") === "1",
  dev: safeStorageGet("wa2web.dev") === "1",
};

let skipState = { active: false };

function persistSettings(): void {
  try {
    localStorage.setItem("wa2web.spoiler", settings.spoiler ? "1" : "0");
    localStorage.setItem("wa2web.fontSize", String(settings.fontSize));
    localStorage.setItem("wa2web.textSpeed", String(settings.textSpeed));
    localStorage.setItem("wa2web.autoDelay", String(settings.autoDelay));
    localStorage.setItem("wa2web.voiceVol", String(settings.voiceVol));
    localStorage.setItem("wa2web.bgmVol", String(settings.bgmVol));
    localStorage.setItem("wa2web.skipRead", settings.skipRead ? "1" : "0");
    localStorage.setItem("wa2web.dev", settings.dev ? "1" : "0");
  } catch {
    /* settings are a convenience; the app still runs with in-memory values */
  }
}

function clampFont(n: number): number {
  if (!Number.isFinite(n)) return 18;
  return Math.max(14, Math.min(26, Math.round(n)));
}

let data: GameData;
let router: Router;
let save: SaveData;
let screen: Screen = "title";
/** Optional external BYOA pack root (`?pack=https://host/wa2-demo`). Data
 * and assets live side by side under it; nothing copyrighted is committed
 * to this repo. See docs/BYOA.md. */
let packBase = "";
/** Data loaded from ?pack= but assets/manifest.json did not. Surfaced as a
 * title warning so a pack/CORS misconfiguration is diagnosable. */
let assetsMissing = false;
let backTo: Screen = "title";

function parsePackBase(raw: string | null): string {
  if (!raw) return "";
  try {
    const u = new URL(raw, location.href);
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

/** Stable short id for save-key namespacing (FNV-1a). */
function dataNamespace(): string {
  if (data.demo) return "demo";
  if (!packBase) return "";
  let h = 0x811c9dc5;
  for (let i = 0; i < packBase.length; i++) {
    h ^= packBase.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `pack-${h.toString(16)}`;
}
const app = document.getElementById("app")!;

async function boot(): Promise<void> {
  applySettings();
  const q = new URLSearchParams(location.search);
  packBase = parsePackBase(q.get("pack"));
  data = await loadGameData(packBase);
  setSaveNamespace(dataNamespace());
  router = new Router(data.scenarios, data.flow, data.links, data.terminals);
  setScenarioLookup((script) => router.scripts.get(script));
  setBgmLookup((script) => data.bgm?.cues[script]);
  setBnrLookup((script) => data.bnr?.recs[script]);
  // Map hit (even null = unvoiced step) beats comma-tok; scripts without
  // a map fall back to tok via undefined.
  setVoiceLookup((script, ev) => {
    const m = data.voicemap?.map[script];
    if (!m) return undefined;
    const v = m[String(ev)];
    return v === undefined ? null : v;
  });
  // JP speaker labels -> EN names (MAO manuscript, name-vote based)
  setSpeakerLookup((script, ev) => data.speakers?.speakers[script]?.[String(ev)]);
  const manifest = await loadManifest(packBase ? `${packBase}/assets/manifest.json` : "assets/manifest.json");
  assetsMissing = !!packBase && !manifest;
  try {
    const lutRes = await fetch(packBase ? `${packBase}/data/luts.json` : "data/luts.json");
    if (lutRes.ok) {
      const lutData = (await lutRes.json()) as {
        luts: Record<string, { r: number[]; g: number[]; b: number[] }>;
      };
      installLutFilters(lutData.luts ?? {});
    }
  } catch {
    /* LUTs optional: CSS fallback covers named filters */
  }
  const auto = data.demo ? null : readAutosave(localStorage);
  if (auto) {
    const autoScript = router.scripts.get(auto.position.script);
    if (autoScript && auto.position.event < autoScript.events.length) {
      save = auto;
    } else {
      save = freshStart();
    }
  } else {
    save = freshStart();
  }
  if (!save.visited.includes(save.position.script)) save.visited.push(save.position.script);
  // Normalize boot position past any directive/latch runs so the first
  // paint shows text, then log the arrival line for the backlog.
  // Debug/deep-link: ?pos=script:event jumps straight into the reader.
  const p = q.get("pos");
  if (p) {
    const [sc, ev] = p.split(":");
    if (router.scripts.has(sc)) {
      save = newSave("debug", { script: sc, event: Number(ev) || 0 });
      screen = "read";
    }
  }
  const scr = q.get("screen");
  if (scr && ["flow", "guide", "settings", "saves", "special", "log"].includes(scr)) {
    screen = scr as Screen;
  }
  save.position = skipLatches(router, save.position, save.flags);
  pushLog(router, save);
  render();
  // Enter/click = advance (first press completes typing instantly, next
  // advances); hold Ctrl = skip (released on keyup / focus loss). Key
  // repeat is ignored so holding Enter never fast-forwards. Skip state is
  // a shared mutable object read live by the reader hooks — setSkipping
  // starts/stops the reader's 120 ms advance loop WITHOUT re-rendering
  // (a re-render restarted the typewriter mid-line = the flicker bug).
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && screen !== "title" && screen !== "read") {
      // Esc leaves any overlay screen (log/chart/guide/saves/settings)
      // back to wherever it was opened from.
      screen = backTo;
      render();
      return;
    }
    if (screen !== "read") return;
    if (e.key === "Control" && !skipState.active) setSkipping(true);
    if (e.code === "Enter" && !e.repeat) {
      // A focused choice/HUD control owns Enter; only body focus advances.
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body &&
        active.closest("button, a, input, select, textarea, [role='button']")) return;
      e.preventDefault();
      (document.getElementById("reader") as HTMLElement)?.click();
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Control" && skipState.active) setSkipping(false);
  });
  window.addEventListener("blur", () => {
    if (skipState.active) setSkipping(false);
  });
}

function freshStart(): SaveData {
  const first = data.scenarios[0]?.script ?? "demo-1";
  const s = newSave("Haruki", { script: first, event: 0 });
  s.visited.push(first);
  return s;
}

function applySettings(): void {
  document.documentElement.style.setProperty("--fontsize", `${settings.fontSize}px`);
}

function notify(msg: string): void {
  const t = document.getElementById("toast")!;
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2500);
}

/** Shared load path for slots, autosave, quick save and native imports. */
function loadSaveIntoGame(next: SaveData): void {
  const sc = router.scripts.get(next.position.script);
  if (!sc) {
    notify(`Save points at unknown script ${next.position.script}; refusing.`);
    return;
  }
  if (next.position.event >= sc.events.length) {
    notify(`Save position ${next.position.script}:${next.position.event} is past this build; refusing.`);
    return;
  }
  save = next;
  save.position = skipLatches(router, save.position, save.flags);
  if (!save.visited.includes(save.position.script)) save.visited.push(save.position.script);
  pushLog(router, save);
  writeAutosave(localStorage, save);
  screen = "read";
  render();
}

function quickSave(): void {
  if (writeQuicksave(localStorage, save)) notify("Quick saved.");
  else notify("Browser storage is full or unavailable; quick save failed.");
}

function quickLoad(): void {
  const q = readQuicksave(localStorage);
  if (!q) {
    notify("No quick save yet.");
    return;
  }
  loadSaveIntoGame(q);
}

const hooks = {
  onChange: () => render(),
  open: (s: string) => {
    if (s === "auto") {
      settings.autoDelay = settings.autoDelay > 0 ? 0 : 2500;
      persistSettings();
      render();
      return;
    }
    backTo = screen;
    screen = s as Screen;
    render();
  },
  notify,
  quickSave,
  quickLoad,
  onSkipStop: () => {
    skipState.active = false;
  },
};

const CHAPTER_LABEL: Record<string, string> = {
  intro: "Introductory chapter",
  closing: "Closing chapter",
  coda: "Coda",
  special: "Special",
};

function chapterLabel(script: string): string {
  if (script.startsWith("demo")) return "Demo";
  return CHAPTER_LABEL[chapterOfScript(script)] ?? "Special";
}

/** Drawn snowflake mark (not game art): six branched arms around a small
 * ice core, with the interface's cyan-to-rose rim light. */
function snowflakeSvg(): string {
  const arm = `
    <path d="M110 108V10" />
    <path d="M110 36l-16-15M110 36l16-15" />
    <path d="M110 64l-11-10M110 64l11-10" />
    <path d="M110 10l-7-7M110 10l7-7" />`;
  const arms = [0, 60, 120, 180, 240, 300]
    .map((deg) => `<g transform="rotate(${deg} 110 110)">${arm}</g>`)
    .join("");
  return `<svg class="snowflake-mark" viewBox="0 0 220 220" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id="sf-rim" x1="20" y1="20" x2="200" y2="200" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#f4ffff" stop-opacity=".95" />
        <stop offset=".45" stop-color="#8ff4ed" stop-opacity=".7" />
        <stop offset=".78" stop-color="#5ad4d4" stop-opacity=".42" />
        <stop offset="1" stop-color="#f3b6cf" stop-opacity=".5" />
      </linearGradient>
    </defs>
    <g stroke="url(#sf-rim)" stroke-width="1.7" stroke-linecap="round">${arms}</g>
    <circle cx="110" cy="110" r="7" stroke="url(#sf-rim)" stroke-width="1.7" />
    <circle cx="110" cy="110" r="2.2" fill="#dffcff" fill-opacity=".8" />
  </svg>`;
}

function screenHead(title: string, sub: string): string {
  return `<header class="screen-head"><div>
    <h2>${title}</h2>
    <p class="screen-sub">${sub}</p>
  </div></header>`;
}

function render(): void {
  if (screen === "title") {
    const autoNow = data.demo ? null : readAutosave(localStorage);
    const autoScript = autoNow ? router.scripts.get(autoNow.position.script) : null;
    const hasContinue = !!autoNow && !!autoScript && autoNow.position.event < autoScript.events.length;
    const at = hasContinue ? autoNow! : save;
    const primary = data.demo ? "Start demo" : hasContinue ? "Continue" : "Start";
    const primarySub = data.demo
      ? "Original placeholder scene · no game assets"
      : hasContinue
        ? `${chapterLabel(at.position.script)} · ${escapeHtml(at.position.script)}:${at.position.event}`
        : "Begin the story";
    app.innerHTML = `
      <div class="title">
        <div class="title-snow" aria-hidden="true"></div>
        <div class="title-main">
          <div class="title-logo">
            <span class="title-over">ホワイトアルバム2</span>
            <h1><span>WHITE</span><span>ALBUM</span><b>2</b></h1>
            <div class="title-sub">Extended Edition <span class="web">· web port${data.demo ? " · demo" : packBase ? " · external pack" : ""}</span></div>
          </div>
          ${data.demo && packBase ? `<div class="warn-box">The external pack at <code>${escapeHtml(packBase)}</code> did not load. Check the URL, CORS headers, and that it contains <code>data/</code> and <code>assets/manifest.json</code>. The asset-free demo is shown instead.</div>` : ""}
          ${data.demo && !packBase ? `<div class="warn-box">Engine demo. No game data or assets are loaded; the scene and prose are original placeholder content. To play the story, build with your own legally-owned copy (docs/BYOA.md).</div>` : ""}
          ${!data.demo && packBase && assetsMissing ? `<div class="warn-box">The external data pack loaded, but <code>assets/manifest.json</code> did not. Check that the pack root also contains <code>assets/</code> and that CORS allows the JSON request. Visuals and audio will stay unavailable until it loads.</div>` : ""}
          ${!data.demo && data.incomplete.length > 0 ? `<div class="warn-box">Data incomplete: ${data.incomplete.length} scripts failed to load, usually a stale cache. Hard-refresh with Ctrl+Shift+R. Missing: <code>${escapeHtml(data.incomplete.slice(0, 5).join(", "))}</code></div>` : ""}
          <nav class="menu" aria-label="Main menu">
            <button data-m="read" class="primary">${primary}<span class="mi-sub">${primarySub}</span></button>
            <button data-m="new">${data.demo ? "Restart demo" : "New game"}</button>
            <button data-m="flow">Flowchart</button>
            <button data-m="guide">Guide</button>
            <button data-m="special">Special contents</button>
            <button data-m="saves">Save / Load</button>
            <button data-m="settings">Settings</button>
          </nav>
        </div>
        <div class="title-art">${snowflakeSvg()}</div>
        <div class="title-foot">
          <span>Fan-made web engine. Bring your own legally-owned assets.</span>
          <span>No game content is bundled.</span>
        </div>
      </div>`;
    app.querySelectorAll("[data-m]").forEach((b) =>
      b.addEventListener("click", () => {
        const m = (b as HTMLElement).dataset.m!;
        if (m === "new") {
          if (confirm("Start a new game from the beginning? The autosave resets; existing slots, quick save, and imported saves are kept.")) {
            save = freshStart();
            save.position = skipLatches(router, save.position, save.flags);
            writeAutosave(localStorage, save);
            screen = "read";
            render();
          }
          return;
        }
        backTo = "title";
        screen = m as Screen;
        render();
      }),
    );
    return;
  }
  if (screen === "read") {
    app.innerHTML = `<div id="reader"></div>`;
    renderReader(app.querySelector("#reader") as HTMLElement, {
      router, save,
      demo: data.demo,
      settings: {
        textSpeed: settings.textSpeed,
        autoDelay: settings.autoDelay,
        voiceVol: settings.voiceVol,
        bgmVol: settings.bgmVol,
        skipRead: settings.skipRead,
      },
      skip: skipState,
      ...hooks,
    });
    return;
  }
  if (screen === "flow") {
    app.innerHTML = `<div class="screen"></div>`;
    const s = app.querySelector(".screen") as HTMLElement;
    renderFlowchart(s, {
      flow: data.flow, save, spoiler: settings.spoiler,
      spine: router.spine,
      links: data.links.links,
      terminals: data.terminals.terminals,
      dev: settings.dev,
      onJump: (script) => {
        save = newSave("debug", { script, event: 0 });
        save.visited.push(script);
        save.position = skipLatches(router, save.position, save.flags);
        writeAutosave(localStorage, save);
        screen = "read";
        render();
      },
      onBack: () => { screen = backTo; render(); },
    });
    return;
  }
  if (screen === "guide") {
    app.innerHTML = `<div class="screen"></div>`;
    renderGuide(
      app.querySelector(".screen") as HTMLElement,
      data.flow, data.endings as unknown as GuideData, save,
      settings.spoiler,
      () => { screen = backTo; render(); },
    );
    return;
  }
  if (screen === "special") {
    const novelBase = packBase ? `${packBase}/data/novels/` : "data/novels/";
    const novelDir = packBase
      ? "the pack's <code>data/novels/</code>"
      : "<code>data/novels/</code>";
    const novels = [
      "The Idol Who Forgot How to Sing.pdf",
      "The Snow Melts, and Until the Snow Falls.pdf",
    ];
    const novelList = data.demo
      ? `<p class="dim">Novel PDFs are not bundled with the engine demo.</p>`
      : `<ul class="novel-list">${novels.map((name) =>
        `<li><a href="${escapeAttr(novelBase + name)}" target="_blank" rel="noopener">${escapeHtml(name.replace(/\.pdf$/, ""))}</a></li>`,
      ).join("")}</ul>`;
    app.innerHTML = `<div class="screen">
      ${screenHead(
        "Special contents",
        data.demo
          ? `Bonus novels and extra scenes. The demo does not include the PDFs or the full scenario set.`
          : `Bonus novels and extra scenes. Novel PDFs open in a new tab and are not bundled; place them in ${novelDir} (see docs/BYOA.md).`,
      )}
      <h3>Digital novels</h3>
      ${novelList}
      <h3>Extra scenarios</h3>
      <ul class="novel-list novel-grid" id="spec-list"></ul>
      <button class="back" data-back>← Back</button>
    </div>`;
    const list = app.querySelector("#spec-list") as HTMLElement;
    const specs = data.scenarios.map((s) => s.script).filter((id) =>
      /^(4|5[24]|6|7)/.test(id) && !/^(500[0-4]|510[0-4])$/.test(id)).sort();
    for (const id of specs) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.textContent = `Extra scenario ${id}`;
      b.onclick = () => {
        save = newSave(`special-${id}`, { script: id, event: 0 });
        save.visited.push(id);
        save.position = skipLatches(router, save.position, save.flags);
        writeAutosave(localStorage, save);
        screen = "read";
        render();
      };
      li.appendChild(b);
      list.appendChild(li);
    }
    if (specs.length === 0) {
      list.innerHTML = `<li class="dim">No extra scenarios in this build.</li>`;
    }
    app.querySelector("[data-back]")?.addEventListener("click", () => { screen = backTo; render(); });
    return;
  }
  if (screen === "saves") {
    app.innerHTML = `<div class="screen"></div>`;
    renderSaves(app.querySelector(".screen") as HTMLElement, {
      router,
      save,
      onLoad: loadSaveIntoGame,
      onBack: () => { screen = backTo; render(); },
      notify,
    });
    return;
  }
  if (screen === "log") {
    app.innerHTML = `<div class="screen">
      ${screenHead("Backlog", "Every line shown in this playthrough, oldest first.")}
      <ol class="log">${save.log.map((l) =>
        `<li>${l.speaker ? `<b>${escapeHtml(l.speaker)}</b> ` : ""}${escapeHtml(l.text)}</li>`).join("")}
      </ol>
      <button class="back" id="back">← Back</button>
    </div>`;
    app.querySelector("#back")?.addEventListener("click", () => { screen = backTo; render(); });
    return;
  }
  if (screen === "settings") {
    app.innerHTML = `<div class="screen">
      ${screenHead("Settings", "Reading pace, audio levels, and what the flowchart may reveal.")}
      <div class="settings">
        <section class="settings-group">
          <h3>Reading</h3>
          <label class="setting">
            <span class="setting-label">Text size<small>Applies immediately to the dialogue window.</small></span>
            <input type="range" id="fs" min="14" max="26" value="${settings.fontSize}">
          </label>
          <label class="setting">
            <span class="setting-label">Text speed<small>Characters per second; zero reveals each line at once.</small></span>
            <span class="range-row"><input type="range" id="ts" min="0" max="120" step="5" value="${settings.textSpeed}"> <span class="range-out" id="ts-val">${settings.textSpeed === 0 ? "instant" : settings.textSpeed + "/s"}</span></span>
          </label>
          <label class="setting">
            <span class="setting-label">Auto-play delay<small>Wait this long after a line finishes, then advance.</small></span>
            <span class="range-row"><input type="range" id="ad" min="0" max="8000" step="500" value="${settings.autoDelay}"> <span class="range-out" id="ad-val">${settings.autoDelay === 0 ? "off" : (settings.autoDelay / 1000) + "s"}</span></span>
          </label>
          <label class="setting">
            <span class="setting-label">Skip only read text<small>When on, holding Ctrl stops at the first unread line.</small></span>
            <input type="checkbox" id="sr" ${settings.skipRead ? "checked" : ""}>
          </label>
        </section>

        <section class="settings-group">
          <h3>Audio</h3>
          <label class="setting">
            <span class="setting-label">Voice volume<small>Applies to the current line and future clips.</small></span>
            <span class="range-row"><input type="range" id="vv" min="0" max="100" value="${Math.round(settings.voiceVol * 100)}"> <span class="range-out" id="vv-val">${Math.round(settings.voiceVol * 100)}%</span></span>
          </label>
          <label class="setting">
            <span class="setting-label">Music volume<small>Background music only; sound effects keep their own mix.</small></span>
            <span class="range-row"><input type="range" id="bv" min="0" max="100" value="${Math.round(settings.bgmVol * 100)}"> <span class="range-out" id="bv-val">${Math.round(settings.bgmVol * 100)}%</span></span>
          </label>
        </section>

        <section class="settings-group">
          <h3>Flowchart and guide</h3>
          <label class="setting">
            <span class="setting-label">Show spoilers<small>Reveal options and endings you have not reached yet.</small></span>
            <input type="checkbox" id="sp" ${settings.spoiler ? "checked" : ""}>
          </label>
          <label class="setting">
            <span class="setting-label">Developer mode<small>Adds a scene-jump button to the flowchart node details.</small></span>
            <input type="checkbox" id="dv" ${settings.dev ? "checked" : ""}>
          </label>
        </section>
      </div>
      <button class="back" id="back">← Back</button>
    </div>`;
    const sp = app.querySelector("#sp") as HTMLInputElement;
    sp.onchange = () => {
      settings.spoiler = sp.checked;
      localStorage.setItem("wa2web.spoiler", sp.checked ? "1" : "0");
    };
    const dv = app.querySelector("#dv") as HTMLInputElement;
    dv.onchange = () => {
      settings.dev = dv.checked;
      persistSettings();
    };
    const sr = app.querySelector("#sr") as HTMLInputElement;
    sr.onchange = () => {
      settings.skipRead = sr.checked;
      persistSettings();
    };
    const fs = app.querySelector("#fs") as HTMLInputElement;
    fs.oninput = () => {
      settings.fontSize = clampFont(Number(fs.value));
      persistSettings();
      applySettings();
    };
    const ts = app.querySelector("#ts") as HTMLInputElement;
    ts.oninput = () => {
      settings.textSpeed = Number(ts.value);
      persistSettings();
      // Update the readout in place: a full render() replaces the slider
      // node mid-drag, which cancels the drag after the first step.
      const out = app.querySelector("#ts-val");
      if (out) out.textContent = settings.textSpeed === 0 ? "instant" : `${settings.textSpeed}/s`;
    };
    const ad = app.querySelector("#ad") as HTMLInputElement;
    ad.oninput = () => {
      settings.autoDelay = Number(ad.value);
      persistSettings();
      const out = app.querySelector("#ad-val");
      if (out) out.textContent = settings.autoDelay === 0 ? "off" : `${settings.autoDelay / 1000}s`;
    };
    const vv = app.querySelector("#vv") as HTMLInputElement;
    vv.oninput = () => {
      settings.voiceVol = Number(vv.value) / 100;
      const voice = document.getElementById("voice") as HTMLAudioElement | null;
      if (voice) voice.volume = settings.voiceVol;
      const out = app.querySelector("#vv-val");
      if (out) out.textContent = `${Math.round(settings.voiceVol * 100)}%`;
      persistSettings();
    };
    const bv = app.querySelector("#bv") as HTMLInputElement;
    bv.oninput = () => {
      settings.bgmVol = Number(bv.value) / 100;
      const bgm = document.getElementById("bgm") as HTMLAudioElement | null;
      if (bgm) bgm.volume = settings.bgmVol;
      const out = app.querySelector("#bv-val");
      if (out) out.textContent = `${Math.round(settings.bgmVol * 100)}%`;
      persistSettings();
    };
    app.querySelector("#back")?.addEventListener("click", () => { screen = backTo; render(); });
    return;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

boot().catch((err) => {
  console.error("[wa2] boot failed", err);
  const msg = err instanceof Error ? err.message : String(err);
  const retry = new URL(location.href);
  retry.searchParams.delete("pack");
  app.innerHTML = `<div class="screen">
    ${screenHead("Could not start", "The player stopped before it could draw the title screen.")}
    <p class="dim">${escapeHtml(msg)}</p>
    <a class="back" href="${escapeAttr(retry.href)}">Reload the asset-free demo</a>
  </div>`;
});
