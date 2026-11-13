// Immersive full-stage movie player (engine `movie` events, mvNN cues).
//
// One persistent layer lives inside `.reader`: a bare <video> (no native
// chrome — the browser's controls break the frame), two subtitle regions
// parsed from a BYOA WebVTT track, and a HUD strip that only appears when
// the viewer moves or taps. Everything is idempotent: `finish()` may run
// from `onended`, `onerror`, the Skip button, Escape, or a screen exit, and
// only the first call advances the story.
//
// Autoplay: the engine starts the film at the BGM volume. A cold tab
// without a user gesture rejects play() with NotAllowedError; that is not
// an error state, so retry muted and offer "Tap to unmute" instead of
// stalling on a black frame.

import { activeCuesAt, parseVtt, regionBlocksHtml, regionSignature, type VttCue } from "../engine/vtt";

export interface MovieHooks {
  /** Story advance past the movie event (caller guards the position). */
  onFinish(): void;
  /** Layer took the stage: caller silences BGM/voice/ambience. */
  onOpen?(): void;
  /** Layer left the stage (before onFinish): caller restores audio.
   * `advancing` = the story continues past the movie, so the caller must
   * NOT resume the old BGM (the next render paints the correct cue). */
  onClose?(advancing: boolean): void;
}

export interface MovieOptions {
  /** Engine cue id (mv01) — used for lookahead bookkeeping/tests. */
  id: string;
  /** Resolved video URL, or null when the pack ships no movie file. */
  url: string | null;
  /** Resolved WebVTT URL, when the pack ships subtitles. */
  subtitleUrl: string | null;
  /** Start volume (the BGM slider: the film carries its own score). */
  volume: number;
  hooks: MovieHooks;
}

interface MovieState {
  reader: HTMLElement;
  layer: HTMLElement;
  video: HTMLVideoElement;
  subsTop: HTMLElement;
  subsBottom: HTMLElement;
  hud: HTMLElement;
  hint: HTMLElement;
  muteBtn: HTMLButtonElement;
  ccBtn: HTMLButtonElement;
  bar: HTMLElement;
  pill: HTMLButtonElement;
  missing: HTMLElement;
  hooks: MovieHooks;
  id: string;
  cues: VttCue[];
  ccOn: boolean;
  done: boolean;
  hudTimer: number | null;
  raf: number | null;
  /** Last painted subtitle signature (skip redundant DOM writes). */
  sig: string;
  /** Capture-phase Escape handler (removed on teardown). */
  onKey: ((e: KeyboardEvent) => void) | null;
}

const HUD_FADE_MS = 2500;
/** Subtitles never sit closer than this to the HUD strip (px). */
const HUD_GAP_PX = 12;
const CC_KEY = "wa2web.cc";

let cur: MovieState | null = null;
const cueCache = new Map<string, VttCue[]>();
const cuePending = new Map<string, Promise<VttCue[]>>();

