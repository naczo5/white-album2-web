import { describe, expect, it } from "vitest";
import { newWheelState, normalizeWheelDelta, wheelGesture, DELTA_LINE, DELTA_PAGE, DELTA_PIXEL, LINE_PX, PAGE_PX, WHEEL_NOTCH, WHEEL_AFTER_MS } from "./wheel";

describe("trackpad-safe wheel accumulator", () => {
  it("needs a full notch of upward travel, not a single small delta", () => {
    const s = newWheelState();
    expect(wheelGesture(s, -10, 1000)).toBe(false);
    expect(wheelGesture(s, -10, 1100)).toBe(false);
    expect(wheelGesture(s, -30, 1200)).toBe(true);
  });

  it("fires once per gesture: the inertia tail cannot re-trigger", () => {
    const s = newWheelState();
    expect(wheelGesture(s, -WHEEL_NOTCH, 1000)).toBe(true);
    // Momentum tail: small upward deltas right after the hit.
    expect(wheelGesture(s, -120, 1050)).toBe(false);
    expect(wheelGesture(s, -200, 1080)).toBe(false);
    expect(wheelGesture(s, -400, 1100)).toBe(false);
  });

  it("a fresh gesture after the cooldown can fire again", () => {
    const s = newWheelState();
    expect(wheelGesture(s, -WHEEL_NOTCH, 1000)).toBe(true);
    expect(wheelGesture(s, -WHEEL_NOTCH, 1000 + WHEEL_AFTER_MS + 1)).toBe(true);
  });

  it("downward travel cancels an upward build-up", () => {
    const s = newWheelState();
    expect(wheelGesture(s, -40, 1000)).toBe(false);
    expect(wheelGesture(s, 40, 1050)).toBe(false);
    expect(wheelGesture(s, -40, 1100)).toBe(false);
  });

  it("a long pause discards leftover travel", () => {
    const s = newWheelState();
    expect(wheelGesture(s, -45, 1000)).toBe(false);
    // 500 ms later the leftover 45 px must not count toward the next notch.
    expect(wheelGesture(s, -45, 1500)).toBe(false);
  });

  it("ignores junk deltas", () => {
    const s = newWheelState();
    expect(wheelGesture(s, 0, 1000)).toBe(false);
    expect(wheelGesture(s, Number.NaN, 1000)).toBe(false);
    expect(wheelGesture(s, Number.POSITIVE_INFINITY, 1000)).toBe(false);
  });

  it("a mouse notch (one 100 px event) fires immediately", () => {
    const s = newWheelState();
    expect(wheelGesture(s, -100, 1000)).toBe(true);
  });
});

describe("wheel deltaMode normalisation (P2-4)", () => {
  it("passes pixel deltas through untouched", () => {
    expect(normalizeWheelDelta(-100, DELTA_PIXEL)).toBe(-100);
    expect(normalizeWheelDelta(37, DELTA_PIXEL)).toBe(37);
  });

  it("scales line deltas to pixels (Firefox mouse notch = 3 lines)", () => {
    expect(LINE_PX).toBe(24);
    expect(normalizeWheelDelta(-3, DELTA_LINE)).toBe(-72);
    expect(normalizeWheelDelta(-1, DELTA_LINE)).toBe(-24);
  });

  it("scales page deltas to a whole frame of travel", () => {
    expect(PAGE_PX).toBe(400);
    expect(normalizeWheelDelta(-1, DELTA_PAGE)).toBe(-400);
  });

  it("a line-mode notch reaches the gesture threshold", () => {
    const s = newWheelState();
    // Raw -3 would never reach -50: normalising first is the whole fix.
    expect(wheelGesture(s, -3, 1000)).toBe(false);
    const s2 = newWheelState();
    expect(wheelGesture(s2, normalizeWheelDelta(-3, DELTA_LINE), 1000)).toBe(true);
  });

  it("page mode fires once, and its inertia tail cannot re-trigger", () => {
    const s = newWheelState();
    expect(wheelGesture(s, normalizeWheelDelta(-1, DELTA_PAGE), 1000)).toBe(true);
    expect(wheelGesture(s, normalizeWheelDelta(-1, DELTA_PAGE), 1050)).toBe(false);
  });

  it("junk deltas normalise to zero rather than NaN", () => {
    expect(normalizeWheelDelta(Number.NaN, DELTA_LINE)).toBe(0);
    expect(normalizeWheelDelta(Number.POSITIVE_INFINITY, DELTA_PAGE)).toBe(0);
    expect(normalizeWheelDelta(-2, 99)).toBe(-2); // unknown mode: pixels
  });

  it("the notch constant is unchanged by normalisation support", () => {
    expect(WHEEL_NOTCH).toBe(50);
  });
});
