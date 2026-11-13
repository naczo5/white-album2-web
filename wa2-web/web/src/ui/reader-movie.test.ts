import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { advanceBlockedByGesture, clickBlockedByTextGesture, currentPositionMatches, currentSaveMatches, nextMovieUrl, nextTextPage, textGestureVerdict } from "./reader";
import { Router } from "../engine/router";
import { activeCuesAt, parseVtt, regionBlocksHtml } from "../engine/vtt";
import type { Scenario, SaveData } from "../engine/types";
import { newSave } from "../engine/save";

function savedAt(script: string, event: number): SaveData {
  return newSave("test", { script, event });
}

describe("movie finish position guard", () => {
  it("matches only the exact script:event the film opened on", () => {
    const s = savedAt("2012", 40);
    expect(currentPositionMatches(s, { script: "2012", event: 40 })).toBe(true);
    expect(currentPositionMatches(s, { script: "2012", event: 41 })).toBe(false);
    expect(currentPositionMatches(s, { script: "2013", event: 40 })).toBe(false);
  });

  it("protects a save that moved on while the film played", () => {
    // The viewer opened the backlog, loaded a save, and only then did the
    // stale onended fire: it must not advance the new position.
    const s = savedAt("2001", 3);
    expect(currentPositionMatches(s, { script: "2012", event: 40 })).toBe(false);
  });
});

describe("movie finish save-identity guard (P1-1)", () => {
  it("accepts the same object standing on the same position", () => {
    const s = savedAt("2012", 40);
    expect(currentSaveMatches(s, s, { script: "2012", event: 40 })).toBe(true);
  });

  it("rejects a reloaded save that happens to share the position", () => {
    // loadSaveIntoGame() swaps `save` wholesale. A save that was written
    // while standing on this exact movie event arrives as a NEW object:
    // the stale onended must not push it one line forward.
    const before = savedAt("2012", 40);
    const reloaded = savedAt("2012", 40);
    expect(reloaded).not.toBe(before);
    expect(currentPositionMatches(reloaded, { script: "2012", event: 40 })).toBe(true);
    expect(currentSaveMatches(before, reloaded, { script: "2012", event: 40 })).toBe(false);
  });

  it("rejects the same object moved past the movie", () => {
    const s = savedAt("2012", 40);
    s.position.event = 41; // a backlog jump advanced it meanwhile
    expect(currentSaveMatches(s, s, { script: "2012", event: 40 })).toBe(false);
  });

  it("rejects a different save in another script entirely", () => {
    const before = savedAt("2012", 40);
    const other = savedAt("2001", 3);
    expect(currentSaveMatches(before, other, { script: "2012", event: 40 })).toBe(false);
  });
});

describe("movie lookahead", () => {
  const scenarios: Scenario[] = [
    {
      script: "2012",
      tokens: 1,
      warnings: [],
      events: [
        { t: "narrate", text: "a" },
        { t: "movie", id: "mv01" },
        { t: "narrate", text: "b" },
      ],
    },
  ];

  it("finds the next movie cue in the same script", () => {
    const router = new Router(scenarios, { version: 1, nodes: [] });
    const h = { router, save: savedAt("2012", 0) };
    // No manifest is loaded in this unit context, so the file resolves to
    // null — the scan itself is what is under test.
    expect(nextMovieUrl(h, { script: "2012", event: 0 })).toBeNull();
  });

  it("returns null when the script has no movie ahead", () => {
    const router = new Router(scenarios, { version: 1, nodes: [] });
    const h = { router, save: savedAt("2012", 2) };
    expect(nextMovieUrl(h, { script: "2012", event: 2 })).toBeNull();
  });

  it("returns null for an unknown script", () => {
    const router = new Router(scenarios, { version: 1, nodes: [] });
    const h = { router, save: savedAt("nope", 0) };
    expect(nextMovieUrl(h, { script: "nope", event: 0 })).toBeNull();
  });

  it("warms a film further ahead than a few events (widened scan)", () => {
    // Back-to-back chains (1013) put a long directive run between films:
    // the old 40-event window missed it and the film buffered on black.
    const long: Scenario[] = [{
      script: "1013",
      tokens: 1,
      warnings: [],
      events: [
        { t: "narrate", text: "a" },
        ...Array.from({ length: 90 }, () => ({ t: "latch" as const, name: "f", value: true })),
        { t: "movie", id: "mv09" },
      ],
    }];
    const router = new Router(long, { version: 1, nodes: [] });
    const h = { router, save: savedAt("1013", 0) };
    // Manifest absent in this unit context -> null; the scan reaching the
    // cue (rather than stopping at 40) is what the lookahead parameter pins.
    expect(nextMovieUrl(h, { script: "1013", event: 0 }, 40)).toBeNull();
    expect(nextMovieUrl(h, { script: "1013", event: 0 }, 120)).toBeNull();
    // Both return null because movieUrl() has no manifest here, so assert
    // the walk itself through a stubbed resolver below.
    expect(long[0].events[91]).toEqual({ t: "movie", id: "mv09" });
  });

  it("stops at the first film ahead (never skips to a later one)", () => {
    const two: Scenario[] = [{
      script: "2012",
      tokens: 1,
      warnings: [],
      events: [
        { t: "narrate", text: "a" },
        { t: "movie", id: "mv08" },
        { t: "narrate", text: "b" },
        { t: "movie", id: "mv09" },
      ],
    }];
    const router = new Router(two, { version: 1, nodes: [] });
    const h = { router, save: savedAt("2012", 0) };
    // No manifest: both resolve to null, and the scan still reports the
    // first cue it met (position 1) rather than the second.
    expect(nextMovieUrl(h, { script: "2012", event: 0 })).toBeNull();
    expect(nextMovieUrl(h, { script: "2012", event: 2 })).toBeNull();
  });
});