/** Subtitle preference: remembered across films and reloads. Default on. */
function readCcPref(): boolean {
  try {
    const raw = localStorage.getItem(CC_KEY);
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

function writeCcPref(on: boolean): void {
  try {
    localStorage.setItem(CC_KEY, on ? "1" : "0");
  } catch {
    /* storage disabled: the preference lasts for the session */
  }
}

const TEMPLATE = `
  <video id="movie" class="movie-video" playsinline preload="auto"></video>
  <div class="movie-subs movie-subs-top" role="status" aria-live="polite" aria-atomic="false"></div>
  <div class="movie-subs movie-subs-bottom" role="status" aria-live="polite" aria-atomic="false"></div>
  <div class="movie-missing" hidden>
    <p class="movie-missing-title">Movie asset not installed</p>
    <p class="movie-missing-note">Install the movie files in your pack to watch this scene.</p>
    <button class="movie-continue" data-m="continue">Continue</button>
  </div>
  <button class="movie-unmute" data-m="unmute" hidden>Tap to unmute</button>
  <div class="movie-hud">
    <div class="movie-bar"><i></i></div>
    <div class="movie-ctl">
      <button data-m="mute" aria-pressed="false">Mute</button>
      <button data-m="cc" aria-pressed="true" aria-label="Subtitles">CC</button>
      <button data-m="skip" class="movie-skip">Skip</button>
    </div>
    <p class="movie-hint">Esc reveals then skips · M mutes · C toggles subtitles</p>
  </div>`;

function q<T extends HTMLElement>(layer: HTMLElement, sel: string): T {
  return layer.querySelector(sel) as T;
}

function ensureLayer(reader: HTMLElement): {
  layer: HTMLElement;
  video: HTMLVideoElement;
  subsTop: HTMLElement;
  subsBottom: HTMLElement;
  hud: HTMLElement;
  hint: HTMLElement;
  muteBtn: HTMLButtonElement;
  ccBtn: HTMLButtonElement;
  bar: HTMLElement;
  pill: HTMLButtonElement;
  missing: HTMLElement;
} {
  let layer = reader.querySelector(":scope > .movie-layer") as HTMLElement | null;
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "movie-layer";
    layer.hidden = true;
    layer.innerHTML = TEMPLATE;
    reader.appendChild(layer);
  }
  return {
    layer,
    video: q<HTMLVideoElement>(layer, "video.movie-video"),
    subsTop: q(layer, ".movie-subs-top"),
    subsBottom: q(layer, ".movie-subs-bottom"),
    hud: q(layer, ".movie-hud"),
    hint: q(layer, ".movie-hint"),
    muteBtn: q(layer, '[data-m="mute"]'),
    ccBtn: q(layer, '[data-m="cc"]'),
    bar: q(layer, ".movie-bar > i"),
    pill: q(layer, '[data-m="unmute"]'),
    missing: q(layer, ".movie-missing"),
  };
}

/** The HUD hint line: what the keyboard actually does right now. */
const PLAY_HINT = "Esc reveals then skips · M mutes · C toggles subtitles";
const MISSING_HINT = "Press Space or Enter to continue";

export function moviePlaying(): boolean {
  return cur !== null && !cur.done;
}

function hideHud(s: MovieState): void {
  if (s.hudTimer !== null) {
    clearTimeout(s.hudTimer);
    s.hudTimer = null;
  }
  delete s.layer.dataset.hud;
  s.reader.classList.add("movie-idle");
}

/** Keep bottom subtitles clear of the actual HUD strip: its height differs
 * between the desktop bar, coarse-pointer controls and narrow portrait
 * frames, so measure it instead of hard-coding one offset. */
function syncSubsClearance(s: MovieState): void {
  const h = s.hud.offsetHeight;
  // HUD is bottom-anchored at 0.9rem; add its height plus a small gap.
  s.subsBottom.style.bottom = h > 0
    ? `calc(var(--safe-b) + 0.9rem + ${Math.round(h) + HUD_GAP_PX}px)`
    : "";
}

function showHud(s: MovieState): void {
  if (s.done) return;
  // Measure only when the strip actually (re)appears: `offsetHeight` forces
  // a layout, and showHud runs on every pointermove.
  const revealing = !s.layer.dataset.hud;
  s.layer.dataset.hud = "1";
  s.reader.classList.remove("movie-idle");
  if (revealing) syncSubsClearance(s);
  if (s.hudTimer !== null) clearTimeout(s.hudTimer);
  s.hudTimer = window.setTimeout(() => {
    s.hudTimer = null;
    if (!s.done) hideHud(s);
  }, HUD_FADE_MS);
}

function syncMuteUi(s: MovieState): void {
  const v = s.video;
  const silent = v.muted || v.volume === 0;
  s.muteBtn.textContent = silent ? "Unmute" : "Mute";
  s.muteBtn.setAttribute("aria-pressed", String(silent));
  s.pill.hidden = !(silent && !s.done && s.missing.hidden);
}

/** Subtitle toggle as one operation: button state, subs and the stored
 * preference always agree (the old handler forgot the preference, so every
 * film started with captions again even after the viewer turned them off). */
function setCc(s: MovieState, on: boolean): void {
  s.ccOn = on;
  s.ccBtn.setAttribute("aria-pressed", String(on));
  s.ccBtn.classList.toggle("active", on);
  writeCcPref(on);
  s.sig = "";
  paintSubs(s);
}

function paintSubs(s: MovieState): void {
  const v = s.video;
  const active = s.ccOn && s.cues.length > 0 ? activeCuesAt(s.cues, v.currentTime) : [];
  const sig = `${regionSignature(active, "top")}\u0000${regionSignature(active, "bottom")}`;
  if (sig === s.sig) return;
  s.sig = sig;
  // `regionBlocksHtml` only ever returns parser-sanitised markup: escape-
  // first, then re-emitted <i>/<b>/<br> from the allow-list. Each column
  // becomes its own `.movie-cue` block, so a left/right lyric pair renders
  // side by side (`.movie-sub-cols`) instead of stacking into one column.
  s.subsTop.innerHTML = regionBlocksHtml(active, "top");
  s.subsBottom.innerHTML = regionBlocksHtml(active, "bottom");
}

function paintProgress(s: MovieState): void {
  const v = s.video;
  const pct = Number.isFinite(v.duration) && v.duration > 0
    ? Math.max(0, Math.min(100, (v.currentTime / v.duration) * 100))
    : 0;
  s.bar.style.width = `${pct}%`;
}

function tick(s: MovieState): void {
  if (s.done) return;
  paintSubs(s);
  paintProgress(s);
  if (!s.video.paused && !s.video.ended) s.raf = requestAnimationFrame(() => tick(s));
  else s.raf = null;
}

function startTicking(s: MovieState): void {
  if (s.raf !== null) return;
  s.raf = requestAnimationFrame(() => tick(s));
}

async function loadCues(url: string): Promise<VttCue[]> {
  const cached = cueCache.get(url);
  if (cached) return cached;
  const pending = cuePending.get(url);
  if (pending) return pending;
  const p = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) return [];
      const cues = parseVtt(await res.text());
      cueCache.set(url, cues);
      return cues;
    } catch {
      return [];
    } finally {
      cuePending.delete(url);
    }
  })();
  cuePending.set(url, p);
  return p;
}

