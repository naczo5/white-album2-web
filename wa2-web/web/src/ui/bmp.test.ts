import { describe, expect, it } from "vitest";
import {
  applyBmpRecord,
  bmpActionDelayMs,
  bmpActionsAt,
  bmpFadeMs,
  bmpStylePlan,
  resolveBmpBase,
  SCRIPT_FRAME_MS,
  type BmpLayer,
  type BmpRec,
} from "./bmp";

function rec(partial: Partial<BmpRec> & { ev: number }): BmpRec {
  return { conf: "high", ...partial } as BmpRec;
}

describe("BMP overlay timeline", () => {
  const recs = [
    rec({ ev: 1, bmp: { id: 0, file: "a.tga", z: 14 } }),
    rec({ ev: 1, bmpAlpha: { id: 0, alpha: 0, frames: 0 } }),
    rec({ ev: 2, bmpAlpha: { id: 0, alpha: 128, frames: 60 } }),
    rec({ ev: 2, wait: 120 }),
    rec({ ev: 2, bmpAlpha: { id: 0, alpha: 0, frames: 60 } }),
    rec({ ev: 2, wait: 60 }),
    rec({ ev: 2, bmpRelease: 0 }),
    rec({ ev: 0, bmp: { id: 1, file: "b.tga", z: 3 } }),
    rec({ ev: 3, bmpMove: { id: 1, x: 641, y: 361 } }),
    rec({ ev: 3, bmpScale: { id: 1, x: 640, y: 360, scale: 2 } }),
    rec({ ev: 3, bmpRect: { id: 1, x: 10, y: 20, w: 300, h: 200 } }),
    rec({ ev: 4, bmpRelease: 1 }),
    rec({ ev: 3, bmp: { id: 2, file: "c.tga", z: 99 }, conf: "hypothesis" }),
  ];

  it("settles earlier events and keeps source order at the current event", () => {
    const base = resolveBmpBase(recs, 2);
    expect([...base.keys()]).toEqual([0, 1]);
    expect(base.get(0)?.alpha).toBe(0);
    expect(base.get(1)?.z).toBe(3);
    const actions = bmpActionsAt(recs, 2);
    expect(actions.map((r) => r.bmpAlpha ? `a${r.bmpAlpha.alpha}` :
      r.wait !== undefined ? `w${r.wait}` : `r${r.bmpRelease}`))
      .toEqual(["a128", "w120", "a0", "w60", "r0"]);
  });

  it("applies load/alpha/move/rect/scale and release", () => {
    const state = new Map<number, BmpLayer>();
    for (const r of recs.filter((x) => x.ev <= 3 && x.conf === "high")) {
      applyBmpRecord(state, r);
    }
    expect(state.has(0)).toBe(false);
    const one = state.get(1)!;
    expect(one).toMatchObject({ x: 10, y: 20, w: 300, h: 200, z: 3 });
    // id 2 only exists as a hypothesis row.
    expect(state.has(2)).toBe(false);
  });

  it("ignores hypothesis records and non-BMP rows", () => {
    expect(bmpActionsAt([...recs, rec({ ev: 3, wait: 30, conf: "hypothesis" })], 3)
      .some((r) => r.wait === 30)).toBe(false);
    expect(bmpActionsAt([rec({ ev: 1, cal: { year: 2010, month: 1, day: 1, dow: 0 } })], 1))
      .toEqual([]);
  });

  it("plans a sticky fade: non-alpha actions leave transition/opacity alone", () => {
    const layer: BmpLayer = {
      id: 0, file: "a.tga", z: 14, alpha: 128, mode: 3,
    };
    const fade = bmpStylePlan(layer, 1000, true);
    expect(fade.zIndex).toBe("74");
    expect(fade.mixBlendMode).toBe("plus-lighter");
    expect(fade.transition).toBe("opacity 1000ms linear");
    expect(Number(fade.opacity)).toBeCloseTo(128 / 255, 5);
    // A following Wait/Move must not reset the live transition.
    const hold = bmpStylePlan(layer, 0, false);
    expect(hold.transition).toBeUndefined();
    expect(hold.opacity).toBeUndefined();
    expect(hold.mixBlendMode).toBe("plus-lighter");
    // A rect layer fills its box; the default is contain.
    expect(bmpStylePlan({ ...layer, w: 10, h: 20 }).objectFit).toBe("fill");
    expect(bmpStylePlan(layer).objectFit).toBe("contain");
  });

  it("converts engine frames at 60 Hz and bounds waits", () => {
    expect(SCRIPT_FRAME_MS).toBeCloseTo(1000 / 60, 5);
    expect(bmpFadeMs(0)).toBe(0);
    expect(bmpFadeMs(-1)).toBe(0);
    expect(bmpFadeMs(60)).toBe(1000);
    expect(bmpFadeMs(10_000)).toBe(10_000);
    expect(bmpActionDelayMs(rec({ ev: 1, wait: 60 }))).toBe(1000);
    expect(bmpActionDelayMs(rec({ ev: 1, wait: 99_999 }))).toBe(10_000);
    expect(bmpActionDelayMs(rec({ ev: 1 }))).toBe(0);
  });
});