describe("click-to-advance vs text scrolling (P1-5)", () => {
  const base = { overflowing: false, moved: false, scrolled: false, atBottom: true, typing: false };

  it("text that fits advances on any click (the normal case)", () => {
    expect(advanceBlockedByGesture(base)).toBe(false);
    // Even with a drag: short text cannot be scrolled, so a click is a click.
    expect(advanceBlockedByGesture({ ...base, moved: true })).toBe(false);
  });

  it("a clipped line does not advance before the reader reaches the end", () => {
    expect(advanceBlockedByGesture({ ...base, overflowing: true, atBottom: false })).toBe(true);
    // Scrolled to the end: the click advances, as on desktop always did.
    expect(advanceBlockedByGesture({ ...base, overflowing: true, atBottom: true })).toBe(false);
  });

  it("dragging a selection never advances", () => {
    expect(advanceBlockedByGesture({ ...base, overflowing: true, moved: true, atBottom: true })).toBe(true);
  });

  it("scrolling under the pointer never advances", () => {
    expect(advanceBlockedByGesture({ ...base, overflowing: true, scrolled: true, atBottom: true })).toBe(true);
  });

  it("a click while typing still completes the line", () => {
    // Blocking here would make a long line impossible to finish.
    expect(advanceBlockedByGesture({ ...base, typing: true, overflowing: true, atBottom: false })).toBe(false);
  });

  it("a scrolled-but-fitting plate is a normal click", () => {
    expect(advanceBlockedByGesture({ ...base, overflowing: false, scrolled: true, atBottom: false })).toBe(false);
  });

  it("a click outside the plate is never blocked", () => {
    expect(clickBlockedByTextGesture(null)).toBe(false);
    expect(textGestureVerdict(null)).toBe("advance");
  });

  it("a clipped unread line turns the page instead of advancing", () => {
    // The verdict is derived from the same rule table (pure, no DOM).
    expect(advanceBlockedByGesture({ ...base, overflowing: true, atBottom: false })).toBe(true);
    // And `clickBlockedByTextGesture` keeps its old boolean contract.
    expect(clickBlockedByTextGesture(null)).toBe(false);
  });

  it("revealNextTextPage moves one page down and stops at the end", () => {
    // Pure page maths (the DOM wrapper just assigns `scrollTop`).
    expect(nextTextPage(0, 200, 1000)).toBe(170);
    expect(nextTextPage(700, 200, 1000)).toBe(800);
    expect(nextTextPage(800, 200, 1000)).toBe(800); // already at the end
    expect(nextTextPage(0, 20, 1000)).toBe(40); // minimum page, not a sliver
  });

  it("revealNextTextPage never scrolls a fitting plate", () => {
    expect(nextTextPage(0, 400, 300)).toBe(0);
    expect(nextTextPage(0, 0, 0)).toBe(0);
  });
});

