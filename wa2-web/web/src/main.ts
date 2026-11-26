import { loadManifest, voiceUrl, voiceUrlByKey } from "./engine/assets";
import { Router, chapterOfScript, isExtraScenario } from "./engine/router";
import { newSave, readAutosave, readProfile, readQuicksave, setSaveNamespace, storageKey, writeAutosave, writeProfile, writeQuicksave } from "./engine/save";
import type { SaveData, SysProfile } from "./engine/types";
import {
  activeTranslationId,
  loadGameData,
  loadNativePos,
  loadTranslations,
  overlayTranslationId,
  resolvePackBase,
  shouldAskTranslation,
  type GameData,
  type TranslationInfo,
} from "./ui/data";
import { renderFlowchart, sceneLabel } from "./ui/flowchart";
import { playPreviewAudio, previewPlayingUrl, renderExtras, stopPreviewAudio } from "./ui/gallery";
import { renderGuide, type GuideData } from "./ui/guide";
import { newWheelState, normalizeWheelDelta, wheelDirectionGesture } from "./engine/wheel";
import { applySeVolume, armWheelCooldown, ingestReadKeys, installLutFilters, pauseReader, pushLog, renderReader, resetAudioCursors, resetPaintState, resetSkip, resolveReaderKey, resumeAudio, setBgmLookup, setBnrLookup, setReaderLive, setScenarioLookup, setSpeakerLookup, setSkipping, setTextHidden, setVoiceChrLookup, setVoiceLookup, skipLatches, suspendAudio, toggleText } from "./ui/reader";
import { stopMovie } from "./ui/movie";
import { applyProfileToRun, renderSaves } from "./ui/saves";
import "./style.css";

type Screen = "title" | "read" | "flow" | "guide" | "special" | "extras" | "saves" | "log" | "settings";

interface Settings {
  spoiler: boolean;
  fontSize: number;
  textSpeed: number; // chars/sec, 0 = instant
  autoDelay: number; // ms, 0 = off
  voiceVol: number; // 0..1
  seVol: number; // 0..1; engine default se_vol = 195/255
  bgmVol: number; // 0..1
  /** Original `ero_voice`: play non-heroine voices during EroMode scenes. */
  eroVoice: boolean;
  skipRead: boolean; // true: Ctrl skips only already-read lines
  dev: boolean; // dev mode: scene-jump buttons in the flowchart
  unlockAllChoices: boolean; // bypass choice flag locks (e.g. Chiaki True)
  /** Flowchart: unreached scene cards show a black plate instead of a
   * blurred still (default on = no visual spoilers at all). */
  hideUnrevealed: boolean;
  /** Active alternative translation id ("" = pack default). Persisted;
   * changing it reloads the page so the alternate script set loads. */
  translation: string;
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
  seVol: storedNumber("wa2web.seVol", 195 / 255, 0, 1),
  bgmVol: storedNumber("wa2web.bgmVol", 0.7, 0, 1),
  // Original default is ero_voice=0 (play every voice); only an explicit
  // "off" suppresses non-heroine voices in EroMode.
  eroVoice: safeStorageGet("wa2web.eroVoice") !== "0",
  skipRead: safeStorageGet("wa2web.skipRead") === "1",
  dev: safeStorageGet("wa2web.dev") === "1",
  unlockAllChoices: safeStorageGet("wa2web.unlockAllChoices") === "1",
  // Default ON: unreached cards are black. Only an explicit "0" opts into
  // the frosted (blurred) still.
  hideUnrevealed: safeStorageGet("wa2web.hideUnrevealed") !== "0",
  // Active alternative translation; resolved against the pack at boot.
  translation: safeStorageGet("wa2web.translation") ?? "",
};

let skipState = { active: false };
let skipHold = false;
let skipToggle = false;
const logWheelState = newWheelState();
let toastTimer: number | null = null;

function clearSkipFlags(): void {
  skipHold = false;
  skipToggle = false;
  skipState.active = false;
}

function syncSkip(): void {
  const next = skipHold || skipToggle;
  if (next !== skipState.active) setSkipping(next);
}

function toggleFullscreen(): void {
  if (typeof document === "undefined") return;
  if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
  } else {
    document.documentElement.requestFullscreen?.().catch(() => {});
  }
}

