// Timed BYOA captions for voice clips and sound effects.
//
// The data is user-supplied (`data/captions.json` in a pack); the repo never
// ships subtitle text. Cues are absolute ms into the audio element that is
// actually playing, half-open: `begin <= t < end`.
//
// The lookup stays pure (unit-pinned). The tiny controller below owns the
// single caption bar and the rAF loop, so the reader only has to bind an
// audio element to a cue list and clear it when the line/scene changes.

import type { CaptionCue, CaptionData } from "./types";

/** Active caption text at `ms`. Overlapping cues are joined with a newline.
 * Source order is preserved (the data is expected to be chronological).
 * Anything outside every cue returns "". */
export function textAt(
  cues: readonly CaptionCue[] | null | undefined,
  ms: number,
): string {
  if (!cues || cues.length === 0 || !Number.isFinite(ms)) return "";
  const active: string[] = [];
  for (const cue of cues) {
    if (!cue || !Number.isFinite(cue.begin) || !Number.isFinite(cue.end)) continue;
    if (ms >= cue.begin && ms < cue.end && cue.text) active.push(cue.text);
  }
  return active.join("\n");
}

/** Voice captions are keyed by the exact manifest voice key
 * (`1008_0199`, `ic/1002_0000`), the same string the voicemap resolves. */
export function voiceCaptionCues(
  data: CaptionData | null | undefined,
  key: string | null | undefined,
): CaptionCue[] | null {
  if (!data?.voice || !key) return null;
  const cues = data.voice[key];
  return cues && cues.length > 0 ? cues : null;
}

/** SE captions are keyed by the numeric engine SE id (stringified). */
export function seCaptionCues(
  data: CaptionData | null | undefined,
  id: number,
): CaptionCue[] | null {
  if (!data?.se || !Number.isFinite(id)) return null;
  const cues = data.se[String(id)];
  return cues && cues.length > 0 ? cues : null;
}

// ---- Caption bar controller ---------------------------------------------

let bar: HTMLElement | null = null;
let audio: HTMLAudioElement | null = null;
let cues: readonly CaptionCue[] | null = null;
let raf: number | null = null;
/** Audio elements whose pause/seek/play events we already listen to. The
 * page owns three long-lived elements, so this can never grow beyond them. */
const wired = new WeakSet<HTMLAudioElement>();

function canAnimate(): boolean {
  return typeof requestAnimationFrame === "function";
}

function paint(): void {
  if (!bar) return;
  if (!audio || !cues) {
    hideBar();
    return;
  }
  const text = textAt(cues, audio.currentTime * 1000);
  if (!text) {
    hideBar();
    return;
  }
  if (bar.textContent !== text) bar.textContent = text;
  bar.hidden = false;
  delete bar.dataset.empty;
}

function hideBar(): void {
  if (!bar) return;
  if (bar.textContent !== "") bar.textContent = "";
  // Keep the aria-live region in the accessibility tree: `hidden` made some
  // screen readers skip the announcement when the next cue appeared. The
  // `data-empty` CSS collapses it to zero height instead.
  bar.hidden = false;
  bar.dataset.empty = "1";
}

function stopLoop(): void {
  if (raf !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(raf);
  }
  raf = null;
}

function startLoop(): void {
  if (raf !== null) return;
  if (!canAnimate()) {
    paint();
    return;
  }
  const tick = () => {
    if (!audio || !cues) {
      raf = null;
      return;
    }
    paint();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

function wire(a: HTMLAudioElement): void {
  if (wired.has(a)) return;
  wired.add(a);
  // Every transport change re-evaluates the cue at the new position.
  // `play` starts the frame loop, `pause` freezes on the current cue,
  // `seeked` jumps the text immediately, `ended` clears the bar.
  a.addEventListener("play", () => {
    if (audio !== a) return;
    paint();
    startLoop();
  });
  a.addEventListener("pause", () => {
    if (audio !== a) return;
    stopLoop();
    paint();
  });
  a.addEventListener("seeked", () => {
    if (audio === a) paint();
  });
  a.addEventListener("ended", () => {
    if (audio === a) clearCaptions();
  });
  a.addEventListener("error", () => {
    if (audio === a) clearCaptions();
  });
}

/** Point the controller at the reader's caption bar. Re-renders pass the
 * same element (a no-op); a rebuilt reader starts empty. */
export function setCaptionBar(el: HTMLElement | null): void {
  if (bar === el) return;
  clearCaptions();
  bar = el;
}

/** Show `list` while `a` plays. Missing/empty cue lists are ignored: the
 * caller only binds tracks that exist in the caption data. */
export function showCaption(a: HTMLAudioElement, list: readonly CaptionCue[] | null | undefined): void {
  if (!list || list.length === 0) return;
  wire(a);
  audio = a;
  cues = list;
  if (a.paused) {
    // Do not flash the first cue before playback has actually started
    // (autoplay rejection or a source still resolving).
    stopLoop();
    hideBar();
    return;
  }
  paint();
  startLoop();
}

/** A different source is starting on `a`: drop the old cues first, or the
 * new clip's time would be matched against the previous line's captions. */
export function clearCaptionForAudio(a: HTMLAudioElement | null): void {
  if (!a || audio !== a) return;
  clearCaptions();
}

export function clearCaptions(): void {
  stopLoop();
  audio = null;
  cues = null;
  hideBar();
}
