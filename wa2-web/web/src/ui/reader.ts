// Reader screen: dialogue/narration/choices/stage + backlog + quick menu.

import { bgmIntroUrl, bgmLoopUrl, bgmSoloUrl, imageUrl, movieUrl, resolveAudioUrl, seUrl, subtitleUrl, voiceUrl, voiceUrlByKey } from "../engine/assets";
import { Router, chapterOfScript } from "../engine/router";
import { displayDate, plainText, renderText, spanize } from "../engine/text";
import type { BgmData, BnrData, Position, SaveData, ScenarioEvent } from "../engine/types";
import { storageKey, writeAutosave } from "../engine/save";
import { newWheelState, normalizeWheelDelta, wheelGesture, type WheelState } from "../engine/wheel";
import { moviePlaying, openMovie, preloadMovieAhead } from "./movie";

export interface ReaderSettings {
  textSpeed: number; // chars per second, 0 = instant
  autoDelay: number; // ms after line completes, 0 = off
  voiceVol: number; // 0..1
  bgmVol: number; // 0..1
  /** Skip mode: "all" skips everything, "read" stops at unread lines. */
  skipRead: boolean;
  /** Developer mode: mechanical labels, tooltips, scene ids. */
  dev?: boolean;
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

/** True while the reader is the live screen. main.ts flips this on every
 * screen change so Auto/skip can never advance behind a menu. */
let readerLive = false;
export function setReaderLive(live: boolean): void {
  readerLive = live;
}

/** Pause Auto and release skip: called when an overlay (backlog, saves,
 * chart, guide, settings) or the title takes the screen. A re-render on
 * return must not resume a half-finished auto-advance. */
export function pauseReader(): void {
  clearAuto();
  if (curHooks && curHooks.skip.active) {
    curHooks.skip.active = false;
    curHooks.onSkipStop();
  }
}

/** Reset skip state and stop a running typewriter without losing the line
 * (the text is completed in place by the next render's identity check). */
export function resetSkip(): void {
  if (curHooks) curHooks.skip.active = false;
  clearAuto();
}

/** Last (script, event) pair fully painted in the box, plus the HTML used.
 * Re-renders triggered by overlays/settings reuse it so a completed line is
 * never re-typed from character 0 (the "back from backlog retypes" bug). */
let lastPainted: { key: string; full: string; done: boolean } | null = null;

/** Forget the painted line (new game, save load, screen jump): the next
 * render must type the line even if the position string repeats. */
export function resetPaintState(): void {
  lastPainted = null;
  textHidden = false;
}

/** Hide-text ("immersion") state: the dialogue plate and chrome fade out so
 * only the art is visible; any tap/H reveals them again. */
let textHidden = false;
let idleTimer: number | null = null;

/** Trackpad-safe backlog gesture state (one per reader). */
let wheelState: WheelState = newWheelState();

/** The current click/keyboard advance action for the displayed event. */
let advanceHandler: (() => void) | null = null;

/** Frame-size observer (one per reader skeleton). */
let observer: ResizeObserver | null = null;

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
  /** Asset-free demo: draw the original snow scene behind the placeholder
   * script instead of an empty "no backdrop" stage. */
  demo?: boolean;
  settings: ReaderSettings;
  /** Shared mutable skip state: main.ts flips `active` on Ctrl down/up and
   * the reader reads it live — a snapshot boolean went stale between
   * renders and made Ctrl-skip a no-op (and forced re-renders that
   * restarted the typewriter mid-line = the "flicker"). */
  skip: { active: boolean };
  onChange(): void;
  open(screen: string): void;
  notify(msg: string): void;
  /** Explicit quick-save / quick-load actions (Q.Save / Q.Load). */
  quickSave?(): void;
  quickLoad?(): void;
  /** Called when read-mode skip halts on an unread line (main clears Ctrl). */
  onSkipStop(): void;
}

// ---- Read-text tracking (for "skip read text only") -----------------------
// Keys are "script:event" for every line that has ever been displayed.
const READ_KEY = "read";
function readStorageKey(): string {
  return storageKey(READ_KEY);
}
let readSet: Set<string> | null = null;
/** Namespace the cached set was loaded for: switching packs/demo must not
 * reuse another namespace's read lines (the key is namespace-derived). */
let readSetFor: string | null = null;
/** Whether the currently displayed line had been read before this render
 * (skip-read gate; see scheduleAuto). */
let currentWasRead = true;

function loadRead(): Set<string> {
  const key = readStorageKey();
  if (readSet && readSetFor === key) return readSet;
  try {
    readSet = new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
  } catch {
    readSet = new Set();
  }
  readSetFor = key;
  return readSet!;
}

// Read-set persistence is debounced: rewriting the whole ~46k-key array on
// every displayed line is O(n^2) late in a playthrough and shows up as a
// visible hitch on advance. The in-memory Set stays authoritative for
// skip-read; storage catches up shortly after (and on pagehide).
let readPersistTimer: number | null = null;
let readPersistDirty = false;

function persistRead(): boolean {
  if (!readPersistDirty || !readSet) return true;
  readPersistDirty = false;
  try {
    // Write to the namespace the set was loaded for: a namespace switch
    // must never copy one pack's read lines into another pack's key.
    localStorage.setItem(readSetFor ?? readStorageKey(), JSON.stringify([...readSet]));
    return true;
  } catch {
    /* quota/disabled storage: skip-read degrades to skip-all for this
     * session, but the caller must know the write failed so a profile
     * import is never reported as persisted when it was not. Stay dirty so
     * the next flush (or the pagehide writer) tries again once the caller
     * has freed space. */
    readPersistDirty = true;
    return false;
  }
}

function scheduleReadPersist(): void {
  readPersistDirty = true;
  if (readPersistTimer !== null) return;
  if (typeof window === "undefined") {
    persistRead();
    return;
  }
  readPersistTimer = window.setTimeout(() => {
    readPersistTimer = null;
    persistRead();
  }, 750);
}

function markRead(save: SaveData): void {
  const key = `${save.position.script}:${save.position.event}`;
  const set = loadRead();
  if (set.has(key)) return;
  set.add(key);
  scheduleReadPersist();
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", persistRead);
}

function isRead(save: SaveData): boolean {
  return loadRead().has(`${save.position.script}:${save.position.event}`);
}

/** Merge imported read keys (a `Sys.sav` profile) into the read set and
 * persist right away: the import must survive a page switch or reload
 * without waiting for the debounced writer.
 *
 * `added` = how many keys were new; `persisted` = whether the flush
 * actually reached `localStorage`. A full/disabled browser storage leaves
 * the in-memory set (and therefore skip-read for this session) working, but
 * the caller must not claim the import was saved. */
export function ingestReadKeys(keys: Iterable<string>): { added: number; persisted: boolean } {
  const set = loadRead();
  let added = 0;
  for (const key of keys) {
    if (typeof key !== "string" || set.has(key)) continue;
    set.add(key);
    added++;
  }
  let persisted = true;
  if (added > 0) {
    // Flush synchronously: a profile import can add tens of thousands of
    // keys, and losing them to a navigation would look like a failed import.
    readPersistDirty = true;
    persisted = persistRead();
    // Repaint the skip-read gate for any line already on screen.
    currentWasRead = true;
  }
  return { added, persisted };
}

