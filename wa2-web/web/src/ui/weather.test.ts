import { describe, expect, it } from "vitest";
import {
  CALENDAR_HIDE_MS,
  SCRIPT_FRAME_MS,
  formatCalendar,
  resolveCalendar,
  resolveShakeCue,
  resolveWeather,
  shakeDurationMs,
  type CalendarRec,
  type ShakeRec,
  type WeatherRec,
} from "./weather";

describe("weather timeline (bnr SetWeather/ChangeWeather/ResetWeather)", () => {
  const recs: WeatherRec[] = [
    { ev: 2, weather: { mode: 3, sx: 20, sy: 40, count: 300 }, conf: "high" },
    // ChangeWeather shape: absent/-1000 fields keep the previous value.
    { ev: 4, weather: { sx: -1000, sy: -1000, count: 500 }, conf: "high" },
    { ev: 6, weather: { mode: 6, sx: -1000, sy: 60, count: -1000 }, conf: "high" },
    { ev: 8, weatherStop: true, conf: "high" },
    { ev: 9, weather: { mode: 1, sx: 1, sy: 2, count: 3 }, conf: "hypothesis" },
    { ev: 10, weather: { mode: 4, sx: 100, sy: 200, count: 1200 }, conf: "high" },
  ];

  it("starts nothing before the first SetWeather", () => {
    expect(resolveWeather(recs, 0)).toBeNull();
    expect(resolveWeather(recs, 1)).toBeNull();
    expect(resolveWeather([], 10)).toBeNull();
    expect(resolveWeather(null, 10)).toBeNull();
  });

  it("uses the latest record at/before the event and merges ChangeWeather", () => {
    expect(resolveWeather(recs, 2)).toEqual({ mode: 3, sx: 20, sy: 40, count: 300 });
    // count changed, mode/speeds survive the -1000 sentinels
    expect(resolveWeather(recs, 4)).toEqual({ mode: 3, sx: 20, sy: 40, count: 500 });
    expect(resolveWeather(recs, 5)).toEqual({ mode: 3, sx: 20, sy: 40, count: 500 });
    // mode switches; sy changes, count keeps the previous 500
    expect(resolveWeather(recs, 6)).toEqual({ mode: 6, sx: 20, sy: 60, count: 500 });
  });

  it("weatherStop clears; a later SetWeather can start again", () => {
    expect(resolveWeather(recs, 8)).toBeNull();
    // hypothesis-confidence mode change never drives playback
    expect(resolveWeather(recs, 9)).toBeNull();
    expect(resolveWeather(recs, 10)).toEqual({ mode: 4, sx: 100, sy: 200, count: 1200 });
  });

  it("treats a ChangeWeather with no active system as a no-op", () => {
    const recs2: WeatherRec[] = [
      { ev: 1, weather: { sx: 10, count: 50 }, conf: "high" },
    ];
    expect(resolveWeather(recs2, 5)).toBeNull();
  });

  it("ignores unknown modes and clamps absurd counts", () => {
    const recs2: WeatherRec[] = [
      { ev: 1, weather: { mode: 3, sx: 0, sy: 0, count: 99_999 }, conf: "high" },
      { ev: 2, weather: { mode: 7, sx: 1, sy: 1, count: 1 }, conf: "high" },
    ];
    expect(resolveWeather(recs2, 2)).toEqual({ mode: 3, sx: 0, sy: 0, count: 1200 });
  });

  it("honours cfg replay ranges, with the current event always live", () => {
    const recs2: WeatherRec[] = [
      { ev: 5, weather: { mode: 3, sx: 0, sy: 1, count: 10 }, conf: "high" },
    ];
    expect(resolveWeather(recs2, 10, [[0, 4]])).toBeNull();
    expect(resolveWeather(recs2, 10, [[0, 6]])).not.toBeNull();
    expect(resolveWeather(recs2, 5, [])).not.toBeNull();
  });

  it("normalizes SetWeather flag bits to the low-byte mode", () => {
    const recs2: WeatherRec[] = [
      { ev: 1, weather: { mode: 257, sx: 10, sy: 10, count: 32 }, conf: "high" },
      { ev: 2, weather: { mode: 259, sx: 10, sy: 10, count: 64 }, conf: "high" },
      { ev: 3, weather: { mode: 260, sx: 10, sy: 10, count: 128 }, conf: "high" },
      { ev: 4, weather: { mode: 0, sx: 10, sy: 10, count: 128 }, conf: "high" },
      { ev: 5, weather: { mode: 258, sx: 99, sy: 99, count: 99 }, conf: "high" },
    ];
    expect(resolveWeather(recs2, 1)?.mode).toBe(1); // sakura
    expect(resolveWeather(recs2, 2)?.mode).toBe(3); // snow
    expect(resolveWeather(recs2, 3)?.mode).toBe(4); // rain
    expect(resolveWeather(recs2, 4)?.mode).toBe(0); // legacy rain
    // unknown low byte 2 is ignored; the previous state survives untouched
    expect(resolveWeather(recs2, 5)).toEqual({ mode: 0, sx: 10, sy: 10, count: 128 });
  });

  it("applies out-of-order records in event order, not list order", () => {
    const recs2: WeatherRec[] = [
      { ev: 5, weather: { mode: 6, sx: 0, sy: 1, count: 10 }, conf: "high" },
      { ev: 2, weather: { mode: 3, sx: 0, sy: 1, count: 10 }, conf: "high" },
    ];
    expect(resolveWeather(recs2, 6)?.mode).toBe(6);
  });
});