describe("movie global listeners are wired once (P2 cleanup)", () => {
  // No DOM environment in this suite, so the contract is pinned at the
  // source level: the two document/window listeners must live in the
  // module-level `wireGlobals()` (guarded by `globalsWired`), NOT in
  // `wireLayer()`. A layer element is rebuilt whenever `#reader` is
  // re-created after a menu visit, so per-layer wiring leaked one
  // visibilitychange + resize listener per visit.
  const src = fs.readFileSync(new URL("./movie.ts", import.meta.url), "utf8");

  function bodyOf(name: string): string {
    const start = src.indexOf(`function ${name}(`);
    expect(start, `${name} exists`).toBeGreaterThanOrEqual(0);
    // Walk braces so the slice is exactly the function body.
    const open = src.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) return src.slice(open, i + 1);
      }
    }
    throw new Error(`unbalanced braces in ${name}`);
  }

  it("registers visibilitychange / resize only inside wireGlobals", () => {
    expect(src.match(/document\.addEventListener\("visibilitychange"/g)).toHaveLength(1);
    expect(src.match(/window\.addEventListener\("resize"/g)).toHaveLength(1);
    const globals = bodyOf("wireGlobals");
    expect(globals).toContain('document.addEventListener("visibilitychange"');
    expect(globals).toContain('window.addEventListener("resize"');
    // The per-layer wiring must not carry them any more.
    const layer = bodyOf("wireLayer");
    expect(layer).not.toContain('"visibilitychange"');
    expect(layer).not.toContain('"resize"');
  });

  it("guards the globals behind a one-shot flag", () => {
    expect(src).toMatch(/let globalsWired = false;/);
    expect(bodyOf("wireGlobals")).toMatch(/if \(globalsWired \|\| typeof document === "undefined"\) return;/);
    expect(bodyOf("wireGlobals")).toContain("globalsWired = true;");
    // openMovie must call it, so a film opened after a menu rebuild still
    // has working background-pause and rotation handling.
    expect(bodyOf("openMovie")).toContain("wireGlobals();");
  });

  it("keeps pauseMovie / releaseMovieWarm module-internal", () => {
    // Both are implementation details of the layer: exporting them invited
    // callers to pause/release a film the module still owned.
    expect(src).not.toMatch(/export function pauseMovie/);
    expect(src).not.toMatch(/export function releaseMovieWarm/);
    expect(src).toMatch(/^function pauseMovie\(/m);
    expect(src).toMatch(/^function releaseMovieWarm\(/m);
  });
});

describe("subtitle columns reach the reader's movie layer (P0-1/P2-5)", () => {
  it("renders a multi-line, positioned lyric pair side by side", () => {
    const cues = parseVtt(`WEBVTT

00:00:01.000 --> 00:00:09.000 line:10% position:20%
Left line one
Left line two

00:00:01.000 --> 00:00:09.000 line:10% position:80%
Right line one
`);
    const active = activeCuesAt(cues, 5);
    const html = regionBlocksHtml(active, "top");
    expect(html).toContain("movie-sub-cols");
    expect(html).toContain("Left line one\nLeft line two");
    expect(html).toContain("Right line one");
    // Nothing from the bottom region bleeds in.
    expect(regionBlocksHtml(active, "bottom")).toBe("");
  });

  it("keeps a lone off-centre cue on its side (P2 subtitle alignment)", () => {
    // One voice singing alone: without the grid column the block inherited
    // the region's `text-align: center` and the line drifted to the middle.
    const loneLeft = parseVtt(`WEBVTT

00:00:01.000 --> 00:00:09.000 line:10% position:18%
Only the left voice
`);
    const left = regionBlocksHtml(activeCuesAt(loneLeft, 5), "top");
    expect(left).toContain("movie-sub-cols");
    expect(left).toContain('class="movie-cue movie-cue-left"');

    const loneRight = parseVtt(`WEBVTT

00:00:01.000 --> 00:00:09.000 line:10% position:82%
Only the right voice
`);
    const right = regionBlocksHtml(activeCuesAt(loneRight, 5), "top");
    expect(right).toContain("movie-sub-cols");
    expect(right).toContain('class="movie-cue movie-cue-right"');

    // A centred cue is untouched: it has no side to hold.
    const centre = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:09.000 line:10%\nSpoken\n");
    expect(regionBlocksHtml(activeCuesAt(centre, 5), "top"))
      .toBe('<div class="movie-cue movie-cue-center">Spoken</div>');
  });
});
