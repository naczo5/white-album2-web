// BMP overlay layers (engine opcode family 0xb0..0xbf).
//
// The script loads a bitmap into a numbered slot, fades it with
// SetBmpParam, moves/zooms it, then releases it. Records between text lines
// share one IR event, so the renderer replays the event's records as a short
// clock: Wait (4,194) supplies the pauses and each SetBmpParam fade uses the
// engine 60 Hz frame. Only conf:"high" records drive playback.
//
// Pure state helpers are exported for tests; the DOM layer owns at most one
// timer chain and one <img> per BMP slot.

import { imageUrl } from "../engine/assets";
import type { BnrData, BnrRec } from "../engine/types";
import { isEventInExecutedRanges } from "../engine/cfg-vm";

export interface BmpLayer {
  id: number;
  file: string;
  folder?: string;
  z: number;
  alpha: number; // 0..255
  /** SetBmpParam blend mode: 3/4 additive, 6 mask (approximated). */
  mode?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  scale?: number;
}

export type BmpRec = BnrRec;
export type BmpLookup = BnrData["recs"][string] | null | undefined;

export const SCRIPT_FRAME_MS = 1000 / 60;

function executed(
  ranges: readonly [number, number][] | undefined,
  ev: number,
  current: number,
): boolean {
  const idx = Math.floor(ev);
  return idx === current || isEventInExecutedRanges(ranges, idx);
}

/** State before `event`: every BMP action at an earlier event is settled;
 * records are applied in stream order, so a later load/release wins. */
export function resolveBmpBase(
  recs: BmpLookup,
  event: number,
  ranges?: readonly [number, number][],
): Map<number, BmpLayer> {
  const state = new Map<number, BmpLayer>();
  for (const r of recs ?? []) {
    if (r.conf !== "high" || r.ev >= event) continue;
    if (!executed(ranges, r.ev, event)) continue;
    applyBmpRecord(state, r);
  }
  return state;
}

/** Records at exactly `event`, in source order (load → alpha → wait →
 * release). */
export function bmpActionsAt(
  recs: BmpLookup,
  event: number,
  ranges?: readonly [number, number][],
): BmpRec[] {
  return (recs ?? []).filter((r) =>
    r.conf === "high" && r.ev === event && executed(ranges, r.ev, event) &&
    (r.bmp !== undefined || r.bmpRelease !== undefined ||
      r.bmpAlpha !== undefined || r.bmpMove !== undefined ||
      r.bmpRect !== undefined || r.bmpScale !== undefined ||
      r.wait !== undefined));
}

/** Apply one BMP record to a layer map (pure). */
export function applyBmpRecord(
  state: Map<number, BmpLayer>,
  r: BmpRec,
): void {
  if (r.bmp) {
    state.set(r.bmp.id, {
      id: r.bmp.id,
      file: r.bmp.file,
      ...(r.bmp.folder ? { folder: r.bmp.folder } : {}),
      z: r.bmp.z,
      alpha: 255,
    });
    return;
  }
  if (r.bmpRelease !== undefined) {
    state.delete(r.bmpRelease);
    return;
  }
  if (r.bmpAlpha) {
    const layer = state.get(r.bmpAlpha.id);
    if (layer) {
      layer.alpha = Math.max(0, Math.min(255, r.bmpAlpha.alpha));
      layer.mode = r.bmpAlpha.mode;
    }
    return;
  }
  if (r.bmpMove) {
    const layer = state.get(r.bmpMove.id);
    if (layer) {
      layer.x = r.bmpMove.x;
      layer.y = r.bmpMove.y;
    }
    return;
  }
  if (r.bmpRect) {
    const layer = state.get(r.bmpRect.id);
    if (layer) {
      layer.x = r.bmpRect.x;
      layer.y = r.bmpRect.y;
      layer.w = r.bmpRect.w;
      layer.h = r.bmpRect.h;
    }
    return;
  }
  if (r.bmpScale) {
    const layer = state.get(r.bmpScale.id);
    if (layer) {
      layer.x = r.bmpScale.x;
      layer.y = r.bmpScale.y;
      layer.scale = r.bmpScale.scale;
    }
  }
}

/** Delay after one event action: explicit Wait wins; an opacity fade keeps
 * running through its CSS transition and does not block the next action. */