/** Idempotent teardown. `advance` runs the story hook at most once. */
function finish(s: MovieState, advance: boolean): void {
  if (s.done) return;
  s.done = true;
  if (cur === s) cur = null;
  if (s.hudTimer !== null) {
    clearTimeout(s.hudTimer);
    s.hudTimer = null;
  }
  if (s.raf !== null) {
    cancelAnimationFrame(s.raf);
    s.raf = null;
  }
  const v = s.video;
  if (s.onKey) {
    window.removeEventListener("keydown", s.onKey, true);
    s.onKey = null;
  }
  v.onended = null;
  v.onerror = null;
  try {
    v.pause();
  } catch {
    /* detached element: nothing to pause */
  }
  // Unload: a 5-minute film must not keep its buffer alive behind the text.
  v.removeAttribute("src");
  try {
    v.load();
  } catch {
    /* some engines throw on load() of a src-less element */
  }
  s.layer.hidden = true;
  delete s.layer.dataset.hud;
  s.reader.classList.remove("movie-mode", "movie-idle");
  s.subsTop.innerHTML = "";
  s.subsBottom.innerHTML = "";
  s.sig = "";
  s.pill.hidden = true;
  s.hooks.onClose?.(advance);
  if (advance) s.hooks.onFinish();
}

/** Close any movie without advancing (screen exit, title, save load). */
export function stopMovie(): boolean {
  const s = cur;
  // Leaving the film (or the screen) also drops the lookahead buffer: a warm
  // <video> behind a menu is pure memory.
  releaseMovieWarm();
  if (!s) return false;
  finish(s, false);
  return true;
}

