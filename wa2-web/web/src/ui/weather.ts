// Reader presentation: weather particles, screen shake, calendar stamps.
//
// The pure resolvers are DOM-free (unit-pinned); the DOM layer below owns at
// most one canvas per reader and one rAF loop. Everything here is driven by
// high-confidence .bnr presentation records only (docs/QA.md).

import "./effects.css";
import { isEventInExecutedRanges } from "../engine/cfg-vm";

const UNCHANGED = -1000;

/** Shake `frames` are engine frames at 60 Hz. The peer's
 * `AddShakeAnimation` builds `frame/2` two-segment tweens of `FrameTime`
 * (1/60 s), so the total is `frames * 1000/60` ms — a 30-frame shake is
 * 0.5 s, not 1 s. */
export const SCRIPT_FRAME_MS = 1000 / 60;
export const CALENDAR_HIDE_MS = 2500;

export type WeatherMode = 0 | 1 | 3 | 4 | 6;

export interface WeatherState {
  mode: WeatherMode;
  /** Engine pixel speeds per script tick (renderer scales them to the frame). */
  sx: number;
  sy: number;
  count: number;
  turb?: number;
  /** Engine layer hint (0/1/2). Decoded and tracked for diagnostics, but
   * the renderer currently paints one canvas above standing sprites; it
   * does not split front/back layers yet (documented cosmetic gap). */
  index?: number;
}

export interface WeatherRec {
  ev: number;
  weather?: {
    mode?: number;
    sx?: number;
    sy?: number;
    count?: number;
    turb?: number;
    index?: number;
  };
  weatherStop?: boolean;
  conf: string;
}

export interface CalendarRec {
  ev: number;
  cal?: { year: number; month: number; day: number; dow: number; mode?: number };
  conf: string;
}

export interface ShakeCue {
  type: number;
  strength: number;
  frames: number;
}

export interface ShakeRec {
  ev: number;
  shake?: ShakeCue;
  conf: string;
}

export interface CalendarStamp {
  year: number;
  month: number;
  day: number;
  dow: number;
  mode?: number;
  /** Statement anchor (for the "is this a new record?" cursor). */
  ev: number;
  /** Stable source index, so two records at one event can still be told apart. */
  seq: number;
}

export function isWeatherMode(mode: number): mode is WeatherMode {
  // Engine mapping (Wa2EngineMain.SetWeather switches on the low byte):
  // 0 = rain (legacy), 1 = sakura petals, 3 = snow, 4 = rain,
  // 6 = snow with turbulence (heavier). SetWeather carries visual flag bits
  // in 0x100/0x200/0x400/0x800 (corpus modes are 257/259/260), so callers
  // compare the byte, not the raw argument.
  return mode === 0 || mode === 1 || mode === 3 || mode === 4 || mode === 6;
}

/** SetWeather's first argument packs the mode in its low byte and visual
 * variant flags above it. Only the proven low-byte modes are rendered. */
export function normalizeWeatherMode(raw: number): WeatherMode | null {
  const mode = raw & 0xff;
  return isWeatherMode(mode) ? mode : null;
}

function inExecutedRanges(
  ranges: readonly [number, number][] | undefined,
  ev: number,
  current: number,
): boolean {
  // Same guard as the reader's visual timelines: the event being displayed is
  // live even when cfg replay ranges only cover earlier statements.
  const idx = Math.floor(ev);
  return idx === current || isEventInExecutedRanges(ranges, idx);
}

function mergedNumber(v: number | undefined, fallback: number): number {
  if (v === undefined || v === UNCHANGED || !Number.isFinite(v)) return fallback;
  return v;
}

function mergedOptional(v: number | undefined, fallback: number | undefined): number | undefined {
  if (v === undefined || v === UNCHANGED || !Number.isFinite(v)) return fallback;
  return v;
}

function clampSpeed(v: number): number {
  return Math.max(-1200, Math.min(1200, v));
}

function mergeWeather(
  prev: WeatherState | null,
  w: NonNullable<WeatherRec["weather"]>,
): WeatherState | null {
  const rawMode = w.mode === undefined || w.mode === UNCHANGED ? null : w.mode;
  const mode = rawMode === null ? null : normalizeWeatherMode(rawMode);
  // Unknown low byte: keep the previous system (confidence gate), never guess.
  if (rawMode !== null && mode === null) return prev;
  const prevMode: WeatherMode | null = prev ? prev.mode : null;
  if (prevMode === null && mode === null) return null;
  const next: WeatherState = {
    mode: mode ?? prevMode!,
    sx: mergedNumber(w.sx, prev ? prev.sx : 0),
    sy: mergedNumber(w.sy, prev ? prev.sy : 12),
    count: mergedNumber(w.count, prev ? prev.count : 120),
  };
  const turb = mergedOptional(w.turb, prev?.turb);
  if (turb !== undefined) next.turb = turb;
  const index = mergedOptional(w.index, prev?.index);
  if (index !== undefined) next.index = index;
  return next;
}

