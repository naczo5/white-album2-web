import { loadManifest } from "./engine/assets";
import { Router, chapterOfScript } from "./engine/router";
import { newSave, readAutosave, readProfile, readQuicksave, setSaveNamespace, writeAutosave, writeProfile, writeQuicksave } from "./engine/save";
import type { SaveData, SysProfile } from "./engine/types";
import { loadGameData, resolvePackBase, type GameData } from "./ui/data";
import { renderFlowchart, sceneLabel } from "./ui/flowchart";
import { renderGuide, type GuideData } from "./ui/guide";
import { ingestReadKeys, installLutFilters, pauseReader, pushLog, renderReader, resetPaintState, resetSkip, resumeAudio, setBgmLookup, setBnrLookup, setReaderLive, setScenarioLookup, setSpeakerLookup, setSkipping, setTextHidden, setVoiceLookup, skipLatches, suspendAudio, toggleText } from "./ui/reader";
import { stopMovie } from "./ui/movie";
import { applyProfileToRun, renderSaves } from "./ui/saves";
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
  unlockAllChoices: boolean; // bypass choice flag locks (e.g. Chiaki True)
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
  unlockAllChoices: safeStorageGet("wa2web.unlockAllChoices") === "1",
};

let skipState = { active: false };
let toastTimer: number | null = null;

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
    localStorage.setItem("wa2web.unlockAllChoices", settings.unlockAllChoices ? "1" : "0");
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
/** Global progress imported from `Sys.sav` (read lines, endings, unlocks).
 * Lives outside `save` so a new game or a slot load never erases it. */
let profile: SysProfile | null = null;
let screen: Screen = "title";
/** External BYOA pack root configured via VITE_PACK_URL (main path for
 * decoupled hosting) or overridden via `?pack=`. Nothing copyrighted is
 * committed to this repo. See docs/BYOA.md. */
let packBase = "";
let packFromQuery = false;
/** Data loaded from a configured pack root, but assets/manifest.json did
 * not. Surfaced as a title warning so a pack/CORS misconfiguration is
 * diagnosable. */
let assetsMissing = false;
let backTo: Screen = "title";

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

const GATE_SLOT_NAMES: Record<string, string> = {
  icClearSlot: "icClear",
  replaySlot: "replay",
  chiakiNormalSlot: "chiakiNormal",
  ccClearSlot: "ccClear",
  codaClearSlot: "codaClear",
  codaEnteredSlot: "codaEntered",
  setsunaCcSlot: "setsunaCc",
  codaSetsunaTrueSlot: "codaSetsunaTrue",
};

function recordRunEnding(id: string): void {
  if (id && save && !save.endings.includes(id)) save.endings.push(id);
}

function recordGameFlag(id: number, val: number): void {
  if (val === 0) return;
  if (!profile) {
    profile = {
      version: 1,
      importedAt: new Date().toISOString(),
      readKeys: [],
      visited: [],
      endings: [],
      seenPicks: {},
      cg: [],
      music: [],
      movies: [],
      ero: [],
      gates: {},
      gameFlags: {},
    };
  }
  const key = String(id);
  profile.gameFlags = { ...(profile.gameFlags ?? {}), [key]: val };
  const endingId = data.sysSlots?.endingSlots?.[key];
  if (endingId) {
    if (!profile.endings.includes(endingId)) profile.endings.push(endingId);
    recordRunEnding(endingId);
  }
  if (data.sysSlots?.gateSlots) {
    for (const [slotKey, slotIdx] of Object.entries(data.sysSlots.gateSlots)) {
      if (slotIdx === id && GATE_SLOT_NAMES[slotKey]) {
        profile.gates[GATE_SLOT_NAMES[slotKey]] = val;
      }
    }
  }
  writeProfile(localStorage, profile);
  router.setProfileGameFlags(profile.gameFlags);
}