/** Hide/show the dialogue plate + chrome ("immersion" mode). Returns the
 * new state. Clicking an already-hidden stage restores the text via the
 * same path — never as an advance. */
export function toggleText(reader: HTMLElement | null, force?: boolean): boolean {
  if (!reader) return false;
  textHidden = force === undefined ? !textHidden : force;
  reader.classList.toggle("text-hidden", textHidden);
  return textHidden;
}

export function setTextHidden(v: boolean): void {
  textHidden = v;
}

/** Idle cursor hiding: after 3 s without pointer/key activity the reader
 * hides the cursor and dims the HUD, leaving the frame alone. */
function trackIdle(el: HTMLElement): void {
  const bump = () => {
    const reader = el.querySelector(".reader") as HTMLElement | null;
    if (!reader) return;
    reader.classList.remove("stage-idle");
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      idleTimer = null;
      const r = el.querySelector(".reader") as HTMLElement | null;
      if (!r) return;
      // Never hide the cursor over a choice or an open overlay.
      if (r.querySelector(".choices .choice-btn")) return;
      if (r.classList.contains("movie-mode")) return;
      r.classList.add("stage-idle");
    }, 3000);
  };
  el.addEventListener("pointermove", bump, { passive: true });
  el.addEventListener("pointerdown", bump, { passive: true });
  el.addEventListener("keydown", bump);
}

// ---- HUD "More" dropdown ------------------------------------------------
// A popover has three ways out: pick an item, press Escape, or click
// anywhere outside it. All three run through the same close so the
// `aria-expanded` state can never drift from the visible menu.

function setMoreOpen(wrap: HTMLElement | null, toggle: HTMLElement | null, open: boolean): void {
  wrap?.classList.toggle("more-open", open);
  toggle?.setAttribute("aria-expanded", String(open));
}

function closeMoreMenu(dock: HTMLElement | null): void {
  if (!dock) return;
  const toggle = dock.querySelector(".hud-expand") as HTMLElement | null;
  // The class lives on the dock itself (`.hud-btns.more-open > .hud-more`).
  setMoreOpen(dock, toggle, false);
}

/** Document-level dismissal, installed exactly once for the page. The dock
 * is resolved from the live document on each event (never captured), so
 * leaving and re-entering the reader — which rebuilds `#reader` — cannot
 * stack listeners or leave one pointing at a detached element. */
let dismissBound = false;
function wireDismissListeners(): void {
  if (dismissBound || typeof document === "undefined") return;
  dismissBound = true;
  const openDock = (): HTMLElement | null => {
    const dock = document.querySelector(".reader .hud-btns") as HTMLElement | null;
    return dock?.classList.contains("more-open") ? dock : null;
  };
  document.addEventListener("pointerdown", (e) => {
    const dock = openDock();
    if (!dock) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest(".hud-btns")) return; // inside the dock: its own handlers decide
    closeMoreMenu(dock);
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const dock = openDock();
    if (!dock) return;
    // Escape closes the menu and nothing else (an open menu is the
    // innermost layer, even over the reader's own Esc-to-hide binding).
    e.preventDefault();
    e.stopPropagation();
    closeMoreMenu(dock);
  }, true);
}

// ---- Click-vs-scroll/selection guard -----------------------------------
// A click inside an overflowing dialogue plate must not count as "advance"
// while the reader is dragging a selection or has not scrolled to the end
// of the visible text. Clicks on plates that fit (the normal case) always
// advance, exactly as before.

let pointerDownAt: { x: number; y: number; scrollTop: number } | null = null;
let pointerMoved = false;
const DRAG_SLOP_PX = 6;

function wirePointerTracking(el: HTMLElement): void {
  if (el.dataset.pointerTrack === "1") return;
  el.dataset.pointerTrack = "1";
  el.addEventListener("pointerdown", (e) => {
    pointerMoved = false;
    const t = e.target as HTMLElement | null;
    const scroller = t?.closest(".textbox-scroll") as HTMLElement | null;
    pointerDownAt = { x: e.clientX, y: e.clientY, scrollTop: scroller?.scrollTop ?? 0 };
  }, { passive: true });
  el.addEventListener("pointermove", (e) => {
    if (!pointerDownAt) return;
    const dx = e.clientX - pointerDownAt.x;
    const dy = e.clientY - pointerDownAt.y;
    if (dx * dx + dy * dy > DRAG_SLOP_PX * DRAG_SLOP_PX) pointerMoved = true;
  }, { passive: true });
}

/** Pure decision for a click inside the dialogue plate (test-pinned).
 * Advancing is fine when the text fits, when it is scrolled to the end, or
 * while it is still typing (that click must complete the line). It is NOT
 * fine while the reader is dragging a selection, has scrolled the plate
 * under the pointer, or has not reached the end of a clipped line. */
export interface ClickGesture {
  /** Content is taller than the plate (`.textbox-scroll` scrolls). */
  overflowing: boolean;
  /** The reader dragged more than the slop distance while the button was
   * down (text selection). */
  moved: boolean;
  /** The scroller's `scrollTop` changed during the gesture. */
  scrolled: boolean;
  /** The scroller is at (or within a few px of) its end. */
  atBottom: boolean;
  /** The typewriter is still revealing this line. */
  typing: boolean;
}

export function advanceBlockedByGesture(g: ClickGesture): boolean {
  // A click on a half-typed line completes it; it never advances.
  if (g.typing) return false;
  // Text that fits needs no scroll: clicking anywhere advances, as always.
  if (!g.overflowing) return false;
  // Selection drag / wheel scroll inside the plate: not an advance.
  if (g.moved || g.scrolled) return true;
  // Still clipped: the reader has not read to the end of this line yet.
  return !g.atBottom;
}

/** Should this click be swallowed instead of advancing? Reads the gesture
 * state captured by `wirePointerTracking`. */
export function clickBlockedByTextGesture(target: HTMLElement | null): boolean {
  return textGestureVerdict(target) !== "advance";
}

export type TextClickVerdict = "advance" | "reveal" | "none";

/** What a click on the dialogue plate should do:
 *  - "advance": the line fits / is at its end / is still typing,
 *  - "reveal":  the line is clipped and unread, so scroll the plate a page
 *               forward instead of skipping unread text,
 *  - "none":    the pointer already dragged/scrolled the plate; the reader
 *               is positioning the view, not asking to move on. */
export function textGestureVerdict(target: HTMLElement | null): TextClickVerdict {
  const scroller = target?.closest(".textbox-scroll") as HTMLElement | null;
  const downAt = pointerDownAt;
  const moved = pointerMoved;
  pointerDownAt = null;
  pointerMoved = false;
  if (!scroller) return "advance";
  const scrolled = !!downAt && Math.abs(scroller.scrollTop - downAt.scrollTop) > 2;
  const blocked = advanceBlockedByGesture({
    overflowing: scroller.scrollHeight > scroller.clientHeight + 2,
    moved,
    scrolled,
    atBottom: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4,
    typing: !!scroller.dataset.typing,
  });
  if (!blocked) return "advance";
  // A drag or an in-flight scroll already moved the view: never move it
  // again, the reader is in control of the position.
  return moved || scrolled ? "none" : "reveal";
}