/** Latest weather state at/before `event` (ChangeWeather semantics).
 *
 * A full SetWeather record starts a system. ChangeWeather records may carry
 * only some fields; `-1000` (and an absent field) keeps the previous value,
 * exactly like the engine's ChangeWeather. A change with no active system is
 * a no-op, and ResetWeather (`weatherStop`) clears it. Unknown modes are
 * ignored rather than guessed. */
export function resolveWeather(
  recs: readonly WeatherRec[] | null | undefined,
  event: number,
  executedRanges?: readonly [number, number][],
): WeatherState | null {
  if (!recs?.length) return null;
  const ordered = recs
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.ev - b.r.ev || a.i - b.i);
  let state: WeatherState | null = null;
  for (const { r } of ordered) {
    if (r.conf !== "high" || r.ev > event) continue;
    if (!inExecutedRanges(executedRanges, r.ev, event)) continue;
    if (r.weatherStop) state = null;
    if (r.weather) state = mergeWeather(state, r.weather);
  }
  if (!state) return null;
  return {
    ...state,
    sx: clampSpeed(state.sx),
    sy: clampSpeed(state.sy),
    count: Math.max(0, Math.min(1200, Math.round(state.count))),
  };
}

/** Latest calendar stamp at/before the event. The reader only shows a stamp
 * when this record is *new* (forward step / skip), never on a re-render or a
 * loaded save, so the badge behaves like the transient engine popup. */
export function resolveCalendar(
  recs: readonly CalendarRec[] | null | undefined,
  event: number,
  executedRanges?: readonly [number, number][],
): CalendarStamp | null {
  if (!recs?.length) return null;
  let out: CalendarStamp | null = null;
  const ordered = recs
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.ev - b.r.ev || a.i - b.i);
  for (const { r, i } of ordered) {
    if (r.conf !== "high" || r.ev > event) continue;
    if (!inExecutedRanges(executedRanges, r.ev, event)) continue;
    if (!r.cal) continue;
    out = { ...r.cal, ev: r.ev, seq: i };
  }
  return out;
}

const WEEKDAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

/** "2012.11.14 · Wednesday". `dow` is the engine's 0..6 weekday index
 * (0 = Sunday, the C# DateTime.DayOfWeek order used by the PC build). */
export function formatCalendar(c: { year: number; month: number; day: number; dow: number }): string {
  const date = `${c.year}.${String(c.month).padStart(2, "0")}.${String(c.day).padStart(2, "0")}`;
  const weekday = Number.isInteger(c.dow) && c.dow >= 0 && c.dow < WEEKDAYS.length
    ? WEEKDAYS[c.dow]
    : "";
  return weekday ? `${date} · ${weekday}` : date;
}

/** Shake duration in ms: `frames * 1000/60` (engine 60 Hz frame).
 * Capped so a corrupt frame count cannot wedge the frame. */
export function shakeDurationMs(frames: number): number {
  if (!Number.isFinite(frames) || frames <= 0) return 0;
  return Math.min(10_000, Math.round(frames * SCRIPT_FRAME_MS));
}

/** Latest valid shake crossing `(from, to]`. Same-step re-renders pass
 * from === to and never replay; skipped directive events are crossed, so their
 * shake still fires once. Types other than 1 (horizontal) and 9 (2D) are
 * ignored (the decoder emits other handlers as hypothesis). */
export function resolveShakeCue(
  recs: readonly ShakeRec[] | null | undefined,
  from: number,
  to: number,
  executedRanges?: readonly [number, number][],
): (ShakeCue & { ev: number }) | null {
  if (!recs?.length || to <= from) return null;
  let out: (ShakeCue & { ev: number }) | null = null;
  const ordered = recs
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.ev - b.r.ev || a.i - b.i);
  for (const { r } of ordered) {
    if (r.conf !== "high" || !r.shake) continue;
    if (r.ev <= from || r.ev > to) continue;
    if (!inExecutedRanges(executedRanges, r.ev, to)) continue;
    if (r.shake.type !== 1 && r.shake.type !== 9) continue;
    out = { ...r.shake, ev: r.ev };
  }
  return out;
}