function persistSettings(): void {
  try {
    localStorage.setItem("wa2web.spoiler", settings.spoiler ? "1" : "0");
    localStorage.setItem("wa2web.fontSize", String(settings.fontSize));
    localStorage.setItem("wa2web.textSpeed", String(settings.textSpeed));
    localStorage.setItem("wa2web.autoDelay", String(settings.autoDelay));
    localStorage.setItem("wa2web.voiceVol", String(settings.voiceVol));
    localStorage.setItem("wa2web.seVol", String(settings.seVol));
    localStorage.setItem("wa2web.bgmVol", String(settings.bgmVol));
    localStorage.setItem("wa2web.eroVoice", settings.eroVoice ? "1" : "0");
    localStorage.setItem("wa2web.skipRead", settings.skipRead ? "1" : "0");
    localStorage.setItem("wa2web.dev", settings.dev ? "1" : "0");
    localStorage.setItem("wa2web.unlockAllChoices", settings.unlockAllChoices ? "1" : "0");
    localStorage.setItem("wa2web.hideUnrevealed", settings.hideUnrevealed ? "1" : "0");
    localStorage.setItem("wa2web.translation", settings.translation);
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
/** Translation catalog published by the pack ("" entries: only the default).
 * Populated at boot; drives the new-game choice and the settings entry. */
let translations: TranslationInfo[] = [];
/** Active translation id ("" = pack default / demo). */
let activeTranslation = "";
/** Whether the player has already chosen a translation (ask once). */
let translationPicked = safeStorageGet("wa2web.translationPicked") === "1";

function markTranslationPicked(): void {
  translationPicked = true;
  try {
    localStorage.setItem("wa2web.translationPicked", "1");
  } catch {
    /* settings are a convenience */
  }
}

/** Scene replay is a detached preview: the reader still autosaves BGM and
 * advances, but the player's real autosave must survive the detour. Keep the
 * pre-replay bytes and put them back when the replay ends (or on unload). */
let replayGuardActive = false;
let replayAutosaveKey: string | null = null;
let replayAutosaveRaw: string | null = null;
/** The in-memory run the replay detached from. Restoring only localStorage
 * left `save` pointing at the replay, so Title → Continue resumed the
 * preview and its next advance overwrote the restored autosave. */
let replaySaveSnapshot: SaveData | null = null;

function beginReplayAutosaveGuard(): void {
  if (replayGuardActive) return;
  replayGuardActive = true;
  replaySaveSnapshot = save;
  try {
    replayAutosaveKey = storageKey("autosave");
    replayAutosaveRaw = localStorage.getItem(replayAutosaveKey);
  } catch {
    replayAutosaveKey = null;
    replayAutosaveRaw = null;
  }
}

/** Discard the guard, optionally restoring the pre-replay autosave.
 * `restore = false` is used when a real save/new game replaces the replay. */
function endReplayAutosaveGuard(restore = true): void {
  if (!replayGuardActive) return;
  replayGuardActive = false;
  const key = replayAutosaveKey;
  const raw = replayAutosaveRaw;
  const snapshot = replaySaveSnapshot;
  replayAutosaveKey = null;
  replayAutosaveRaw = null;
  replaySaveSnapshot = null;
  if (!restore) return;
  try {
    if (key) {
      if (raw === null) localStorage.removeItem(key);
      else localStorage.setItem(key, raw);
    }
  } catch {
    /* storage unavailable: there is nothing durable to restore */
  }
  // Restore the live object too, not just the stored bytes: the title's
  // Continue path renders `save` directly.
  save = snapshot ?? readAutosave(localStorage) ?? freshStart();
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

/** Lazily materialize the global profile. A run can unlock endings, CGs,
 * music and scene flags before any `Sys.sav` is imported. */
function ensureProfile(): SysProfile {
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
  return profile;
}

function recordGameFlag(id: number, val: number): void {
  if (val === 0) return;
  const p = ensureProfile();
  const key = String(id);
  p.gameFlags = { ...(p.gameFlags ?? {}), [key]: val };
  const endingId = data.sysSlots?.endingSlots?.[key];
  if (endingId) {
    if (!p.endings.includes(endingId)) p.endings.push(endingId);
    recordRunEnding(endingId);
  }
  if (data.sysSlots?.gateSlots) {
    for (const [slotKey, slotIdx] of Object.entries(data.sysSlots.gateSlots)) {
      if (slotIdx === id && GATE_SLOT_NAMES[slotKey]) {
        p.gates[GATE_SLOT_NAMES[slotKey]] = val;
      }
    }
  }
  // Region C unlock bands. Sys.sav import fills these from a file; a live
  // run must grow them too or the Extras menus stay empty until an import.
  if (id >= 101 && id <= 199) {
    const track = id - 100;
    if (!p.music.includes(track)) p.music.push(track);
  } else if (id >= 201 && id <= 224) {
    const movie = id - 200;
    if (!p.movies.includes(movie)) p.movies.push(movie);
  } else if (id >= 300 && id <= 322) {
    const ero = id - 300;
    if (!p.ero.includes(ero)) p.ero.push(ero);
  }
  writeProfile(localStorage, p);
  router.setProfileGameFlags(p.gameFlags);
}

/** Gallery unlock for a shown grp/v overlay. `h` CGs are stored as Region B
 * part 1 (`1_000_000 + cgId`), matching `SysProfile.cg`/`Sys.sav`. */
function recordCg(id: number): void {
  if (!Number.isFinite(id) || id <= 0) return;
  const p = ensureProfile();
  if (p.cg.includes(id)) return;
  p.cg.push(id);
  writeProfile(localStorage, p);
}

async function boot(): Promise<void> {
  applySettings();
  const setBootStatus = (text: string) => {
    const el = document.getElementById("boot-status");
    if (el) el.textContent = text;
  };
  setBootStatus("Loading story data…");
  const q = new URLSearchParams(location.search);
  const resolved = resolvePackBase(import.meta.env.VITE_PACK_URL, location.search, location.href);
  packBase = resolved.packBase;
  packFromQuery = resolved.fromQuery;
  translations = await loadTranslations(packBase);
  activeTranslation = activeTranslationId(translations, settings.translation);
  if (overlayTranslationId(translations, activeTranslation) !== "") {
    markTranslationPicked();
  }
  if (settings.translation !== activeTranslation) {
    // Stored id not offered by this pack (or a single-translation pack):
    // fall back to the pack default and keep the store honest.
    settings.translation = activeTranslation;
    persistSettings();
  }
  // The pack default is the base file set; only alternatives overlay.
  data = await loadGameData(packBase, overlayTranslationId(translations, activeTranslation));
  setBootStatus("Loading interface assets…");
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
  setVoiceChrLookup((script, ev) =>
    data.voicemap?.chars?.[script]?.[String(ev)]);
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
  setBootStatus("Preparing the stage…");
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
  if (scr && ["flow", "guide", "settings", "saves", "special", "extras", "log"].includes(scr)) {
    screen = scr as Screen;
  }
  if (!save.flags.cfg || save.flags.cfg.script !== save.position.script) {
    save.position = router.seek(save.position, save.flags, save.picks);
  }
  save.position = skipLatches(router, save.position, save.flags, recordRunEnding);
  pushLog(router, save);
  // A translation picked on the new-game chooser persists the choice and
  // reloads the page (the alternate script set loads at boot). Pick the
  // intended New game back up here, once the chosen translation is live.
  try {
    if (sessionStorage.getItem("wa2web.pendingNew") === "1") {
      sessionStorage.removeItem("wa2web.pendingNew");
      if (!data.demo && !data.translationFallback) beginNewGame();
    }
  } catch {
    /* storage blocked: fall through to the title screen */
  }
  render();
  // Enter/Space/PageDown/click = advance (first press completes typing
  // instantly, next advances); hold Ctrl or toggle Shift = skip (Shift
  // cancels on manual advance, hide-text, choice, movie, or unread stop).
  // Key repeat is ignored so holding Enter never fast-forwards. Skip state
  // is a shared mutable object read live by the reader hooks — setSkipping
  // starts/stops the reader's 120 ms advance loop WITHOUT re-rendering.
  window.addEventListener("keydown", (e) => {
    const txModal = document.querySelector(".tx-modal");
    if (e.key === "Escape" && txModal) {
      e.preventDefault();
      txModal.remove();
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    const focusedInput = !!(active && active.closest("input, select, textarea"));
    const focusedControl = !!(active && active !== document.body &&
      active.closest("button, a, input, select, textarea, [role='button']"));
    const focusedChoice = !!(active && active.closest(".choices .choice-btn"));

    if (e.altKey && (e.code === "Enter" || e.key === "Enter") && !e.repeat && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      toggleFullscreen();
      return;
    }

    // Esc or Backspace closes any overlay back to where it was opened.
    if (screen !== "title" && screen !== "read") {
      if (e.key === "Escape") {
        e.preventDefault();
        go(backTo);
        return;
      }
      if (e.key === "Backspace" && !e.repeat && !focusedInput &&
        !e.altKey && !e.ctrlKey && !e.metaKey &&
        !document.querySelector(".cg-overlay, .tx-modal")) {
        e.preventDefault();
        go(backTo);
        return;
      }
      return;
    }
    if (screen !== "read") return;

    const reader = document.querySelector(".reader") as HTMLElement | null;
    if (!reader) return;
    const choiceButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".choices .choice-btn"));
    const action = resolveReaderKey({
      key: e.key,
      code: e.code,
      repeat: e.repeat,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      movieMode: !!document.querySelector(".movie-mode"),
      textHidden: reader.classList.contains("text-hidden"),
      hasChoices: choiceButtons.length > 0,
      focusedInput,
      focusedControl,
      focusedChoice,
    });
    if (!action) return;
    e.preventDefault();

    switch (action.type) {
      case "fullscreen":
        toggleFullscreen();
        break;
      case "restore-text":
        setTextHidden(false);
        toggleText(reader, false);
        break;
      case "toggle-text":
        if (skipToggle) {
          skipToggle = false;
          syncSkip();
        }
        toggleText(reader);
        break;
      case "skip-hold-on":
        skipHold = true;
        syncSkip();
        break;
      case "skip-toggle":
        skipToggle = !skipToggle;
        syncSkip();
        break;
      case "backlog":
        hooks.open("log");
        break;
      case "advance":
        if (skipToggle) {
          skipToggle = false;
          syncSkip();
        }
        reader.click();
        break;
      case "choice-pick": {
        const btn = choiceButtons[action.index];
        if (btn && !btn.disabled) {
          skipToggle = false;
          syncSkip();
          btn.click();
        }
        break;
      }
      case "choice-move": {
        const enabled = choiceButtons.filter((b) => !b.disabled);
        if (enabled.length === 0) break;
        const cur = active ? enabled.indexOf(active as HTMLButtonElement) : -1;
        const nextIdx = cur === -1
          ? (action.delta > 0 ? 0 : enabled.length - 1)
          : (cur + action.delta + enabled.length) % enabled.length;
        enabled[nextIdx]?.focus();
        break;
      }
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Control" && skipHold) {
      skipHold = false;
      syncSkip();
    }
  });
  window.addEventListener("blur", () => {
    if (skipHold || skipToggle || skipState.active) {
      skipHold = false;
      skipToggle = false;
      syncSkip();
    }
  });
  // A reload mid-replay must not leave the preview in the Continue slot.
  window.addEventListener("pagehide", () => endReplayAutosaveGuard());
  setReaderLive(screen === "read");
}

/** Start a fresh run. Shared by the title menu, the translation chooser and
 * the post-reload handoff (a translation change reloads the page). */
function beginNewGame(): void {
  endReplayAutosaveGuard(false);
  save = freshStart();
  save.position = skipLatches(router, save.position, save.flags, recordRunEnding);
  writeAutosave(localStorage, save);
  resetPaintState();
  resetAudioCursors();
  backTo = "title";
  go("read");
}

/** First-choice overlay: which translation to read this playthrough with.
 * Only shown when the pack publishes more than one. The pick persists; when
 * it is not the active one the page reloads so the alternate scripts load,
 * and boot re-enters `beginNewGame` via the pendingNew flag. */
function showTranslationChoice(confirmReset = true): void {
  const esc = escapeAttr;
  const cards = translations.map((t) => `
      <div class="tx-card" data-tx="${esc(t.id)}">
        <div class="tx-card-head">
          <b>${escapeHtml(t.name ?? t.id)}</b>
          ${t.label ? `<span class="tx-label">${escapeHtml(t.label)}</span>` : ""}
        </div>
        ${t.desc ? `<p class="tx-desc">${escapeHtml(t.desc)}</p>` : ""}
        ${t.repo ? `<a class="tx-repo" href="${esc(t.repo)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t.repo.replace(/^https?:\/\/(www\.)?/, ""))}</a>` : ""}
        <button class="tx-pick" data-pick="${esc(t.id)}">${t.id === activeTranslation ? "Read with this translation" : "Switch to this translation"}</button>
      </div>`).join("");
  const box = document.createElement("div");
  box.className = "tx-modal";
  box.innerHTML = `
    <div class="tx-panel" role="dialog" aria-modal="true" aria-labelledby="tx-title">
      <h2 id="tx-title">Choose a translation</h2>
      <p class="tx-hint">Pick the script text for this playthrough. Your saves stay compatible; you can change it later in Settings.</p>
      <div class="tx-cards">${cards}</div>
      <button class="back tx-cancel">← Cancel</button>
    </div>`;
  app.appendChild(box);
  box.querySelector(".tx-cancel")?.addEventListener("click", () => box.remove());
  box.addEventListener("click", (e) => {
    if (e.target === box) box.remove();
  });
  box.querySelectorAll<HTMLButtonElement>("[data-pick]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.pick ?? "";
      if (confirmReset && !confirm("Start a new game from the beginning? The autosave resets; existing slots, quick save, and imported saves are kept.")) return;
      markTranslationPicked();
      settings.translation = id;
      persistSettings();
      if (id === activeTranslation) {
        box.remove();
        beginNewGame();
        return;
      }
      try {
        sessionStorage.setItem("wa2web.pendingNew", "1");
      } catch {
        /* storage blocked: the reload still applies the pick */
      }
      location.reload();
    });
  });
}

function freshStart(): SaveData {
  const first = data.scenarios[0]?.script ?? "demo-1";
  const s = newSave("Haruki", { script: first, event: 0 });
  // Record the translation this run was started with (display metadata;
  // playback itself follows the active setting, and event anchors are
  // translation-independent).
  if (activeTranslation) s.translation = activeTranslation;
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
  // A loaded save owns the autosave from here on; never restore the replay's
  // pre-detour snapshot over it.
  endReplayAutosaveGuard(false);
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
  resetAudioCursors();
  clearSkipFlags();
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
  onCg: recordCg,
  onSkipStop: () => {
    clearSkipFlags();
  },
  onManualInput: () => {
    if (skipToggle) {
      skipToggle = false;
      syncSkip();
    }
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
  // Extras music and backlog voice previews share one element; never let a
  // menu clip keep playing behind the reader or the title.
  if (next !== screen) stopPreviewAudio();
  const leavingRead = screen === "read" && next !== "read";
  if (leavingRead) {
    // Title/Extras end a scene replay; overlay screens (log, saves, chart,
    // guide, settings) return to it, so their own save paths clear the guard.
    if (next === "title" || next === "extras") endReplayAutosaveGuard();
    pauseReader();
    resetSkip();
    clearSkipFlags();
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

const SCREEN_TITLES: Record<Screen, string> = {
  title: "WHITE ALBUM 2 Extended Edition — Web Port & Browser Engine",
  read: "Reader — WHITE ALBUM 2 Web Port",
  flow: "Flowchart — WHITE ALBUM 2 Web Port",
  guide: "Walkthrough Guide — WHITE ALBUM 2 Web Port",
  extras: "Extras — WHITE ALBUM 2 Web Port",
  special: "Special Contents — WHITE ALBUM 2 Web Port",
  saves: "Save / Load — WHITE ALBUM 2 Web Port",
  log: "Backlog — WHITE ALBUM 2 Web Port",
  settings: "Settings — WHITE ALBUM 2 Web Port",
};

function render(): void {
  document.title = SCREEN_TITLES[screen] ?? SCREEN_TITLES.title;
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
          : `${escapeHtml(sceneLabel(at.position.script, data.flow, {
            spoiler: true, visited: true,
            bnr: data.bnr?.recs?.[at.position.script],
          }))} · continue where you left off`)
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
          ${!data.demo && data.translationFallback ? `<div class="warn-box">The selected translation's data did not load, so the pack default is shown. Rebuild the pack with <code>--alt</code> or pick another translation in Settings.</div>` : ""}
          ${!data.demo && data.incomplete.length > 0 ? `<div class="warn-box">Data incomplete: ${data.incomplete.length} scripts failed to load, usually a stale cache. Hard-refresh with Ctrl+Shift+R. Missing: <code>${escapeHtml(data.incomplete.slice(0, 5).join(", "))}</code></div>` : ""}
          <nav class="menu" aria-label="Main menu">
            <button data-m="read" class="primary">${primary}<span class="mi-sub">${primarySub}</span></button>
            <button data-m="new">${data.demo ? "Restart demo" : "New game"}</button>
            <button data-m="flow">Flowchart</button>
            <button data-m="guide">Guide</button>
            <button data-m="extras">Extras</button>
            <button data-m="special">Special contents</button>
            <button data-m="saves">Save / Load</button>
            <button data-m="settings">Settings</button>
          </nav>
        </div>
        <div class="title-art">${snowflakeSvg()}</div>
        <div class="title-foot">
          <span>Fan-made web engine. Bring your own legally-owned assets.</span>
          <span>No game content is bundled · <a href="https://github.com/naczo5/white-album2-web" target="_blank" rel="noopener noreferrer">GitHub</a></span>
        </div>
      </div>`;
    app.querySelectorAll("[data-m]").forEach((b) =>
      b.addEventListener("click", () => {
        const m = (b as HTMLElement).dataset.m!;
        if (m === "read" && !hasContinue && shouldAskTranslation(translations, data.demo, translationPicked)) {
          // Ask once before the first playthrough starts.
          showTranslationChoice(false);
          return;
        }
        if (m === "new") {
          if (shouldAskTranslation(translations, data.demo, translationPicked)) {
            showTranslationChoice(hasContinue);
            return;
          }
          if (!hasContinue || confirm("Start a new game from the beginning? The autosave resets; existing slots, quick save, and imported saves are kept.")) {
            beginNewGame();
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
    // Optional data side files: absent in older packs and the demo.
    const captions = data.captions ?? null;
    renderReader(readerEl, {
      router, save,
      demo: data.demo,
      settings: {
        textSpeed: settings.textSpeed,
        autoDelay: settings.autoDelay,
        voiceVol: settings.voiceVol,
        seVol: settings.seVol,
        bgmVol: settings.bgmVol,
        eroVoice: settings.eroVoice,
        skipRead: settings.skipRead,
        dev: settings.dev,
      },
      skip: skipState,
      captions,
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
      scenarios: router.scripts,
      bnr: data.bnr,
      hideUnrevealed: settings.hideUnrevealed,
      profile,
      onJump: (script) => {
        endReplayAutosaveGuard(false);
        save = newSave("debug", { script, event: 0 });
        save.visited.push(script);
        save.position = router.seek(save.position, save.flags, save.picks);
        save.position = skipLatches(router, save.position, save.flags, recordRunEnding);
        writeAutosave(localStorage, save);
        resetPaintState();
        resetAudioCursors();
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
  if (screen === "extras") {
    app.innerHTML = `<div class="screen">
      ${screenHead(
        "Extras",
        "CG gallery, music, and scene replay. Unlocks come from your profile: an imported system save plus what you have seen in play.",
      )}
      <div id="extras-body"></div>
      <button class="back" data-back>← Back</button>
    </div>`;
    renderExtras(app.querySelector("#extras-body") as HTMLElement, {
      profile,
      cgRows: data.sysSlots.cgRows,
      sceneSlots: data.sysSlots.sceneSlots,
      settings: { dev: settings.dev, bgmVol: settings.bgmVol },
      onReplay: (scene) => {
        if (!router.scripts.has(scene.script)) {
          notify("That replay scene is not in this build.");
          return;
        }
        // Replay is a detached preview: keep the real autosave bytes and
        // restore them when the replay ends (the reader still autosaves its
        // own BGM/advance state in the meantime).
        beginReplayAutosaveGuard();
        save = newSave(`replay-${scene.cg}`, { script: scene.script, event: 0 });
        save.position = router.seek(save.position, save.flags, save.picks);
        save.position = skipLatches(router, save.position, save.flags, recordRunEnding);
        resetPaintState();
        resetAudioCursors();
        backTo = "extras";
        go("read");
      },
    });
    app.querySelector("[data-back]")?.addEventListener("click", () => go(backTo));
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
    const specs = data.scenarios.map((s) => s.script).filter(isExtraScenario).sort();
    for (const id of specs) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.textContent = `Extra scenario ${id}`;
      b.onclick = () => {
        endReplayAutosaveGuard(false);
        save = newSave(`special-${id}`, { script: id, event: 0 });
        save.visited.push(id);
        save.position = router.seek(save.position, save.flags, save.picks);
        save.position = skipLatches(router, save.position, save.flags, recordRunEnding);
        writeAutosave(localStorage, save);
        resetPaintState();
        resetAudioCursors();
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
      bnr: data.bnr,
      profile,
      nativePos: data.nativePos,
      loadNativePos: async () => {
        const np = await loadNativePos(packBase);
        if (np) data.nativePos = np;
        return np;
      },
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
      <ol class="log" id="log">${save.log.map((l, i) => {
        const canPlay = !!(l.at && logVoiceUrl(l.at));
        const btn = canPlay
          ? `<button type="button" class="log-voice" data-log-voice="${i}" aria-label="Play voice clip" aria-pressed="false">▶</button>`
          : "";
        return `<li${canPlay ? ` class="has-voice"` : ""}>${btn}${l.speaker ? `<b>${escapeHtml(l.speaker)}</b> ` : ""}${escapeHtml(l.text)}</li>`;
      }).join("")}
      </ol>
      <button class="back" id="back">← Back</button>
    </div>`;
    // The backlog exists to re-read the last line: open at the newest
    // entry, not at the top of a 500-line scroll.
    const logEl = app.querySelector("#log") as HTMLElement | null;
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
    app.querySelector("#back")?.addEventListener("click", () => go(backTo));
    // Esc / Backspace / Right-click / wheel-down at bottom / a tap outside
    // the list returns to the story too.
    app.querySelector(".screen")?.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      go(backTo);
    });
    logEl?.addEventListener("wheel", (e) => {
      if (!logEl) return;
      const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 2;
      if (!atBottom) return;
      const dy = normalizeWheelDelta(e.deltaY, e.deltaMode);
      const now = performance.now();
      if (dy > 0 && wheelDirectionGesture(logWheelState, dy, now) === "down") {
        e.preventDefault();
        armWheelCooldown(now);
        go(backTo);
      }
    }, { passive: false });
    logEl?.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("[data-log-voice]") as HTMLButtonElement | null;
      if (btn) {
        e.stopPropagation();
        const entry = save.log[Number(btn.dataset.logVoice)];
        const url = entry?.at ? logVoiceUrl(entry.at) : null;
        if (!url) return;
        if (previewPlayingUrl() === url) {
          stopPreviewAudio();
        } else {
          pauseLineVoice();
          playPreviewAudio(url, settings.voiceVol, { onStop: syncLogVoiceButtons });
        }
        syncLogVoiceButtons();
        return;
      }
      if (e.target === logEl) go(backTo);
    });
    return;
  }
  if (screen === "settings") {
    app.innerHTML = `<div class="screen">
      ${screenHead("Settings", "Translation, reading pace, audio levels, and what the flowchart may reveal.")}
      <div class="settings">
        ${translations.length > 1 ? `
        <section class="settings-group">
          <h3>Translation</h3>
          <label class="setting">
            <span class="setting-label">Script translation<small>The English text in the reader, flowchart and guide. Saves stay compatible; switching reloads the page.</small></span>
            <select id="txsel">
              ${translations.map((t) => `<option value="${escapeAttr(t.id)}" ${t.id === activeTranslation ? "selected" : ""}>${escapeHtml((t.name ?? t.id) + (t.label ? " — " + t.label : ""))}</option>`).join("")}
            </select>
          </label>
          ${(() => { const cur = translations.find((t) => t.id === activeTranslation); return cur?.repo ? `<p class="setting-note">${escapeHtml(cur.desc ?? "")} <a href="${escapeAttr(cur.repo)}" target="_blank" rel="noopener noreferrer">Source repository</a></p>` : cur?.desc ? `<p class="setting-note">${escapeHtml(cur.desc)}</p>` : ""; })()}
        </section>` : ""}
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
            <span class="setting-label">Skip only read text<small>When on, Ctrl / Shift skip stops at the first unread line.</small></span>
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
            <span class="setting-label">Sound-effect volume<small>SFX and ambient cues. The original game's default is 77% (se_vol 195/255).</small></span>
            <span class="range-row"><input type="range" id="sv" min="0" max="100" value="${Math.round(settings.seVol * 100)}"> <span class="range-out" id="sv-val">${Math.round(settings.seVol * 100)}%</span></span>
          </label>
          <label class="setting">
            <span class="setting-label">Music volume<small>Background music only; sound effects keep their own mix.</small></span>
            <span class="range-row"><input type="range" id="bv" min="0" max="100" value="${Math.round(settings.bgmVol * 100)}"> <span class="range-out" id="bv-val">${Math.round(settings.bgmVol * 100)}%</span></span>
          </label>
          <label class="setting">
            <span class="setting-label">Female voices only in H scenes<small>Original H-scene voice setting: on = 女性ボイスのみ再生 (heroine slots 1–5 only; Haruki and side characters muted), off = 通常再生 (all voices).</small></span>
            <input type="checkbox" id="ev" ${settings.eroVoice ? "" : "checked"}>
          </label>
        </section>

        <section class="settings-group">
          <h3>Flowchart and guide</h3>
          <label class="setting">
            <span class="setting-label">Show spoilers<small>Reveal options and endings you have not reached yet.</small></span>
            <input type="checkbox" id="sp" ${settings.spoiler ? "checked" : ""}>
          </label>
          <label class="setting">
            <span class="setting-label">Hide unreached scene frames<small>Flowchart cards for scenes you have not reached stay black instead of showing a blurred still. Turn this off to see frosted previews.</small></span>
            <input type="checkbox" id="hu" ${settings.hideUnrevealed ? "checked" : ""}>
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

        <section class="settings-group">
          <h3>Controls</h3>
          <dl class="controls-list">
            <div class="control-row">
              <dt>Advance / Complete line</dt>
              <dd><kbd>Click</kbd> <kbd>Enter</kbd> <kbd>Space</kbd> <kbd>PgDn</kbd> <kbd>Scroll ↓</kbd></dd>
            </div>
            <div class="control-row">
              <dt>Hide / Show text</dt>
              <dd><kbd>H</kbd> <kbd>Esc</kbd> <kbd>Backspace</kbd> <kbd>Right-click</kbd> <kbd>Middle-click</kbd></dd>
            </div>
            <div class="control-row">
              <dt>Skip (hold / toggle)</dt>
              <dd><kbd>Ctrl</kbd> hold · <kbd>Shift</kbd> toggle</dd>
            </div>
            <div class="control-row">
              <dt>Backlog</dt>
              <dd><kbd>Scroll ↑</kbd> <kbd>PgUp</kbd> · close with <kbd>Esc</kbd> <kbd>Backspace</kbd> <kbd>Right-click</kbd> or <kbd>Scroll ↓</kbd> at end</dd>
            </div>
            <div class="control-row">
              <dt>Choices</dt>
              <dd><kbd>1</kbd>–<kbd>9</kbd> pick directly · <kbd>↑</kbd> <kbd>↓</kbd> + <kbd>Enter</kbd></dd>
            </div>
            <div class="control-row">
              <dt>Movie</dt>
              <dd><kbd>Esc</kbd> reveal HUD / skip · <kbd>M</kbd> mute · <kbd>C</kbd> subtitles</dd>
            </div>
            <div class="control-row">
              <dt>Fullscreen</dt>
              <dd><kbd>Alt</kbd> + <kbd>Enter</kbd> (or <kbd>F11</kbd>)</dd>
            </div>
            <div class="control-row">
              <dt>Menus / Overlays</dt>
              <dd><kbd>Esc</kbd> <kbd>Backspace</kbd> back (also <kbd>Right-click</kbd> in backlog)</dd>
            </div>
          </dl>
        </section>
      </div>
      <button class="back" id="back">← Back</button>
    </div>`;
    const txsel = app.querySelector("#txsel") as HTMLSelectElement | null;
    if (txsel) {
      txsel.onchange = () => {
        markTranslationPicked();
        settings.translation = txsel.value;
        persistSettings();
        // The alternate script set is fetched at boot; a reload applies it.
        location.reload();
      };
    }
    const sp = app.querySelector("#sp") as HTMLInputElement;
    sp.onchange = () => {
      settings.spoiler = sp.checked;
      localStorage.setItem("wa2web.spoiler", sp.checked ? "1" : "0");
    };
    const hu = app.querySelector("#hu") as HTMLInputElement;
    hu.onchange = () => {
      settings.hideUnrevealed = hu.checked;
      persistSettings();
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
    const sv = app.querySelector("#sv") as HTMLInputElement;
    sv.oninput = () => {
      settings.seVol = Number(sv.value) / 100;
      applySeVolume(settings.seVol);
      const out = app.querySelector("#sv-val");
      if (out) out.textContent = `${Math.round(settings.seVol * 100)}%`;
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
    const ev = app.querySelector("#ev") as HTMLInputElement;
    ev.onchange = () => {
      // Checkbox is the original "female voices only" choice; the stored
      // flag is eroVoice=true for normal playback.
      settings.eroVoice = !ev.checked;
      persistSettings();
    };
    app.querySelector("#back")?.addEventListener("click", () => go(backTo));
    return;
  }
}

function logVoiceUrl(at: { script: string; event: number }): string | null {
  // Mirror the reader's voice lookup exactly: an explicit table entry wins
  // (string = exact manifest key, number = legacy BNR line id); a table hit
  // with no event entry means unvoiced; a script with no table at all falls
  // back to the event's comma token, which is how 32/221 scripts still play
  // voices in the reader.
  const table = data.voicemap?.map[at.script];
  if (table) {
    const mapped = table[String(at.event)];
    if (mapped === undefined) return null;
    if (typeof mapped === "string") return voiceUrlByKey(mapped);
    if (typeof mapped === "number") {
      return voiceUrl(at.script, mapped, chapterOfScript(at.script));
    }
    return null;
  }
  const ev = router.at({ script: at.script, event: at.event });
  if (!ev || (ev.t !== "say" && ev.t !== "narrate")) return null;
  return voiceUrl(at.script, ev.tok, chapterOfScript(at.script));
}

/** Stop the reader's line voice without leaving a stale `dataset.cur` that
 * would make the next render think it is still playing; the backlog preview
 * must not overlap it. */
function pauseLineVoice(): void {
  const audio = document.getElementById("voice") as HTMLAudioElement | null;
  if (!audio) return;
  audio.pause();
  delete audio.dataset.cur;
}

function syncLogVoiceButtons(): void {
  const current = previewPlayingUrl();
  app.querySelectorAll<HTMLButtonElement>("[data-log-voice]").forEach((btn) => {
    const entry = save.log[Number(btn.dataset.logVoice)];
    const url = entry?.at ? logVoiceUrl(entry.at) : null;
    const on = !!url && current === url;
    btn.textContent = on ? "■" : "▶";
    btn.setAttribute("aria-pressed", String(on));
    btn.setAttribute("aria-label", on ? "Stop voice clip" : "Play voice clip");
  });
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
