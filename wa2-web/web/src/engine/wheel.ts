// Trackpad-safe wheel accumulator: pure, DOM-free, test-pinned.
//
// A mouse wheel reports one event per notch (~±100 px), while a trackpad
// streams dozens of small deltas with decaying inertia. The reader uses
// wheel-up to open the backlog, so it must fire once per deliberate
// gesture — not once per delta, and not from the inertia tail of the
// previous gesture.
//
//  - NOTCH 50 px of upward travel counts as one notch
//  - AFTER 400 ms of quiet ends a gesture: leftover travel is discarded,
//    and a fresh gesture needs a new notch

export const WHEEL_NOTCH = 50;
export const WHEEL_AFTER_MS = 400;

/** `WheelEvent.deltaMode` values (kept as numbers: DOM-free module). */
export const DELTA_PIXEL = 0;
export const DELTA_LINE = 1;
export const DELTA_PAGE = 2;

/** Lines are ~24 px; a page-scroll wheel press is treated as a whole
 * frame of travel (~400 px). Firefox reports LINE mode for a plain mouse. */
export const LINE_PX = 24;
export const PAGE_PX = 400;

/** Convert a raw wheel delta to pixels using its `deltaMode`. */
export function normalizeWheelDelta(deltaY: number, deltaMode: number): number {
  if (!Number.isFinite(deltaY)) return 0;
  if (deltaMode === DELTA_LINE) return deltaY * LINE_PX;
  if (deltaMode === DELTA_PAGE) return deltaY * PAGE_PX;
  return deltaY;
}

export interface WheelState {
  /** Accumulated upward travel (negative) inside the current gesture. */
  acc: number;
  /** Timestamp of the previous delta. */
  lastAt: number;
  /** Timestamp of the last fired action (gesture cooldown). */
  firedAt: number;
}

export function newWheelState(): WheelState {
  return { acc: 0, lastAt: 0, firedAt: 0 };
}

export type WheelDirection = "up" | "down";

/**
 * Feed one wheel delta; returns `"up"` or `"down"` when the accumulated travel
 * reaches a deliberate notch, or `null` otherwise. Mutates `state` in place.
 * Reversing direction discards leftover opposite travel; firing starts the
 * cooldown in both directions so trackpad bounce cannot trigger immediately.
 */
export function wheelDirectionGesture(state: WheelState, deltaY: number, now: number): WheelDirection | null {
  if (!Number.isFinite(deltaY) || deltaY === 0) return null;
  // A pause longer than a burst resets the accumulator: the trackpad's
  // momentum tail must not carry over into the next deliberate flick.
  if (now - state.lastAt > WHEEL_AFTER_MS) state.acc = 0;
  state.lastAt = now;
  // Flipping direction cancels any partial build-up from the opposite direction.
  if ((deltaY > 0 && state.acc < 0) || (deltaY < 0 && state.acc > 0)) {
    state.acc = 0;
  }
  if (now - state.firedAt < WHEEL_AFTER_MS) {
    state.acc = 0;
    return null;
  }
  state.acc += deltaY;
  if (state.acc <= -WHEEL_NOTCH) {
    state.acc = 0;
    state.firedAt = now;
    return "up";
  }
  if (state.acc >= WHEEL_NOTCH) {
    state.acc = 0;
    state.firedAt = now;
    return "down";
  }
  return null;
}

/**
 * Feed one wheel delta; returns true when the caller should act on an upward
 * notch (open the backlog). Mutates `state` in place.
 */
export function wheelGesture(state: WheelState, deltaY: number, now: number): boolean {
  return wheelDirectionGesture(state, deltaY, now) === "up";
}