/** Next page offset for a clipped line (pure: test-pinned). One page is
 * 85% of the plate, so a line of prose never jumps past a whole screenful. */
export function nextTextPage(scrollTop: number, clientHeight: number, scrollHeight: number): number {
  const page = Math.max(40, Math.round(Math.max(0, clientHeight) * 0.85));
  const max = Math.max(0, scrollHeight - clientHeight);
  return Math.min(Math.max(0, scrollTop) + page, max);
}

/** Reveal the next page of a clipped line (click on hidden text). */
export function revealNextTextPage(scroller: HTMLElement): void {
  scroller.scrollTop = nextTextPage(
    scroller.scrollTop,
    scroller.clientHeight,
    scroller.scrollHeight,
  );
  syncOverflowEdges(scroller);
}

export function renderReader(el: HTMLElement, h: ReaderHooks): void {
  clearTimers();
  curHooks = h;
  readerLive = true;
  const { router, save } = h;
  const pos = save.position;
  const ev = router.at(pos);
  const sc = router.scripts.get(pos.script);

  const total = sc ? sc.events.length : 1;
  const pct = sc && total > 0
    ? Math.max(0, Math.min(100, Math.round((pos.event / total) * 100)))
    : 0;
  const where = sc
    ? `${chapterOfScript(pos.script)} · ${pos.script} · ${pct}%`
    : `unknown position ${pos.script}:${pos.event}`;
  const sceneDate = displayDate(router.flowNode(pos)?.date, !!h.settings.dev);

  const chapter = pos.script.startsWith("demo") ? "Demo" : {
    intro: "Introductory chapter",
    closing: "Closing chapter",
    coda: "Coda",
    special: "Special",
  }[chapterOfScript(pos.script)] ?? "Special";

  if (!el.firstElementChild?.classList.contains("reader")) {
    el.innerHTML = `
      <div class="reader">
        <div class="reader-progress" aria-hidden="true"><i></i></div>
        <div class="stage" id="stage"></div>
        <div class="reader-top">
          <div class="reader-where">
            <span class="chapter"></span>
            <span class="place"></span>
          </div>
          <span class="hud-btns" role="group" aria-label="Reader menu">
            <button data-act="auto" title="Auto-play"></button>
            <button data-act="log">Log</button>
            <button data-quick="save" class="hud-quick" title="Quick save">Q.Save</button>
            <button data-quick="load" class="hud-quick" title="Quick load">Q.Load</button>
            <button data-act="saves">Save</button>
            <span class="hud-more" role="menu" aria-label="More actions">
              <button data-act="flow" role="menuitem">Chart</button>
              <button data-act="guide" role="menuitem">Guide</button>
              <button data-quick="save" class="hud-more-quick" role="menuitem" title="Quick save">Quick save</button>
              <button data-quick="load" class="hud-more-quick" role="menuitem" title="Quick load">Quick load</button>
              <button data-act="hide" role="menuitem" title="Hide text (H)">Hide text</button>
              <button data-act="title" role="menuitem">Title</button>
            </span>
            <button data-act="more" class="hud-expand" aria-haspopup="true" aria-expanded="false" aria-label="More menu">More</button>
          </span>
        </div>
        <div class="reader-bottom">
          <div class="textbox" id="textplate"><div class="textbox-scroll" id="textbox"></div></div>
          <div class="choices" id="choices"></div>
          <div class="advance-hint" id="hint">Click, Enter or Space to continue · hold Ctrl to skip · H hides the text · scroll up for the backlog</div>
        </div>
      </div>`;
    el.querySelectorAll("[data-act]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const act = (b as HTMLElement).dataset.act as string;
        if (act === "more") {
          // CSS shows the menu via `.hud-btns.more-open > .hud-more`, so the
          // state lives on the dock (toggling the inner span did nothing).
          const dock = b.closest(".hud-btns") as HTMLElement | null;
          const open = !dock?.classList.contains("more-open");
          setMoreOpen(dock, b as HTMLElement, open);
          return;
        }
        // Any picked action folds the dropdown behind it.
        const dock = b.closest(".hud-btns") as HTMLElement | null;
        closeMoreMenu(dock);
        if (act === "hide") {
          toggleText(el.querySelector(".reader") as HTMLElement, true);
          return;
        }
        curHooks?.open(act);
      }),
    );
    el.querySelectorAll("[data-quick]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        closeMoreMenu(el.querySelector(".hud-btns") as HTMLElement | null);
        if ((b as HTMLElement).dataset.quick === "save") curHooks?.quickSave?.();
        else curHooks?.quickLoad?.();
      }),
    );
    wireDismissListeners();
    wirePointerTracking(el);
    // Overflow fades follow the scroll position, not just the paint: at
    // scrollTop 0 the top fade must go away so the first line is not grey.
    el.addEventListener("scroll", (e) => {
      const t = e.target as HTMLElement | null;
      if (t?.classList.contains("textbox-scroll")) syncOverflowEdges(t);
    }, true);
    el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement | null;
      // Chrome and choices own their own clicks.
      if (t?.closest("button, a, input, select, textarea, [role='button']")) return;
      if (moviePlaying()) return;
      const verdict = textGestureVerdict(t);
      if (verdict === "none") return;
      const reader = el.querySelector(".reader") as HTMLElement;
      if (textHidden) {
        toggleText(reader, false);
        return;
      }
      if (verdict === "reveal") {
        // Clipped line: the click turns the page of text instead of
        // skipping prose the reader has not seen yet.
        const scroller = t?.closest(".textbox-scroll") as HTMLElement | null;
        if (scroller) revealNextTextPage(scroller);
        return;
      }
      advanceHandler?.();
    });
    // Middle-click hides the text (mouse-only convenience) without
    // advancing, so the art can be looked at whole.
    el.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      toggleText(el.querySelector(".reader") as HTMLElement, !textHidden);
    });
    // Standard VN convention: wheel-up opens the backlog — once per
    // gesture, never from trackpad inertia, never over a scrolling pane.
    // `deltaMode` matters: Firefox reports DOM_DELTA_LINE for a plain mouse
    // notch, so a raw -3 would never reach the 50 px notch threshold.
    el.addEventListener("wheel", (e) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".choices, .textbox-scroll, .log, .fc-wrap, .slots, .settings, .movie-layer")) return;
      const dy = normalizeWheelDelta(e.deltaY, e.deltaMode);
      if (wheelGesture(wheelState, dy, performance.now())) {
        e.preventDefault();
        curHooks?.open("log");
      }
    }, { passive: false });
    trackIdle(el);
    // The plate's height cap is relative to the actual frame (portrait
    // readers are not 16:9), so publish it as a custom property.
    const readerEl = el.querySelector(".reader") as HTMLElement;
    const publishHeight = () => {
      readerEl.style.setProperty("--reader-h", `${readerEl.clientHeight}px`);
    };
    publishHeight();
    if (typeof ResizeObserver !== "undefined") {
      // One observer per reader element: the skeleton is built once and
      // reused, so this never stacks.
      observer?.disconnect();
      observer = new ResizeObserver(publishHeight);
      observer.observe(readerEl);
    }
  }

  const prog = el.querySelector(".reader-progress > i") as HTMLElement;
  prog.style.width = `${pct}%`;
  const whereEl = el.querySelector(".reader-where") as HTMLElement;
  // Script ids are a build artifact, not story text: only tooltip them in
  // dev mode (a hover revealing "2012_020:1171" breaks the fiction).
  if (h.settings.dev) whereEl.title = where;
  else whereEl.removeAttribute("title");
  (whereEl.querySelector(".chapter") as HTMLElement).textContent = chapter;
  (whereEl.querySelector(".place") as HTMLElement).textContent =
    `${sceneDate ? ` · ${sceneDate}` : ""} · ${pct}%`;
  const autoBtn = el.querySelector('[data-act="auto"]') as HTMLButtonElement;
  const autoOn = h.settings.autoDelay > 0;
  autoBtn.setAttribute("aria-pressed", String(autoOn));
  autoBtn.classList.toggle("active", autoOn);
  // Constant short label: the gold .active state plus aria-pressed carry
  // the on/off meaning, and the dock stays narrow on phones.
  autoBtn.textContent = "Auto";
  autoBtn.title = autoOn ? "Auto-play on (click to pause)" : "Auto-play off";

  paintStage(el.querySelector("#stage") as HTMLElement, save, h.settings.bgmVol, !!h.demo, !!h.settings.dev, ev?.t === "movie");
  fireSe(save);
  updateAmbient(save, ev?.t === "movie");
  // Hide-text state survives a re-render (Auto toggle, settings) but never
  // leaks in from another screen with no visible way to undo it.
  const shell = el.querySelector(".reader") as HTMLElement;
  shell.classList.toggle("text-hidden", textHidden);
  const plate = el.querySelector("#textplate") as HTMLElement;
  const box = el.querySelector("#textbox") as HTMLElement;
  const ch = el.querySelector("#choices") as HTMLElement;
  const hint = el.querySelector("#hint") as HTMLElement;
  box.classList.remove("prompt-only");
  plate.classList.remove("prompt-only", "movie-host");
  delete box.dataset.typing;
  // A previous long line's overflow flags must not mask the next paint
  // (a choice prompt is short, but it inherited the old fade).
  delete box.dataset.overflow;
  delete box.dataset.fadeTop;
  delete box.dataset.fadeBottom;
  ch.innerHTML = "";
  hint.style.display = "";
  advanceHandler = null;

  if (!ev) {
    // Past the end of a script: try to keep going (heals stale saves),
    // else offer wayfinding instead of stranding the player.
    const cont = router.advance(pos, save.flags);
    if (!cont.ended) {
      save.position = skipLatches(router, cont.pos, save.flags);
      if (!save.visited.includes(save.position.script)) save.visited.push(save.position.script);
      pushLog(router, save);
      writeAutosave(localStorage, save);
      h.onChange();
      return;
    }
    if (cont.ending && !save.endings.includes(cont.ending)) {
      save.endings.push(cont.ending);
      writeAutosave(localStorage, save);
      h.notify(`Ending recorded: ${cont.ending}`);
    }
    box.innerHTML = `<div class="narrate">End of ${escapeAttr(pos.script)}</div>
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
    advanceHandler = null;
    return;
  }

  if (ev.t === "choice") {
    hint.style.display = "none";
    plate.classList.add("prompt-only");
    box.classList.add("prompt-only");
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    el.querySelector(".reader")?.classList.remove("stage-idle");
    const node = router.flowNode(pos);
    const choiceDate = displayDate(node?.date, !!h.settings.dev);
    box.innerHTML = `<div class="narrate choice-prompt">Choose${
      choiceDate ? ` <span class="dim">${escapeAttr(choiceDate)}</span>` : ""
    }</div>`;
    for (const o of ev.options) {
      const gate = node?.gated?.[String(o.n)] ?? null;
      const b = document.createElement("button");
      b.className = "choice-btn";
      // `(needs ...)` is a flow-annotation gate string: mechanics, not
      // story. Hidden unless dev mode is on.
      const gateHtml = gate && h.settings.dev
        ? ` <span class="lock">(${escapeAttr(gate)})</span>`
        : "";
      b.innerHTML = renderText(o.text) + gateHtml;
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
        if (!save.visited.includes(save.position.script)) save.visited.push(save.position.script);
        pushLog(router, save);
        writeAutosave(localStorage, save);
        h.onChange();
      };
      ch.appendChild(b);
    }
    advanceHandler = null;
    return;
  }

  if (ev.t === "say" || ev.t === "narrate") {
    const key = `${pos.script}:${pos.event}`;
    const sameLine = lastPainted?.key === key;
    // A re-render from the backlog/settings/chart, or an Auto toggle, must
    // not re-type a line that was already fully shown.
    const alreadyDone = sameLine && lastPainted!.done;
    if (!alreadyDone) playVoice(save, ev, h.settings.voiceVol);
    // Capture whether this line was read BEFORE this display: markRead()
    // runs now, so checking isRead() later in scheduleAuto() always said
    // "read" and Ctrl-skip ignored the read-only setting entirely.
    currentWasRead = sameLine ? currentWasRead : isRead(save);
    markRead(save);
    const cls = ev.t === "say" ? "say" : "narrate";
    const who = ev.t === "say" && displaySpeaker(save, ev)
      ? `<div class="speaker">${escapeAttr(displaySpeaker(save, ev))}</div>` : "";
    const outer = `${cls}${ev.style === "whisper" ? " whisper" : ""}`;
    const full = `${who}<div class="${outer}">${renderText(ev.text)}</div>`;
    const reduceMotion = typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const speed = h.skip.active || reduceMotion ? 0 : h.settings.textSpeed;
    if (speed > 0 && !alreadyDone) {
      lastPainted = { key, full, done: false };
      startTypewriter(box, full, ev.text, who, outer, speed, () => {
        lastPainted = { key, full, done: true };
        resetBoxScroll(box);
        scheduleAuto(h);
      });
      resetBoxScroll(box);
    } else {
      // Instant reveal (speed 0) or a previously completed line.
      box.innerHTML = full;
      lastPainted = { key, full, done: true };
      resetBoxScroll(box);
      scheduleAuto(h);
    }
    advanceHandler = () => {
      if (!alreadyDone && completeTypewriter(box, full)) {
        // A manual completion must still arm auto/skip, or the line sits
        // forever in auto mode until another event re-renders.
        lastPainted = { key, full, done: true };
        scheduleAuto(h);
        return; // first click completes
      }
      stepForward(h);
    };
    preloadMovieAhead(nextMovieUrl(h, pos));
    return;
  }

  if (ev.t === "movie") {
    lastPainted = null;
    // The film owns the stage: hide the dialogue plate entirely and let
    // the movie layer render its own chrome (subtitles + HUD).
    plate.classList.add("movie-host");
    box.innerHTML = "";
    hint.style.display = "none";
    const movieKey = { script: pos.script, event: pos.event };
    // P0/P1-1: capture the *save object* the film opened on, not just its
    // position. `loadSaveIntoGame()` swaps `save` wholesale, and a save that
    // happens to stand on the same script:event would still let a stale
    // onended advance the newly loaded story one line.
    const movieSave = save;
    const url = movieUrl(ev.id);
    openMovie(el.querySelector(".reader") as HTMLElement, {
      id: ev.id,
      url,
      subtitleUrl: url ? subtitleUrl(ev.id) : null,
      volume: h.settings.bgmVol,
      hooks: {
        onOpen: () => {
          duckForMovie(true);
          // A Ctrl held into the movie must stop here: releasing skip means
          // it cannot blast through the first post-film line when the film
          // ends and the reader re-renders. main.ts clears its own flag via
          // onSkipStop, so a still-held Ctrl needs a fresh keydown.
          if (h.skip.active) {
            h.skip.active = false;
            h.onSkipStop();
          }
          clearAuto();
        },
        onClose: (advancing) => duckForMovie(false, advancing),
        onFinish: () => {
          // Idempotent inside the module, but a screen change (save load,
          // backlog jump) may have moved the story on meanwhile: only
          // advance if this is still the same save standing on the same
          // movie event.
          if (!currentSaveMatches(movieSave, save, movieKey)) return;
          stepForward(h);
        },
      },
    });
    advanceHandler = null;
    return;
  }

  lastPainted = null;
  plate.classList.remove("movie-host");
  // Directives / latches auto-advance on click.
  const label =
    ev.t === "image" ? `Image ${ev.file} [${ev.layer ?? "?"}]` :
    ev.t === "filter" ? `Colour grade ${ev.file}` :
    ev.t === "anim" ? `Animation ${ev.file} [${ev.layer ?? "?"}]` :
    ev.t === "bgm" ? `Music ${ev.file}` :
    ev.t === "latch" ? `Flag ${ev.name}` :
    ev.t === "jump" ? `Branch ${ev.kind} ${ev.targets.join(" ")}` :
    ev.t === "layer" ? `Layer ${ev.layer}` : "…";
  // Mechanical labels are dev-only; for players the beat is instantaneous
  // and silent, so an empty plate that fades is friendlier than jargon.
  box.innerHTML = h.settings.dev
    ? `<div class="narrate dim">${escapeAttr(label)}</div>`
    : `<div class="narrate dim beat"></div>`;
  advanceHandler = () => stepForward(h);
  preloadMovieAhead(nextMovieUrl(h, pos));
}

/** Scroll a freshly painted line back to its first line, and flag whether
 * the content overflows so the plate can show its subtle top/bottom fade.
 * Long lines (400–1000+ chars) scroll inside the plate; the opening must
 * always be visible, never clipped above the frame. Both the inner scroller
 * and its portrait parent (`.reader-bottom` scrolls in flow layout) are
 * reset, or a portrait reader keeps the previous line's offset. */
function resetBoxScroll(box: HTMLElement): void {
  box.scrollTop = 0;
  const bottom = box.closest(".reader-bottom") as HTMLElement | null;
  if (bottom) bottom.scrollTop = 0;
  updateOverflowFlag(box);
}

function updateOverflowFlag(box: HTMLElement): void {
  // Measured after layout: a synchronous read here forces one reflow per
  // painted line, which is cheaper than a scrollbar that lies.
  requestAnimationFrame(() => {
    if (!box.isConnected) return;
    const over = box.scrollHeight - box.clientHeight > 4;
    if (over) box.dataset.overflow = "1";
    else delete box.dataset.overflow;
    syncOverflowEdges(box);
  });
}

/** Publish which edges are actually clipped: the top fade must disappear at
 * scrollTop 0 (otherwise the first line reads as greyed out) and the bottom
 * fade at the end of the text. */
function syncOverflowEdges(box: HTMLElement): void {
  const data = box.dataset;
  if (!data) return; // plain test double / exotic DOM: nothing to publish
  if (!data.overflow) {
    delete data.fadeTop;
    delete data.fadeBottom;
    return;
  }
  const top = box.scrollTop > 1;
  const bottom = box.scrollTop + box.clientHeight < box.scrollHeight - 2;
  if (top) data.fadeTop = "1";
  else delete data.fadeTop;
  if (bottom) data.fadeBottom = "1";
  else delete data.fadeBottom;
}

/** Position guard for the movie finish hook. */
export function currentPositionMatches(save: SaveData, at: { script: string; event: number }): boolean {
  return save.position.script === at.script && save.position.event === at.event;
}

/** Full identity guard for a hook captured at render time: the same object
 * must still be the live save AND still stand on the same script:event.
 * `loadSaveIntoGame()` replaces the save object (even when the new save
 * stands on the identical position), so reference equality is required to
 * prove a stale movie/branch hook cannot advance a freshly loaded story. */
export function currentSaveMatches(
  captured: SaveData,
  live: SaveData,
  at: { script: string; event: number },
): boolean {
  return captured === live && currentPositionMatches(live, at);
}

/** Look ahead from the current position for the next movie cue and warm
 * its metadata while the player reads. Bounded scan: a movie is usually a
 * handful of events away, and a full-script scan on every render would
 * cost more than the buffer it saves. The default window covers the longest
 * directive run between two films (a scene change can be ~90 events), so a
 * back-to-back chain (1013, mv08 -> mv09) still warms its second film. */
export function nextMovieUrl(h: { router: Router; save: SaveData }, pos: Position, lookahead = 120): string | null {
  const sc = h.router.scripts.get(pos.script);
  if (!sc) return null;
  const from = pos.event + 1;
  const to = Math.min(sc.events.length, from + Math.max(0, lookahead));
  for (let i = from; i < to; i++) {
    const e = sc.events[i];
    if (e.t === "movie") return movieUrl(e.id);
  }
  return null;
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

/** Pure skip-read gate (test-pinned): read-only skip must stop at a line
 * that had not been displayed before this render. */
export function skipBlocked(active: boolean, skipRead: boolean, wasRead: boolean): boolean {
  return active && skipRead && !wasRead;
}

/** Auto-advance scheduling (auto mode + Ctrl-held skip mode).
 * Read-mode skip halts on the first unread line (never advances past it). */
function scheduleAuto(h: ReaderHooks): void {
  clearAuto();
  if (!readerLive) return;
  const delay = h.skip.active ? 120 : h.settings.autoDelay;
  if (delay <= 0) return;
  const ev = h.router.at(h.save.position);
  if (!ev || ev.t === "choice") return; // never auto-pick
  // A playing film advances on its own `ended` (its own duration), and a
  // missing-movie card waits for Continue. Auto must not skip past it.
  if (ev.t === "movie" || moviePlaying()) return;
  if (skipBlocked(h.skip.active, h.settings.skipRead, currentWasRead)) {
    h.skip.active = false;
    h.onSkipStop();
    return;
  }
  autoTimer = window.setTimeout(() => {
    autoTimer = null;
    if (!readerLive) return;
    if (skipBlocked(h.skip.active, h.settings.skipRead, currentWasRead)) {
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
  // Ctrl-skip must never blast through a movie: a 5-minute film would be
  // over in 120 ms. The viewer presses Skip explicitly instead.
  if (moviePlaying()) return;
  cutVoice();
  lastPainted = null;
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

function paintStage(
  stage: HTMLElement,
  save: SaveData,
  bgmVol: number,
  demo: boolean,
  dev: boolean,
  /** The position being rendered IS a movie: never start a BGM cue for the
   * one frame before `openMovie` silences the mix (back-to-back films such
   * as mv08 -> mv09 flashed the previous scene's music). */
  movieNext = false,
): void {
  const st = stageImageState(save);
  paintBackdrop(stage, st, bnrFadeAt(save));
  // The demo has no game assets; draw an original placeholder scene rather
  // than an empty stage. It is removed as soon as a real backdrop or an
  // engine clear takes over.
  const demoScene = stage.querySelector(":scope > .demo-scene");
  if (demo && !st.url && !st.cleared) {
    stage.style.backgroundImage = "none";
    stage.style.backgroundColor = "#000";
    if (!demoScene) {
      stage.insertAdjacentHTML("afterbegin", `<div class="demo-scene" aria-hidden="true">
        <div class="demo-moon"></div>
        <div class="demo-skyline"></div>
        <div class="demo-snowfield"></div>
      </div>`);
    }
  } else {
    demoScene?.remove();
  }
  // No cue at all (or an engine clear) is the game's own answer: a black
  // screen. Nothing is written across it — a "no backdrop" label was the
  // most immersion-breaking thing the old reader did. A missing install is
  // only ever a tiny corner tag, and only in dev mode.
  stage.classList.toggle("stage-black", !st.url && !(demo && !st.cleared));
  const tag = stage.querySelector(":scope > .stage-tag") as HTMLElement | null;
  const tagText = st.missingFile && dev ? `Missing ${st.missingFile}` : "";
  if (tagText) {
    if (tag) tag.textContent = tagText;
    else {
      const div = document.createElement("div");
      div.className = "stage-tag";
      div.textContent = tagText;
      stage.appendChild(div);
    }
  } else {
    tag?.remove();
  }
  stage.style.filter = stageFilter(save);
  paintOverlay(stage, save);
  paintSprites(stage, save);
  paintBgm(save, bgmVol, movieNext);
}

/** Crossfade the backdrop with a two-layer <img> pair.
 *
 * `background-image` cannot animate (the old `transition-duration` on the
 * stage was inert), and replacing a single <img> pops. Two layers let the
 * outgoing art fade under the incoming art; the engine's .bnr fade duration
 * is the transition time.
 *
 * A clear fades the last frame out to black over that same duration (the
 * engine's own dissolve), then drops the element: hard-removing the <img>
 * popped the stage to black in one frame on every spotlight scene.
 */
function paintBackdrop(stage: HTMLElement, st: StageImageState, ms: number | null): void {
  const layers = [...stage.querySelectorAll(":scope > img.stage-bg")] as HTMLImageElement[];
  const active = layers.find((l) => l.dataset.active === "1") ?? null;
  const duration = Math.max(0, ms ?? 0);
  if (!st.url) {
    if (duration === 0) {
      for (const l of layers) l.remove();
      stage.style.backgroundImage = "none";
      stage.style.backgroundColor = "#000";
      return;
    }
    // Dissolve to black: keep the frame visible while it fades.
    for (const l of layers) {
      if (l.dataset.active !== "1") {
        l.remove();
        continue;
      }
      l.dataset.active = "";
      l.style.transitionDuration = `${duration}ms`;
      l.style.opacity = "0";
      window.setTimeout(() => {
        if (l.dataset.active !== "1") l.remove();
      }, duration + 60);
    }
    return;
  }
  // A backdrop arriving after a clear: the old layers are already gone.
  if (active?.dataset.cur === st.url) return;
  // Reuse the inactive buffer; if both are absent create one.
  let next = layers.find((l) => l !== active) ?? null;
  if (!next) {
    next = document.createElement("img");
    next.className = "stage-bg";
    next.alt = "";
    stage.prepend(next);
  }
  next.dataset.cur = st.url;
  next.style.transitionDuration = `${duration}ms`;
  next.style.opacity = "0";
  next.style.zIndex = "1";
  next.src = st.url;
  requestAnimationFrame(() => {
    next!.style.opacity = "1";
  });
  if (active) {
    active.dataset.active = "";
    active.style.transitionDuration = `${duration}ms`;
    active.style.opacity = "0";
    active.style.zIndex = "0";
    window.setTimeout(() => {
      if (active.dataset.active !== "1") active.remove();
    }, duration + 60);
  }
  next.dataset.active = "1";
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
    // txt `<file>.tga` + `grp` is event art (overlay), not a backdrop: the
    // engine's txt image driver routes grp to the overlay layer. Treating a
    // grp image as a backdrop let CGs become the stage floor when the
    // overlay later cleared. `null` (missing layer token) keeps legacy bak
    // behavior.
    if (e.t === "image" && e.layer !== "grp") {
      cues.push({ ev: i, file: e.file, rank: 0, seq: seq++ });
    }
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
export function bgmCueAt(save: SaveData): { kind: "play"; url: string; loopUrl?: string; track?: number } | { kind: "stop" } | { kind: "sustain" } {
  const cues = bgmLookup?.(save.position.script);
  if (!cues || cues.length === 0) return { kind: "sustain" };
  const ch = chapterOfScript(save.position.script);
  let track: number | null = null;
  const cue = resolveBgmCue(cues, save.position.event, (t) => {
    const intro = bgmIntroUrl(t, ch);
    const loop = bgmLoopUrl(t, ch);
    const solo = intro || loop ? null : bgmSoloUrl(t, ch);
    if (!intro && !loop && !solo) return null;
    track = t;
    return { url: intro ?? loop ?? solo!, loopUrl: intro ? (loop ?? intro) : (loop ?? solo!) };
  });
  if (cue.kind === "play" && track !== null) {
    return { ...cue, track };
  }
  return cue;
}

/** Pure BGM cue resolver with loop-pair support (DOM-free; test-pinned).
 * The engine plays `_A` (intro) once and then loops `_B`; when only one part
 * exists it loops that. Missing/unresolvable tracks sustain the previous
 * BGM exactly like resolveBgmTimeline. */
export function resolveBgmCue(
  cues: { ev: number; track?: number; stop?: boolean; missing?: boolean }[],
  event: number,
  resolve: (track: number) => { url: string; loopUrl?: string } | null,
): { kind: "play"; url: string; loopUrl?: string } | { kind: "stop" } | { kind: "sustain" } {
  let pending: { kind: "play"; url: string; loopUrl?: string } | { kind: "stop" } | null = null;
  for (const c of cues) {
    if (c.ev > event) break;
    if (c.stop) {
      pending = { kind: "stop" };
    } else if (c.track !== undefined && !c.missing) {
      const r = resolve(c.track);
      if (r) pending = { kind: "play", ...r };
    }
  }
  return pending ?? { kind: "sustain" };
}

/** Pure BGM timeline resolver (DOM-free; test-pinned).
 * Latest cue at/before `event` wins; stops silence; missing tracks and
 * unresolvable files sustain previous BGM (never silence for a play cue). */
export function resolveBgmTimeline(
  cues: { ev: number; track?: number; stop?: boolean; missing?: boolean }[],
  event: number,
  resolve: (track: number) => string | null,
): { kind: "play"; url: string } | { kind: "stop" } | { kind: "sustain" } {
  return resolveBgmCue(cues, event, (t) => {
    const url = resolve(t);
    return url ? { url } : null;
  });
}

type BgmLookup = (script: string) => BgmData["cues"][string] | undefined;
let bgmLookup: BgmLookup | null = null;
export function setBgmLookup(fn: BgmLookup | null): void {
  bgmLookup = fn;
}

function paintBgm(save: SaveData, bgmVol: number, movieNext = false): void {
  const audio = document.getElementById("bgm") as HTMLAudioElement | null;
  if (!audio) return;
  audio.volume = Math.max(0, Math.min(1, bgmVol));
  // A film or a menu owns the mix right now: track state, make no sound.
  // `movieNext` covers the frame before a movie opens (the render that
  // paints `ev.t === "movie"`): starting the previous scene's cue there
  // made back-to-back films flicker stale BGM for one frame.
  if (audioSuspended || moviePlaying() || movieNext) {
    audio.pause();
    return;
  }
  // Loop pairs (engine strings _a/_b): play the intro once, then loop the
  // body. `data-cue` is the cue identity (so an already-advanced A->B pair
  // is not restarted); `data-cur` is the file actually loaded.
  audio.onended = () => {
    const loop = audio.dataset.loopUrl;
    if (loop && audio.dataset.cur !== loop) {
      audio.dataset.cur = loop;
      audio.loop = true;
      audio.src = loop;
      audio.play().catch(() => undefined);
    }
  };
  const start = (url: string, loopUrl?: string) => {
    audio.dataset.cue = url;
    audio.dataset.cur = url;
    audio.dataset.loopUrl = loopUrl ?? "";
    audio.loop = !loopUrl || loopUrl === url;
    audio.src = url;
    audio.play().catch(() => undefined);
  };
  const stop = () => {
    if (!audio.dataset.cue) return;
    delete audio.dataset.cue;
    delete audio.dataset.cur;
    delete audio.dataset.loopUrl;
    audio.loop = false;
    audio.pause();
    audio.removeAttribute("src");
  };
  const trackParts = (track: number) => {
    const ch = chapterOfScript(save.position.script);
    const intro = bgmIntroUrl(track, ch);
    const loop = bgmLoopUrl(track, ch);
    const solo = intro || loop ? null : bgmSoloUrl(track, ch);
    const url = intro ?? loop ?? solo;
    return url
      ? { url, loopUrl: intro ? (loop ?? intro) : (loop ?? solo ?? url) }
      : null;
  };
  const cue0 = bgmCueAt(save);
  let cue = cue0;
  if (cue.kind === "sustain") {
    // The engine inherits BGM across files. On a fresh page / save load the
    // audio element has no state, and after jumping to another script it may
    // still hold an unrelated track; reconcile it with the save's last track
    // (undefined = legacy save, null = explicit stop).
    if (save.bgm === null) {
      stop();
    } else if (save.bgm && typeof save.bgm.track === "number") {
      const target = trackParts(save.bgm.track);
      if (target && audio.dataset.cue !== target.url) {
        cue = { kind: "play", track: save.bgm.track, ...target };
      }
    }
  }
  if (cue.kind === "play") {
    if (audio.dataset.cue !== cue.url) start(cue.url, cue.loopUrl);
    if (cue.track !== undefined && save.bgm?.track !== cue.track) {
      save.bgm = { track: cue.track };
      writeAutosave(localStorage, save);
    }
  } else if (cue.kind === "stop") {
    stop();
    if (save.bgm !== null) {
      save.bgm = null;
      writeAutosave(localStorage, save);
    }
  }
  // sustain: leave the current track playing (engine inherits BGM across
  // files; only explicit stops silence it).
  //
  // Autoplay retry: a cold load (e.g. deep link or save resume without a
  // user gesture) rejects play(); the cue URL stays current, so retry on
  // every render — the next advance is a user gesture and starts the track
  // instead of leaving the session silent forever.
  if (audio.dataset.cur && audio.paused) {
    if (!audioSuspended && !moviePlaying()) audio.play().catch(() => undefined);
  }
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
 * records fire; hypothesis records are ignored by design. Returns every SE
 * id anchored in `(from, to]` in statement order: a step may skip directive
 * events (skipLatches), and two statements can share one anchor event. */
export function resolveSeIds(
  recs: { ev: number; se?: number[]; conf: string }[],
  from: number,
  to: number,
): number[] {
  const out: number[] = [];
  for (const r of recs) {
    if (r.conf !== "high" || !r.se?.length) continue;
    if (r.ev > from && r.ev <= to) out.push(...r.se);
  }
  return out;
}

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

// Last position whose SEs have fired. A render only fires the events
// crossed since the previous render: re-rendering the same line (open/close
// backlog, settings) must not replay its sound, while stepping over skipped
// directive events must still fire theirs.
let seCursor: { script: string; ev: number } | null = null;

function playSeUrl(url: string): void {
  const start = (src: string) => {
    const audio = document.getElementById("se") as HTMLAudioElement | null;
    if (!audio) return;
    if (!audio.paused) {
      // Two SEs can share one anchor event. Keep the shared element for the
      // first and play overlaps on a transient element instead of cutting.
      const extra = new Audio(src);
      extra.play().catch(() => undefined);
      return;
    }
    audio.src = src;
    audio.play().catch(() => undefined);
  };
  if (!url.includes("#")) {
    start(url);
    return;
  }
  void resolveAudioUrl(url).then((resolved) => {
    if (resolved) start(resolved);
  });
}

function fireSe(save: SaveData): void {
  const script = save.position.script;
  const ev = save.position.event;
  const cur = seCursor;
  if (cur && cur.script === script && cur.ev === ev) return;
  seCursor = { script, ev };
  const recs = bnrLookup?.(script);
  if (!recs) return;
  // Forward inside one script: fire the crossed range. First render / save
  // load / backward seek: fire only the current event.
  const from = cur && cur.script === script && ev > cur.ev ? cur.ev : ev - 1;
  const ch = chapterOfScript(script);
  for (const id of resolveSeIds(recs, from, ev)) {
    const url = seUrl(id, ch);
    if (url) playSeUrl(url);
  }
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

/** Latest high-confidence state per ambient channel at/before an event.
 *
 * A per-event lookup (the old resolveAmbCue/resolveAmbStop pair) loses cues
 * whenever the reader steps over directive events (skipLatches) and starts
 * silent after loading a save mid-scene. The engine keeps channel state, so
 * the player resolves the same lifetime: replay every cue up to the event
 * in statement order, last write per channel wins. */
export type AmbTimelineEntry =
  | { kind: "play"; cue: AmbCue }
  | { kind: "stop" };

export function resolveAmbientTimeline(
  recs: { ev: number; amb?: AmbCue; ambStop?: number; conf: string }[],
  event: number,
): Map<number, AmbTimelineEntry> {
  const out = new Map<number, AmbTimelineEntry>();
  const ordered = [...recs].sort((a, b) => a.ev - b.ev);
  for (const r of ordered) {
    if (r.conf !== "high" || r.ev > event) continue;
    if (r.amb) out.set(r.amb.ch, { kind: "play", cue: r.amb });
    else if (r.ambStop !== undefined) out.set(r.ambStop, { kind: "stop" });
  }
  return out;
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

function updateAmbient(save: SaveData, movieNext = false): void {
  if (audioSuspended || moviePlaying() || movieNext) {
    for (const a of ambElsPlaying()) a.pause();
    return;
  }
  if (ambScript !== null && ambScript !== save.position.script) {
    stopAllAmb();
  }
  ambScript = save.position.script;
  const recs = bnrLookup?.(save.position.script);
  if (!recs) return;
  const timeline = resolveAmbientTimeline(recs, save.position.event);
  const ch = chapterOfScript(save.position.script);
  // A backward seek/load may land before a channel's cue: anything the
  // timeline does not keep alive must stop (engine channel state is
  // positional, not "whatever was playing last").
  for (const activeCh of [...ambEls.keys()]) {
    if (!timeline.has(activeCh)) stopAmbChannel(activeCh);
  }
  for (const [chan, state] of timeline) {
    if (state.kind === "stop") {
      stopAmbChannel(chan);
      continue;
    }
    const cue = state.cue;
    const url = seUrl(cue.se, ch);
    let a = ambEls.get(chan);
    if (!a) {
      a = document.createElement("audio");
      a.dataset.ch = String(chan);
      ambEls.set(chan, a);
    }
    if (!url) {
      // missing asset: silence the channel rather than replay a stale cue
      stopAmbChannel(chan);
      continue;
    }
    if (a.dataset.cur === url) {
      // Same cue still active: never restart the loop on a re-render.
      a.loop = cue.loop;
      a.volume = Math.max(0, Math.min(1, cue.vol / 255));
      if (a.paused && a.src) a.play().catch(() => undefined);
      continue;
    }
    a.dataset.cur = url;
    a.loop = cue.loop;
    a.volume = Math.max(0, Math.min(1, cue.vol / 255));
    if (!url.includes("#")) {
      a.src = url;
      a.play().catch(() => undefined);
    } else {
      a.pause();
      a.removeAttribute("src");
      const elAudio = a;
      void resolveAudioUrl(url).then((resolved) => {
        if (!resolved || elAudio.dataset.cur !== url) return;
        elAudio.src = resolved;
        elAudio.play().catch(() => undefined);
      });
    }
  }
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
  // Event numbers are non-decreasing in statement order (engine invariant,
  // enforced by decode_bnr's stream clamp); stable-sort guards against any
  // out-of-order input so a late-listed sprClear can't wipe every scene.
  const ordered = [...(recs ?? [])].sort((a, b) => a.ev - b.ev);
  for (const r of ordered) {
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
  const chapter = chapterOfScript(save.position.script);
  const seen = new Set<number>();
  active.forEach((s, i) => {
    const url = imageUrl(`${s.stem}.tga`, chapter);
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

let voicePlaySeq = 0;

/** ---- Global audio coordination ---------------------------------------- */
// A movie carries its own score: BGM, voice and ambience must fall silent
// while it plays. Returning to the title must silence everything too, and
// returning to the reader must restore exactly what the save says belongs
// on stage (never "whatever was playing before the menus").

let audioSuspended = false;

function ambElsPlaying(): HTMLAudioElement[] {
  return [...ambEls.values()];
}

/** Pause every music/voice/ambience element, remembering which were live. */
export function suspendAudio(): void {
  audioSuspended = true;
  const bgm = document.getElementById("bgm") as HTMLAudioElement | null;
  if (bgm && !bgm.paused) bgm.dataset.wasPlaying = "1";
  bgm?.pause();
  cutVoice();
  for (const a of ambElsPlaying()) {
    if (!a.paused) a.dataset.wasPlaying = "1";
    a.pause();
  }
}

/** Resume what suspendAudio() paused (BGM re-syncs via paintBgm anyway). */
export function resumeAudio(): void {
  audioSuspended = false;
  const bgm = document.getElementById("bgm") as HTMLAudioElement | null;
  if (bgm?.dataset.wasPlaying) {
    delete bgm.dataset.wasPlaying;
    if (bgm.src) bgm.play().catch(() => undefined);
  }
  for (const a of ambElsPlaying()) {
    if (a.dataset.wasPlaying) {
      delete a.dataset.wasPlaying;
      if (a.src) a.play().catch(() => undefined);
    }
  }
}

export function audioIsSuspended(): boolean {
  return audioSuspended;
}

/** Movie open/close: duck the session audio and restore it afterwards.
 * When the film *advances* the story, the restore is skipped — the next
 * render paints whatever BGM the new position owns, and resuming the old
 * cue first would audibly flash the previous scene's music. */
function duckForMovie(enter: boolean, advancing = false): void {
  if (enter) {
    const bgm = document.getElementById("bgm") as HTMLAudioElement | null;
    if (bgm && !bgm.paused) bgm.dataset.wasPlaying = "1";
    bgm?.pause();
    cutVoice();
    for (const a of ambElsPlaying()) {
      if (!a.paused) a.dataset.wasPlaying = "1";
      a.pause();
    }
    return;
  }
  // Advancing: drop the remembered flags so nothing resumes behind the
  // next line. paintBgm/updateAmbient start the right cue on the re-render.
  if (advancing) {
    const bgm = document.getElementById("bgm") as HTMLAudioElement | null;
    if (bgm?.dataset.wasPlaying) delete bgm.dataset.wasPlaying;
    for (const a of ambElsPlaying()) delete a.dataset.wasPlaying;
    return;
  }
  if (audioSuspended) return;
  const bgm = document.getElementById("bgm") as HTMLAudioElement | null;
  if (bgm?.dataset.wasPlaying) {
    delete bgm.dataset.wasPlaying;
    if (bgm.src) bgm.play().catch(() => undefined);
  }
  for (const a of ambElsPlaying()) {
    if (a.dataset.wasPlaying) {
      delete a.dataset.wasPlaying;
      if (a.src) a.play().catch(() => undefined);
    }
  }
}

/** Play the voice clip for a displayed line, if the archive has it. */
function playVoice(save: SaveData, ev: ScenarioEvent, vol: number): void {
  const audio = document.getElementById("voice") as HTMLAudioElement | null;
  if (!audio) return;
  if (moviePlaying()) {
    cutVoice();
    return;
  }
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
      const seq = ++voicePlaySeq;
      audio.dataset.cur = url;
      if (!url.includes("#")) {
        audio.src = url;
        audio.play().catch(() => undefined);
      } else {
        audio.pause();
        audio.removeAttribute("src");
        void resolveAudioUrl(url).then((resolved) => {
          if (seq !== voicePlaySeq || !resolved || audio.dataset.cur !== url) return;
          audio.src = resolved;
          audio.play().catch(() => undefined);
        });
      }
    }
  } else {
    cutVoice();
  }
}

function cutVoice(): void {
  ++voicePlaySeq;
  const audio = document.getElementById("voice") as HTMLAudioElement | null;
  if (audio && audio.dataset.cur) {
    delete audio.dataset.cur;
    audio.pause();
    audio.removeAttribute("src");
  }
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