/** Pause in place (keeps the frame and the position). */
function pauseMovie(): boolean {
  const s = cur;
  if (!s || s.done) return false;
  try {
    s.video.pause();
  } catch {
    return false;
  }
  if (s.raf !== null) {
    cancelAnimationFrame(s.raf);
    s.raf = null;
  }
  return true;
}

function attemptPlay(s: MovieState): void {
  const v = s.video;
  const p = v.play();
  if (!p || typeof p.catch !== "function") {
    startTicking(s);
    return;
  }
  p.then(() => startTicking(s)).catch((err: unknown) => {
    const name = (err as { name?: string })?.name ?? "";
    if (name !== "NotAllowedError" || s.done) return;
    // Autoplay is blocked: run muted and hand control back to the viewer.
    v.muted = true;
    syncMuteUi(s);
    v.play().then(() => startTicking(s)).catch(() => {
      // Still blocked (e.g. no gesture at all): the HUD's unmute pill and
      // Skip stay available, so the frame is never a dead end.
    });
  });
}

// ---- Global (document/window) listeners --------------------------------
// Registered once for the whole module lifetime. The old version bound them
// inside `wireLayer`, which only runs once per layer element — but a layer is
// thrown away whenever `#reader` is rebuilt (menu visit), so every rebuild
// leaked a detached document/window listener that kept firing for a dead
// state object.
let globalsWired = false;

/** The live state a global handler must act on (null when no film plays). */
function liveMovie(): MovieState | null {
  return cur && !cur.done ? cur : null;
}

function wireGlobals(): void {
  if (globalsWired || typeof document === "undefined") return;
  globalsWired = true;
  // Backgrounding the tab must not leave a film playing to an empty room.
  // The handler resolves `cur` at call time, so it follows every film the
  // session opens and never holds a dead state object.
  document.addEventListener("visibilitychange", () => {
    const s = liveMovie();
    if (!s) return;
    if (document.hidden) {
      pauseMovie();
    } else if (s.video.paused && !s.video.ended) {
      s.video.play().catch(() => undefined);
    }
  });
  // Rotating a phone / resizing the window changes the HUD's height (and
  // the hint line's presence), so the subtitle clearance must be re-measured.
  window.addEventListener("resize", () => {
    const s = liveMovie();
    if (s) syncSubsClearance(s);
  });
}

/** Wire the persistent layer exactly once. Handlers dispatch through
 * `cur`, so switching movies never stacks duplicate listeners (the old
 * per-open wiring re-bound every control on each film). */
function wireLayer(layer: HTMLElement, video: HTMLVideoElement): void {
  if (layer.dataset.wired === "1") return;
  layer.dataset.wired = "1";

  const live = liveMovie;

  const unmute = (s: MovieState) => {
    video.muted = false;
    if (video.volume === 0) video.volume = 0.7;
    syncMuteUi(s);
    video.play().catch(() => undefined);
  };

  layer.addEventListener("pointermove", () => {
    const s = live();
    if (s) showHud(s);
  }, { passive: true });
  layer.addEventListener("pointerdown", () => {
    const s = live();
    if (s) showHud(s);
  }, { passive: true });
  // The reader's own click advances the story; a tap here must only reveal
  // the HUD (mobile viewers need a first tap that never skips the film).
  layer.addEventListener("click", (e) => {
    e.stopPropagation();
    const s = live();
    if (!s) return;
    const target = e.target as HTMLElement | null;
    const act = target?.closest("[data-m]")?.getAttribute("data-m") ?? null;
    if (act === "skip" || act === "continue") {
      finish(s, true);
      return;
    }
    if (act === "mute") {
      if (video.muted) unmute(s);
      else {
        video.muted = true;
        syncMuteUi(s);
      }
      showHud(s);
      return;
    }
    if (act === "cc") {
      setCc(s, !s.ccOn);
      showHud(s);
      return;
    }
    if (act === "unmute") {
      unmute(s);
      showHud(s);
      return;
    }
    showHud(s);
  });

  video.addEventListener("timeupdate", () => {
    const s = live();
    if (!s) return;
    paintSubs(s);
    paintProgress(s);
  });
  video.addEventListener("loadedmetadata", () => {
    const s = live();
    if (!s) return;
    paintProgress(s);
    paintSubs(s);
  });
  video.addEventListener("playing", () => {
    const s = live();
    if (s) startTicking(s);
  });
  video.addEventListener("volumechange", () => {
    const s = live();
    if (s) syncMuteUi(s);
  });
}