export function bmpActionDelayMs(r: BmpRec): number {
  if (r.wait === undefined) return 0;
  return Math.max(0, Math.min(10_000, Math.round(r.wait * SCRIPT_FRAME_MS)));
}

/** Test-pinned transition duration for a SetBmpParam fade. */
export function bmpFadeMs(frames: number): number {
  if (!Number.isFinite(frames) || frames <= 0) return 0;
  return Math.min(10_000, Math.round(frames * SCRIPT_FRAME_MS));
}

// ---- DOM -----------------------------------------------------------------

let cursor: { script: string; event: number; stage: HTMLElement } | null = null;
let timers: number[] = [];
let ro: ResizeObserver | null = null;
let roStage: HTMLElement | null = null;

function stopTimers(): void {
  for (const t of timers) clearTimeout(t);
  timers = [];
}

function spaceFor(stage: HTMLElement): HTMLElement {
  let space = stage.querySelector(":scope > .stage-bmp-space") as
    HTMLElement | null;
  if (!space) {
    space = document.createElement("div");
    space.className = "stage-bmp-space";
    space.setAttribute("aria-hidden", "true");
    stage.appendChild(space);
  }
  // `zoom` scales geometry but does NOT create a stacking context or a
  // blend-isolation group, unlike `transform: scale()`. Per-layer z-index
  // and mix-blend-mode therefore act against the stage, matching the
  // engine's BmpContainer sibling of CharGroup.
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const s = w > 0 && h > 0 ? Math.min(w / 1280, h / 720) : 1;
  space.style.zoom = String(s);
  return space;
}

function imgFor(stage: HTMLElement, id: number): HTMLImageElement | null {
  return stage.querySelector(
    `:scope > .stage-bmp-space > img.stage-bmp[data-id="${id}"]`,
  ) as HTMLImageElement | null;
}

export interface BmpStylePlan {
  zIndex: string;
  mixBlendMode: string;
  objectFit: "fill" | "contain";
  /** Absent when a non-alpha action must leave the in-flight fade alone. */
  opacity?: string;
  transition?: string;
}

/** Pure style plan for one BMP layer. `updateAlpha:false` is what prevents
 * a following Wait/Move from resetting an in-flight CSS fade. */
export function bmpStylePlan(
  layer: BmpLayer,
  fadeMs = 0,
  updateAlpha = true,
): BmpStylePlan {
  const plan: BmpStylePlan = {
    zIndex: String(60 + Math.max(0, Math.min(20, layer.z || 0))),
    // Additive blend modes 3/4 (`bmp_add`/`add` shaders); `plus-lighter` is
    // the CSS additive blend. Mode 6 (mask) has no exact CSS equivalent.
    mixBlendMode: layer.mode === 3 || layer.mode === 4
      ? "plus-lighter"
      : "normal",
    objectFit: layer.w !== undefined && layer.h !== undefined ? "fill" : "contain",
  };
  if (updateAlpha) {
    plan.transition = fadeMs > 0 ? `opacity ${fadeMs}ms linear` : "none";
    plan.opacity = String(layer.alpha / 255);
  }
  return plan;
}

function styleLayer(
  img: HTMLImageElement,
  layer: BmpLayer,
  fadeMs = 0,
  updateAlpha = true,
): void {
  const plan = bmpStylePlan(layer, fadeMs, updateAlpha);
  img.style.zIndex = plan.zIndex;
  img.style.mixBlendMode = plan.mixBlendMode;
  img.style.objectFit = plan.objectFit;
  if (plan.transition !== undefined) img.style.transition = plan.transition;
  if (plan.opacity !== undefined) {
    // Flush the transition declaration before changing opacity; setting both
    // in one style recalculation can skip the animation.
    if (fadeMs > 0) void img.offsetWidth;
    img.style.opacity = plan.opacity;
  }
  if (layer.w !== undefined && layer.h !== undefined) {
    img.style.left = `${layer.x ?? 0}px`;
    img.style.top = `${layer.y ?? 0}px`;
    img.style.width = `${layer.w}px`;
    img.style.height = `${layer.h}px`;
    img.style.objectFit = "fill";
    img.style.transform = "none";
  } else if (layer.scale !== undefined || layer.x !== undefined) {
    img.style.left = `${layer.x ?? 0}px`;
    img.style.top = `${layer.y ?? 0}px`;
    img.style.width = "auto";
    img.style.height = "auto";
    img.style.objectFit = "contain";
    img.style.transform =
      `translate(-50%, -50%) scale(${layer.scale ?? 1})`;
  } else {
    // Full-frame layers live in the 1280x720 wrapper coordinate space.
    img.style.left = "0";
    img.style.top = "0";
    img.style.width = "1280px";
    img.style.height = "720px";
    img.style.objectFit = "contain";
    img.style.transform = "none";
  }
}