async function boot(): Promise<void> {
  applySettings();
  const q = new URLSearchParams(location.search);
  const resolved = resolvePackBase(import.meta.env.VITE_PACK_URL, location.search, location.href);
  packBase = resolved.packBase;
  packFromQuery = resolved.fromQuery;
  data = await loadGameData(packBase);
  setSaveNamespace(dataNamespace());
  // Global progress (Sys.sav import) is stored under the same namespace and
  // is independent of any run save: load it once, seed the read set so
  // skip-read honours imported lines, and keep it live for the screens.
  profile = readProfile(localStorage);
  if (profile && profile.readKeys.length > 0) ingestReadKeys(profile.readKeys);
  router = new Router(data.scenarios, data.flow, data.links, data.terminals, {
    cfg: data.cfg,
    profileGameFlags: profile?.gameFlags,
    endingSlots: data.sysSlots?.endingSlots,
    unlockAllChoices: settings.unlockAllChoices,
    onGameFlag: recordGameFlag,
  });
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
  const manifest = data.demo
    ? null
    : await loadManifest(packBase ? `${packBase}/assets/manifest.json` : "assets/manifest.json");
  assetsMissing = !data.demo && !!packBase && !manifest;
  if (data.luts) {
    installLutFilters(data.luts);
  } else if (!data.demo) {
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
  // Global progress also feeds this run's visited/endings sets (the
  // flowchart and guide read them), never the position, backlog or picks.
  // No autosave write here: boot must not fabricate a "Continue" entry.
  applyProfileToRun(save, profile);
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
  if (!save.flags.cfg || save.flags.cfg.script !== save.position.script) {
    save.position = router.seek(save.position, save.flags, save.picks);
  }
  save.position = skipLatches(router, save.position, save.flags, recordRunEnding);
  pushLog(router, save);
  render();
  // Enter/click = advance (first press completes typing instantly, next
  // advances); hold Ctrl = skip (released on keyup / focus loss). Key
  // repeat is ignored so holding Enter never fast-forwards. Skip state is
  // a shared mutable object read live by the reader hooks — setSkipping
  // starts/stops the reader's 120 ms advance loop WITHOUT re-rendering
  // (a re-render restarted the typewriter mid-line = the flicker bug).
  window.addEventListener("keydown", (e) => {
    // Esc closes any overlay back to where it was opened.
    if (e.key === "Escape" && screen !== "title" && screen !== "read") {
      e.preventDefault();
      go(backTo);
      return;
    }
    if (screen !== "read") return;
    // `H` (and Esc while reading) toggles the text-free stage; a second
    // press restores it without advancing.
    if ((e.key === "h" || e.key === "H" || e.key === "Escape") && !e.repeat) {
      if (document.querySelector(".movie-mode")) return; // movie HUD owns Esc
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body &&
        active.closest("button, a, input, select, textarea, [role='button']")) return;
      e.preventDefault();
      toggleText(document.querySelector(".reader") as HTMLElement | null);
      return;
    }
    if (e.key === "Control" && !skipState.active && !e.repeat) {
      // Ctrl-skip pauses while the film owns the stage. A key still held
      // from before the film opened must not resurrect skip when the
      // browser auto-repeats it: the reader released it at `onOpen`.
      if (!document.querySelector(".movie-mode")) setSkipping(true);
      return;
    }
    if ((e.code === "Enter" || e.code === "Space") && !e.repeat) {
      // A focused choice/HUD control owns Enter/Space; only body focus
      // advances (Space on a button must press the button).
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body &&
        active.closest("button, a, input, select, textarea, [role='button']")) return;
      e.preventDefault();
      const reader = document.querySelector(".reader") as HTMLElement | null;
      if (!reader) return;
      if (reader.classList.contains("text-hidden")) {
        setTextHidden(false);
        toggleText(reader, false);
        return;
      }
      (reader as HTMLElement).click();
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Control" && skipState.active) setSkipping(false);
  });
  window.addEventListener("blur", () => {
    if (skipState.active) setSkipping(false);
  });
  setReaderLive(screen === "read");
}

function freshStart(): SaveData {
  const first = data.scenarios[0]?.script ?? "demo-1";
  const s = newSave("Haruki", { script: first, event: 0 });
  s.visited.push(first);
  s.position = router.seek(s.position, s.flags, s.picks);
  // Global progress survives a new game: the flowchart still shows what the
  // player has already read in the original build.
  applyProfileToRun(s, profile);
  return s;
}

function applySettings(): void {
  document.documentElement.style.setProperty("--fontsize", `${settings.fontSize}px`);
}

function notify(msg: string): void {
  const t = document.getElementById("toast")!;
  t.textContent = msg;
  t.classList.add("show");
  // One owner per toast: rapid messages (Q.Save spam, ending + autosave)
  // must not have an older timeout cut the newer message short.
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastTimer = null;
    t.classList.remove("show");
  }, 2500);
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
  if (!save.flags.cfg || save.flags.cfg.script !== save.position.script) {
    save.position = router.seek(save.position, save.flags, save.picks);
  }
  save.position = skipLatches(router, save.position, save.flags, recordRunEnding);
  if (!save.visited.includes(save.position.script)) save.visited.push(save.position.script);
  // A loaded run still sees the global profile's visited/endings union.
  applyProfileToRun(save, profile);
  pushLog(router, save);
  writeAutosave(localStorage, save);
  stopMovie();
  resetSkip();
  resetPaintState();
  skipState.active = false;
  backTo = "title";
  go("read");
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
    go(s as Screen);
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

/** Every screen change goes through here: leaving the reader pauses Auto,
 * releases skip, stops a playing film and (for the title) silences the mix
 * so nothing keeps advancing or playing behind a menu. Entering the reader
 * restores the mix and re-syncs BGM from the save. */