/** Per-open handlers: Escape capture key and the media end state. */
function wireState(s: MovieState): void {
  const onKey = (e: KeyboardEvent) => {
    if (s.done) return;
    if (e.repeat) return;
    // Missing-movie card: Space/Enter must advance even when focus drifted
    // off the Continue button (the card is the only exit).
    if (!s.missing.hidden && (e.key === "Enter" || e.key === " " || e.code === "Space")) {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, select, textarea")) return;
      e.preventDefault();
      e.stopPropagation();
      finish(s, true);
      return;
    }
    // Shortcuts advertised on the HUD hint line. They are capture-phase so
    // the reader's own H/Space handlers cannot fire behind the film. The
    // missing-movie card has no audio or captions, so only Space/Enter (and
    // Escape below) mean anything there.
    if (s.missing.hidden && (e.key === "m" || e.key === "M")) {
      e.preventDefault();
      e.stopPropagation();
      if (s.video.muted) {
        s.video.muted = false;
        if (s.video.volume === 0) s.video.volume = 0.7;
        syncMuteUi(s);
        s.video.play().catch(() => undefined);
      } else {
        s.video.muted = true;
        syncMuteUi(s);
      }
      showHud(s);
      return;
    }
    if (s.missing.hidden && (e.key === "c" || e.key === "C")) {
      if (s.ccBtn.hidden) return;
      e.preventDefault();
      e.stopPropagation();
      setCc(s, !s.ccOn);
      showHud(s);
      return;
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    // Esc first reveals an idle HUD (with the hint line), then skips on the
    // second press: a single stray key must not cut a film the viewer is
    // watching.
    if (!s.layer.dataset.hud) {
      showHud(s);
      return;
    }
    finish(s, true);
  };
  window.addEventListener("keydown", onKey, true);
  s.onKey = onKey;
  s.video.onended = () => finish(s, true);
  s.video.onerror = () => finish(s, true);
}

/**
 * Put a movie on the stage. Safe to call on every reader render: the same
 * cue reuses the running layer (a re-render must never restart the film).
 */
export function openMovie(reader: HTMLElement, opts: MovieOptions): void {
  const existing = cur;
  if (existing && !existing.done && existing.reader === reader && existing.id === opts.id) {
    existing.hooks = opts.hooks;
    return;
  }
  if (existing && !existing.done) finish(existing, false);

  const parts = ensureLayer(reader);
  const s: MovieState = {
    reader,
    ...parts,
    hooks: opts.hooks,
    id: opts.id,
    cues: [],
    ccOn: readCcPref(),
    done: false,
    hudTimer: null,
    raf: null,
    sig: "",
    onKey: null,
  };
  cur = s;
  reader.classList.add("movie-mode");
  reader.classList.remove("movie-idle");
  s.layer.hidden = false;
  // The film we are about to play: the lookahead buffer is dead weight now.
  releaseMovieWarm();
  s.sig = "";
  s.subsTop.innerHTML = "";
  s.subsBottom.innerHTML = "";
  s.pill.hidden = true;
  s.hooks.onOpen?.();
  wireGlobals();
  wireLayer(parts.layer, parts.video);
  wireState(s);

  const video = s.video;
  video.removeAttribute("src");
  video.muted = false;
  video.volume = Math.max(0, Math.min(1, opts.volume));

  if (!opts.url) {
    // BYOA without movie files: a dark stage and one quiet card, never a
    // broken <video> element.
    video.hidden = true;
    s.missing.hidden = false;
    s.bar.style.width = "0%";
    s.ccBtn.hidden = true;
    s.muteBtn.hidden = true;
    s.hint.textContent = MISSING_HINT;
    s.layer.dataset.hud = "1";
    if (s.hudTimer !== null) {
      clearTimeout(s.hudTimer);
      s.hudTimer = null;
    }
    // The card is the only way forward: put focus on it so Enter/Space
    // works, and let the reader's advance click bubble to nothing.
    const cont = s.layer.querySelector('[data-m="continue"]') as HTMLButtonElement | null;
    cont?.focus({ preventScroll: true });
    return;
  }

  video.hidden = false;
  s.missing.hidden = true;
  s.muteBtn.hidden = false;
  s.hint.textContent = PLAY_HINT;
  const hasSubs = !!opts.subtitleUrl;
  s.ccBtn.hidden = !hasSubs;
  // Button state must mirror the stored preference from the first frame.
  s.ccBtn.setAttribute("aria-pressed", String(s.ccOn));
  s.ccBtn.classList.toggle("active", s.ccOn);
  if (hasSubs && opts.subtitleUrl) {
    const url = opts.subtitleUrl;
    void loadCues(url).then((cues) => {
      if (s.done || cur !== s) return;
      s.cues = cues;
      if (cues.length === 0) {
        s.ccBtn.hidden = true;
        return;
      }
      s.sig = "";
      paintSubs(s);
    });
  }
  syncMuteUi(s);
  video.src = opts.url;
  attemptPlay(s);
  showHud(s);
}

// ---- Lookahead preload --------------------------------------------------

const warmed = new Set<string>();
let warmEl: HTMLVideoElement | null = null;

/**
 * Warm the next movie's metadata while the current line plays, so the film
 * starts on the first frame instead of buffering over a black stage.
 * `preload="metadata"` only: never a full download, and never a source on
 * the live layer (that element is reloaded per movie).
 *
 * The element is mounted once (hidden, `.movie-warm`) rather than left
 * detached: a detached <video> keeps decoding and buffering with no owner,
 * and nothing ever unloaded it. `releaseMovieWarm()` drops the source and
 * the buffer when a film begins or the layer tears down.
 */
export function preloadMovieAhead(url: string | null | undefined): void {
  if (!url || warmed.has(url) || typeof document === "undefined") return;
  warmed.add(url);
  if (!warmEl) {
    warmEl = document.createElement("video");
    warmEl.preload = "metadata";
    warmEl.muted = true;
    warmEl.playsInline = true;
    warmEl.className = "movie-warm";
    warmEl.setAttribute("aria-hidden", "true");
    warmEl.tabIndex = -1;
    document.body.appendChild(warmEl);
  }
  warmEl.src = url;
  try {
    warmEl.load();
  } catch {
    /* best effort */
  }
  while (warmed.size > 8) {
    const first = warmed.values().next().value;
    if (first === undefined) break;
    warmed.delete(first);
  }
}

/** Drop the warm buffer (a film now owns the screen, or the reader left).
 * Without this the element holds the last 100–200 MB of prefetched media
 * for the rest of the session. */
function releaseMovieWarm(): void {
  warmed.clear();
  const el = warmEl;
  if (!el) return;
  try {
    el.pause();
  } catch {
    /* detached: nothing to pause */
  }
  el.removeAttribute("src");
  try {
    el.load();
  } catch {
    /* some engines throw on load() of a src-less element */
  }
}