function syncStage(
  stage: HTMLElement,
  state: Map<number, BmpLayer>,
  chapter: string,
  fadeFor?: (id: number) => number,
  updateAlpha = true,
): void {
  const space = spaceFor(stage);
  const keep = new Set<number>();
  for (const layer of state.values()) {
    const url = imageUrl(layer.file, chapter);
    if (!url) continue;
    keep.add(layer.id);
    let img = imgFor(stage, layer.id);
    if (!img) {
      img = document.createElement("img");
      img.className = "stage-bmp";
      img.dataset.id = String(layer.id);
      img.alt = "";
      space.appendChild(img);
    }
    if (img.src !== url) img.src = url;
    styleLayer(img, layer, fadeFor?.(layer.id) ?? 0, updateAlpha);
  }
  for (const img of [...space.querySelectorAll<HTMLImageElement>(
    "img.stage-bmp",
  )]) {
    if (!keep.has(Number(img.dataset.id))) img.remove();
  }
}

function watchStage(stage: HTMLElement): void {
  if (roStage === stage) return;
  ro?.disconnect();
  roStage = stage;
  if (typeof ResizeObserver === "undefined") return;
  ro = new ResizeObserver(() => {
    const space = stage.querySelector(":scope > .stage-bmp-space") as
      HTMLElement | null;
    if (space) {
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      space.style.zoom = String(
        w > 0 && h > 0 ? Math.min(w / 1280, h / 720) : 1,
      );
    }
  });
  ro.observe(stage);
}

/** Render the BMP timeline for the current event. Re-renders of the same
 * event keep the live DOM (and do not restart fades); a new event/script
 * settles earlier records and replays the new event's short sequence. */
export function paintBmp(
  stage: HTMLElement,
  script: string,
  event: number,
  recs: BmpLookup,
  chapter: string,
  ranges?: readonly [number, number][],
): void {
  if (cursor?.stage === stage && cursor.script === script &&
    cursor.event === event) return;
  stopTimers();
  watchStage(stage);
  cursor = { script, event, stage };
  const base = resolveBmpBase(recs, event, ranges);
  syncStage(stage, base, chapter);
  const actions = bmpActionsAt(recs, event, ranges);
  if (actions.length === 0) return;

  let index = 0;
  const step = (): void => {
    while (index < actions.length) {
      const r = actions[index++]!;
      const fade = r.bmpAlpha ? bmpFadeMs(r.bmpAlpha.frames) : 0;
      applyBmpRecord(base, r);
      // Only load/alpha touch opacity; a wait/move must not reset the
      // in-flight CSS transition to `none` before it commits.
      const alpha = !!r.bmp || !!r.bmpAlpha;
      syncStage(stage, base, chapter, r.bmpAlpha ? () => fade : undefined,
        alpha);
      const delay = bmpActionDelayMs(r);
      if (delay > 0) {
        const t = window.setTimeout(() => {
          timers = timers.filter((x) => x !== t);
          if (cursor?.stage === stage) step();
        }, delay);
        timers.push(t);
        return;
      }
      // A fade continues in CSS; the next action is immediate unless a
      // Wait record follows. Do not block here.
    }
  };
  step();
}

/** Stop queued BMP animation without removing the visible layers (used when
 * the reader is paused behind an overlay). Clear the cursor so returning to
 * the same event replays its remaining sequence instead of freezing it at a
 * half-applied alpha. */
export function pauseBmp(): void {
  stopTimers();
  cursor = null;
}

/** Remove every BMP layer and reset the cursor (new game/load/screen). */
export function clearBmp(stage?: HTMLElement | null): void {
  stopTimers();
  cursor = null;
  ro?.disconnect();
  ro = null;
  roStage = null;
  stage?.querySelectorAll(":scope > .stage-bmp-space").forEach((el) => el.remove());
  stage?.querySelectorAll(":scope > img.stage-bmp").forEach((el) => el.remove());
}