describe("calendar stamp", () => {
  const recs: CalendarRec[] = [
    { ev: 3, cal: { year: 2012, month: 11, day: 14, dow: 3 }, conf: "high" },
    { ev: 7, cal: { year: 2013, month: 2, day: 9, dow: 6 }, conf: "high" },
    { ev: 9, cal: { year: 2014, month: 1, day: 1, dow: 0 }, conf: "hypothesis" },
  ];

  it("takes the latest high-confidence stamp at/before the event", () => {
    expect(resolveCalendar(recs, 2)).toBeNull();
    expect(resolveCalendar(recs, 3)).toEqual({
      year: 2012, month: 11, day: 14, dow: 3, ev: 3, seq: 0,
    });
    expect(resolveCalendar(recs, 8)).toEqual({
      year: 2013, month: 2, day: 9, dow: 6, ev: 7, seq: 1,
    });
    // hypothesis record is ignored, so the older stamp stays current
    expect(resolveCalendar(recs, 9)?.year).toBe(2013);
  });

  it("formats year/month/day + weekday (0 = Sunday)", () => {
    expect(formatCalendar({ year: 2012, month: 11, day: 14, dow: 3 }))
      .toBe("2012.11.14 · Wednesday");
    expect(formatCalendar({ year: 2013, month: 2, day: 9, dow: 6 }))
      .toBe("2013.02.09 · Saturday");
    expect(formatCalendar({ year: 2014, month: 1, day: 1, dow: 0 }))
      .toBe("2014.01.01 · Sunday");
    // out-of-band weekday degrades to the date only
    expect(formatCalendar({ year: 2014, month: 1, day: 1, dow: 9 }))
      .toBe("2014.01.01");
  });

  it("keeps the auto-hide delay at ~2.5 s", () => {
    expect(CALENDAR_HIDE_MS).toBe(2500);
  });
});

describe("screen shake", () => {
  const recs: ShakeRec[] = [
    { ev: 3, shake: { type: 1, strength: 4, frames: 10 }, conf: "high" },
    { ev: 5, shake: { type: 2, strength: 8, frames: 20 }, conf: "high" },
    { ev: 7, shake: { type: 9, strength: 6, frames: 12 }, conf: "high" },
    { ev: 9, shake: { type: 9, strength: 9, frames: 30 }, conf: "hypothesis" },
  ];

  it("converts frames at 30 fps (33 ms) and caps absurd durations", () => {
    expect(SCRIPT_FRAME_MS).toBeCloseTo(1000 / 60, 5);
    expect(shakeDurationMs(0)).toBe(0);
    expect(shakeDurationMs(-4)).toBe(0);
    expect(shakeDurationMs(Number.NaN)).toBe(0);
    expect(shakeDurationMs(12)).toBe(200);
    expect(shakeDurationMs(30)).toBe(500);
    expect(shakeDurationMs(10_000)).toBe(10_000);
  });

  it("fires only crossed records in (from, to], never on a same-step re-render", () => {
    expect(resolveShakeCue(recs, 2, 3)).toEqual({ type: 1, strength: 4, frames: 10, ev: 3 });
    expect(resolveShakeCue(recs, 3, 3)).toBeNull();
    expect(resolveShakeCue(recs, 3, 4)).toBeNull();
    // type 2 is not a valid shake; the last valid crossing (type 9 at 7) wins
    expect(resolveShakeCue(recs, 3, 7)).toEqual({ type: 9, strength: 6, frames: 12, ev: 7 });
    // hypothesis record is ignored
    expect(resolveShakeCue(recs, 7, 10)).toBeNull();
  });

  it("honours cfg replay ranges", () => {
    expect(resolveShakeCue(recs, 2, 6, [[0, 4]])?.ev).toBe(3);
    expect(resolveShakeCue(recs, 2, 6, [[0, 6]])?.ev).toBe(3);
    // only the invalid type 2 at 5 lies in this range
    expect(resolveShakeCue(recs, 2, 6, [[4, 8]])).toBeNull();
    // current event is live even outside the ranges
    expect(resolveShakeCue(recs, 6, 7, [])?.ev).toBe(7);
  });
});