// ---- Weather canvas layer ------------------------------------------------

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  len: number;
  alpha: number;
  angle: number;
  spin: number;
  sway: number;
  swayAmp: number;
  phase: number;
}

class WeatherLayer {
  readonly reader: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private state: WeatherState | null = null;
  private particles: Particle[] = [];
  private w = 1280;
  private h = 720;
  private dpr = 1;
  private measured = false;
  private raf: number | null = null;
  private last = 0;
  private time = 0;
  private ro: ResizeObserver | null = null;
  private reduced = false;
  private readonly mq: MediaQueryList | null;
  live = false;

  private readonly onVisibility = () => {
    if (typeof document !== "undefined" && document.hidden) this.stop();
    else this.sync();
  };

  private readonly onResize = () => {
    if (this.measure()) {
      this.seed();
      this.draw();
    }
  };

  private readonly onMotion = () => {
    this.reduced = this.mq?.matches ?? false;
    if (this.reduced) {
      this.stop();
      // A lighter static field, not the full animated density.
      this.seed();
      this.draw();
    } else {
      // Turning reduced-motion off must restore the full count; `sync()`
      // alone kept the reduced cap of 120.
      this.seed();
      this.draw();
      this.sync();
    }
  };

  constructor(reader: HTMLElement) {
    this.reader = reader;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "weather-layer";
    this.canvas.hidden = true;
    this.canvas.setAttribute("aria-hidden", "true");
    // Exactly one weather layer per reader: a rebuilt skeleton must not leave
    // a stale canvas behind.
    reader.querySelectorAll(":scope > .weather-layer").forEach((el) => el.remove());
    reader.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.mq = typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
    this.reduced = this.mq?.matches ?? false;
    if (this.mq) {
      if (typeof this.mq.addEventListener === "function") {
        this.mq.addEventListener("change", this.onMotion);
      } else {
        // Safari < 14
        (this.mq as MediaQueryList & { addListener?: (fn: () => void) => void })
          .addListener?.(this.onMotion);
      }
    }
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(this.onResize);
      this.ro.observe(reader);
    }
    if (typeof window !== "undefined") window.addEventListener("resize", this.onResize);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibility);
    }
    this.measure();
  }

  private measure(): boolean {
    const rect = this.reader.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width || this.canvas.clientWidth || 1280));
    const h = Math.max(1, Math.round(rect.height || this.canvas.clientHeight || 720));
    const dpr = Math.min(2, Math.max(1, (typeof window !== "undefined" && window.devicePixelRatio) || 1));
    if (this.measured && w === this.w && h === this.h && dpr === this.dpr) return false;
    this.measured = true;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  private sameState(a: WeatherState | null, b: WeatherState | null): boolean {
    if (!a || !b) return a === b;
    // `index` is a layer/z-order hint, not a particle identity: the 121
    // index-only ChangeWeather statements must not reseed the field.
    return a.mode === b.mode && a.sx === b.sx && a.sy === b.sy &&
      a.count === b.count && a.turb === b.turb;
  }

  setState(next: WeatherState | null): void {
    if (this.sameState(this.state, next)) {
      this.sync();
      return;
    }
    this.state = next ? { ...next } : null;
    this.time = 0;
    if (!this.state) {
      this.particles = [];
      this.stop();
      this.canvas.hidden = true;
      this.clear();
      return;
    }
    this.canvas.hidden = false;
    this.measure();
    this.seed();
    this.draw();
    this.sync();
  }

  setLive(live: boolean): void {
    this.live = live;
    this.sync();
  }

  private sync(): void {
    if (!this.state) {
      this.stop();
      this.canvas.hidden = true;
      return;
    }
    this.canvas.hidden = false;
    if (this.state.count <= 0) {
      this.clear();
      this.stop();
      return;
    }
    if (!this.live || this.reduced || this.canvas.isConnected === false ||
      (typeof document !== "undefined" && document.hidden)) {
      this.stop();
      return;
    }
    if (this.raf === null) {
      this.last = 0;
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  private readonly frame = (now: number) => {
    this.raf = null;
    if (!this.state || !this.live || this.reduced ||
      (typeof document !== "undefined" && document.hidden) ||
      this.canvas.isConnected === false) {
      return;
    }
    const dt = this.last > 0 ? Math.min(0.1, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    this.step(dt);
    this.draw();
    this.raf = requestAnimationFrame(this.frame);
  };

  private stop(): void {
    if (this.raf !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.raf);
    }
    this.raf = null;
  }

  private clear(): void {
    this.ctx?.clearRect(0, 0, this.w, this.h);
  }

  private seed(): void {
    const cfg = this.state;
    this.particles = [];
    if (!cfg) return;
    const scale = this.h / 720;
    const baseVx = clampSpeed(cfg.sx) * 3 * scale;
    const baseVy = clampSpeed(cfg.sy) * 6 * scale;
    const isRain = cfg.mode === 4 || cfg.mode === 0;
    const cap = isRain ? 420 : cfg.mode === 1 ? 260 : 520;
    const maxCount = this.reduced ? Math.min(120, cap) : cap;
    const count = Math.min(maxCount, Math.max(0, Math.round(cfg.count)));
    const turb = Math.max(0, Math.min(100, cfg.turb ?? 0));
    for (let i = 0; i < count; i++) {
      const rand = Math.random;
      const snow = cfg.mode === 3 || cfg.mode === 6;
      const petal = cfg.mode === 1;
      const size = petal
        ? 2.4 + rand() * 3.2
        : snow
          ? (cfg.mode === 6 ? 1.6 : 1) + rand() * (cfg.mode === 6 ? 2.4 : 1.5)
          : 1;
      this.particles.push({
        x: rand() * this.w,
        y: rand() * this.h,
        vx: baseVx + (rand() - 0.5) * (isRain ? 18 : 10) * scale,
        vy: (baseVy === 0 ? 0 : baseVy) * (0.62 + rand() * 0.76),
        size,
        len: isRain ? 8 + rand() * 14 : 0,
        alpha: isRain ? 0.25 + rand() * 0.3 : 0.35 + rand() * 0.5,
        angle: rand() * Math.PI * 2,
        spin: (rand() - 0.5) * 2.6,
        sway: 0.5 + rand() * 1.6,
        swayAmp: petal
          ? 20 + rand() * 24
          : snow
            ? (cfg.mode === 6 ? 12 : 5) + rand() * 12 + turb * 0.25
            : 0,
        phase: rand() * Math.PI * 2,
      });
    }
  }

  private step(dt: number): void {
    const cfg = this.state;
    if (!cfg) return;
    this.time += dt;
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.swayAmp > 0) {
        p.x += Math.sin(this.time * p.sway + p.phase) * p.swayAmp * dt;
      }
      if (cfg.mode === 1) p.angle += p.spin * dt;
      // Wrap with a small margin so particles re-enter rather than pop at an
      // edge. Upward-moving systems (negative sy) wrap the other way too.
      if (p.y > this.h + 48) {
        p.y = -48;
        p.x = Math.random() * this.w;
      } else if (p.y < -48) {
        p.y = this.h + 48;
        p.x = Math.random() * this.w;
      }
      if (p.x > this.w + 48) p.x = -48;
      else if (p.x < -48) p.x = this.w + 48;
    }
  }

  private draw(): void {
    const ctx = this.ctx;
    const cfg = this.state;
    if (!ctx || !cfg) return;
    ctx.clearRect(0, 0, this.w, this.h);
    if (cfg.mode === 4 || cfg.mode === 0) {
      ctx.lineCap = "round";
      ctx.lineWidth = 1.1;
      for (const p of this.particles) {
        ctx.strokeStyle = `rgba(196, 232, 248, ${p.alpha})`;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.018, p.y - (p.len + Math.abs(p.vy) * 0.016));
        ctx.stroke();
      }
      return;
    }
    if (cfg.mode === 1) {
      for (const p of this.particles) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.fillStyle = `rgba(243, 182, 207, ${p.alpha})`;
        ctx.beginPath();
        ctx.ellipse(0, 0, p.size, p.size * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      return;
    }
    // Snow: light (3) is small/faint, heavy (6) is larger/brighter.
    for (const p of this.particles) {
      ctx.fillStyle = cfg.mode === 6
        ? `rgba(240, 252, 255, ${Math.min(0.9, p.alpha + 0.15)})`
        : `rgba(222, 246, 252, ${p.alpha * 0.85})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  dispose(): void {
    this.stop();
    this.ro?.disconnect();
    this.ro = null;
    if (typeof window !== "undefined") window.removeEventListener("resize", this.onResize);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
    if (this.mq) {
      if (typeof this.mq.removeEventListener === "function") {
        this.mq.removeEventListener("change", this.onMotion);
      } else {
        (this.mq as MediaQueryList & { removeListener?: (fn: () => void) => void })
          .removeListener?.(this.onMotion);
      }
    }
    this.canvas.remove();
  }
}

let activeWeather: WeatherLayer | null = null;
let weatherLive = false;

/** Mount/update the one weather layer for `reader`. A null state clears it
 * (weather stop, movie, or a script with no cue). Re-renders with the same
 * state do not recreate the canvas or restart the rAF loop. */
export function mountWeather(reader: HTMLElement, state: WeatherState | null): void {
  if (typeof document === "undefined") return;
  if (activeWeather && (activeWeather.reader !== reader || !activeWeather.canvas.isConnected)) {
    activeWeather.dispose();
    activeWeather = null;
  }
  if (!activeWeather) activeWeather = new WeatherLayer(reader);
  activeWeather.live = weatherLive;
  activeWeather.setState(state);
}

/** Reader live state (main.ts screen changes). Hiding the document pauses on
 * its own; this pauses when an overlay/title owns the screen. */
export function setWeatherLive(live: boolean): void {
  weatherLive = live;
  activeWeather?.setLive(live);
}

export function pauseWeather(): void {
  activeWeather?.setLive(false);
}

export function disposeWeather(): void {
  activeWeather?.dispose();
  activeWeather = null;
}

// ---- Calendar badge ------------------------------------------------------

let calendarTimer: number | null = null;

/** Show the date badge and restart its auto-hide timer. A new record resets
 * the animation + timer; re-renders never call this without a new record. */
export function showCalendar(reader: HTMLElement, stamp: CalendarStamp): void {
  if (typeof document === "undefined") return;
  let el = reader.querySelector(":scope > .calendar-stamp") as HTMLElement | null;
  if (!el) {
    el = document.createElement("div");
    el.className = "calendar-stamp";
    // Date changes are useful context, not decoration: expose the stamp as
    // a polite status instead of hiding it from assistive tech.
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    reader.appendChild(el);
  }
  el.textContent = formatCalendar(stamp);
  el.classList.remove("show");
  // Force a style flush so a second stamp fades in again instead of being a
  // no-op class toggle.
  void el.offsetWidth;
  el.classList.add("show");
  if (calendarTimer !== null) clearTimeout(calendarTimer);
  const shown = el;
  calendarTimer = window.setTimeout(() => {
    calendarTimer = null;
    shown.classList.remove("show");
  }, CALENDAR_HIDE_MS);
}

export function hideCalendar(reader?: HTMLElement | null): void {
  if (calendarTimer !== null) {
    clearTimeout(calendarTimer);
    calendarTimer = null;
  }
  reader?.querySelector(":scope > .calendar-stamp")?.classList.remove("show");
}

// ---- Screen shake --------------------------------------------------------

let shakeCleanup: (() => void) | null = null;
let shakeTimer: number | null = null;

/** Apply a type 1 (horizontal) / 9 (2D) shake to the stage. The animation
 * drives the CSS `translate` property, never `transform`, so a camera/zoom
 * transform on the same element still composes. Duration is
 * `frames * 1000/60 ms` (engine 60 Hz frame). The dialogue box is a sibling
 * and never shakes. */
export function applyShake(reader: HTMLElement, cue: ShakeCue): void {
  if (typeof document === "undefined") return;
  if (cue.type !== 1 && cue.type !== 9) return;
  const stage = reader.querySelector(".stage") as HTMLElement | null;
  if (!stage) return;
  const ms = shakeDurationMs(cue.frames);
  if (ms <= 0) return;
  shakeCleanup?.();
  const amplitude = Math.max(1, Math.min(48, Math.abs(Math.round(cue.strength)) || 1));
  const cls = cue.type === 1 ? "stage-shake-x" : "stage-shake-2d";
  stage.style.setProperty("--shake-amp", `${amplitude}px`);
  stage.style.setProperty("--shake-ms", `${ms}ms`);
  stage.classList.remove("stage-shake-x", "stage-shake-2d");
  void stage.offsetWidth;
  stage.classList.add(cls);
  let done = false;
  const onEnd = (e: AnimationEvent) => {
    if (e.target === stage) cleanup();
  };
  const cleanup = () => {
    if (done) return;
    done = true;
    stage.classList.remove("stage-shake-x", "stage-shake-2d");
    stage.style.removeProperty("--shake-amp");
    stage.style.removeProperty("--shake-ms");
    stage.removeEventListener("animationend", onEnd);
    if (shakeTimer !== null) {
      clearTimeout(shakeTimer);
      shakeTimer = null;
    }
    if (shakeCleanup === cleanup) shakeCleanup = null;
  };
  stage.addEventListener("animationend", onEnd);
  shakeTimer = window.setTimeout(cleanup, ms + 80);
  shakeCleanup = cleanup;
}

export function clearShake(): void {
  shakeCleanup?.();
}