function go(next: Screen): void {
  const leavingRead = screen === "read" && next !== "read";
  if (leavingRead) {
    pauseReader();
    resetSkip();
    skipState.active = false;
    // Suspend before closing the layer: stopMovie() would otherwise restore
    // the BGM we are just about to silence (audible blip on the title).
    if (next === "title") suspendAudio();
    stopMovie();
  }
  if (next === "title" && screen !== "title" && !leavingRead) {
    suspendAudio();
  } else if (next === "read" && screen !== "read") {
    resumeAudio();
  }
  screen = next;
  setReaderLive(next === "read");
  render();
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
        ? (settings.dev
          ? `${chapterLabel(at.position.script)} · ${escapeHtml(at.position.script)}:${at.position.event}`
          : `${escapeHtml(sceneLabel(at.position.script, data.flow, { spoiler: true, visited: true }))} · continue where you left off`)
        : "Begin the story";
    app.innerHTML = `
      <div class="title">
        <div class="title-snow" aria-hidden="true"></div>
        <div class="title-main">
          <div class="title-logo">
            <span class="title-over">ホワイトアルバム2</span>
            <h1><span>WHITE</span><span>ALBUM</span><b>2</b></h1>
            <div class="title-sub">Extended Edition <span class="web">· web port${data.demo ? " · demo" : packFromQuery ? " · external pack" : ""}</span></div>
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
            save.position = skipLatches(router, save.position, save.flags, recordRunEnding);
            writeAutosave(localStorage, save);
            resetPaintState();
            backTo = "title";
            go("read");
          }
          return;
        }
        backTo = "title";
        go(m as Screen);
      }),
    );
    return;
  }
  if (screen === "read") {
    let readerEl = app.firstElementChild as HTMLElement | null;
    if (!readerEl || readerEl.id !== "reader") {
      app.innerHTML = `<div id="reader"></div>`;
      readerEl = app.firstElementChild as HTMLElement;
    }
    renderReader(readerEl, {
      router, save,
      demo: data.demo,
      settings: {
        textSpeed: settings.textSpeed,
        autoDelay: settings.autoDelay,
        voiceVol: settings.voiceVol,
        bgmVol: settings.bgmVol,
        skipRead: settings.skipRead,
        dev: settings.dev,
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
      cfg: data.cfg,
      dev: settings.dev,
      profile,
      onJump: (script) => {
        save = newSave("debug", { script, event: 0 });
        save.visited.push(script);
        save.position = router.seek(save.position, save.flags, save.picks);
        save.position = skipLatches(router, save.position, save.flags, recordRunEnding);
        writeAutosave(localStorage, save);
        resetPaintState();
        backTo = "flow";
        go("read");
      },
      onBack: () => go(backTo),
    });
    return;
  }
  if (screen === "guide") {
    app.innerHTML = `<div class="screen"></div>`;
    renderGuide(
      app.querySelector(".screen") as HTMLElement,
      data.flow, data.endings as unknown as GuideData, save,
      settings.spoiler,
      () => go(backTo),
      { profile, dev: settings.dev },
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
        save.position = router.seek(save.position, save.flags, save.picks);
        save.position = skipLatches(router, save.position, save.flags, recordRunEnding);
        writeAutosave(localStorage, save);
        resetPaintState();
        backTo = "special";
        go("read");
      };
      li.appendChild(b);
      list.appendChild(li);
    }
    if (specs.length === 0) {
      list.innerHTML = `<li class="dim">No extra scenarios in this build.</li>`;
    }
    app.querySelector("[data-back]")?.addEventListener("click", () => go(backTo));
    return;
  }
  if (screen === "saves") {
    app.innerHTML = `<div class="screen"></div>`;
    renderSaves(app.querySelector(".screen") as HTMLElement, {
      router,
      save,
      sysSlots: data.sysSlots,
      flow: data.flow,
      profile,
      dev: settings.dev,
      onProfileChange: (p) => {
        profile = p;
        router.setProfileGameFlags(profile?.gameFlags);
        if (applyProfileToRun(save, profile)) writeAutosave(localStorage, save);
      },
      onLoad: loadSaveIntoGame,
      onBack: () => go(backTo),
      notify,
    });
    return;
  }
  if (screen === "log") {
    app.innerHTML = `<div class="screen">
      ${screenHead("Backlog", "Every line shown in this playthrough, oldest first.")}
      <ol class="log" id="log">${save.log.map((l) =>
        `<li>${l.speaker ? `<b>${escapeHtml(l.speaker)}</b> ` : ""}${escapeHtml(l.text)}</li>`).join("")}
      </ol>
      <button class="back" id="back">← Back</button>
    </div>`;
    // The backlog exists to re-read the last line: open at the newest
    // entry, not at the top of a 500-line scroll.
    const logEl = app.querySelector("#log") as HTMLElement | null;
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
    app.querySelector("#back")?.addEventListener("click", () => go(backTo));
    // Esc / wheel-down / a tap outside the list returns to the story too.
    logEl?.addEventListener("click", (e) => {
      if (e.target === logEl) go(backTo);
    });
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
            <span class="setting-label">Unlock all choice routes<small>Allow locked NG+ choice options (such as Chiaki True) on a first playthrough.</small></span>
            <input type="checkbox" id="ul" ${settings.unlockAllChoices ? "checked" : ""}>
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
    const ul = app.querySelector("#ul") as HTMLInputElement;
    ul.onchange = () => {
      settings.unlockAllChoices = ul.checked;
      router.setUnlockAllChoices(settings.unlockAllChoices);
      persistSettings();
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
    app.querySelector("#back")?.addEventListener("click", () => go(backTo));
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
