import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { activeCuesAt, cueColumn, cueHtml, cueText, parseTimestamp, parseVtt, regionBlocksHtml, regionHtml, regionLayout, regionSignature } from "./vtt";

const DOC = `WEBVTT

NOTE this block is ignored
spanning lines

1
00:00:01.000 --> 00:00:03.500
First line

00:00:04.000 --> 00:00:06.000 line:10% position:50%
<i>Song cue</i>


00:00:07.000 --> 00:00:09.000
Bottom line
`;

describe("WebVTT timestamps", () => {
  it("parses HH:MM:SS.mmm and MM:SS.mmm", () => {
    expect(parseTimestamp("00:00:01.500")).toBeCloseTo(1.5, 5);
    expect(parseTimestamp("01:02:03.250")).toBeCloseTo(3723.25, 5);
    expect(parseTimestamp("02:03.5")).toBeCloseTo(123.5, 5);
    expect(parseTimestamp("00:00:00.000")).toBe(0);
  });

  it("accepts comma decimals and rejects junk", () => {
    expect(parseTimestamp("00:00:02,750")).toBeCloseTo(2.75, 5);
    expect(parseTimestamp("nope")).toBeNull();
    expect(parseTimestamp("00:99:00.000")).toBeNull();
    expect(parseTimestamp("")).toBeNull();
  });
});

describe("WebVTT parsing", () => {
  it("reads cues, ignores NOTE blocks and identifiers", () => {
    const cues = parseVtt(DOC);
    expect(cues.map((c) => c.text)).toEqual(["First line", "Song cue", "Bottom line"]);
    expect(cues[0].start).toBeCloseTo(1, 5);
    expect(cues[0].end).toBeCloseTo(3.5, 5);
  });

  it("tolerates a missing header and CRLF line endings", () => {
    const cues = parseVtt("00:00:01.000 --> 00:00:02.000\r\nHi\r\n");
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("Hi");
  });

  it("skips malformed cues instead of throwing", () => {
    const cues = parseVtt(`WEBVTT

00:00:05.000 --> 00:00:01.000
Backwards

00:00:05.000 -->
No end

00:00:08.000 --> 00:00:09.000
Okay
`);
    expect(cues.map((c) => c.text)).toEqual(["Okay"]);
  });

  it("drops cues with no text", () => {
    expect(parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n\n")).toEqual([]);
  });

  it("sorts overlapping cues by start time", () => {
    const cues = parseVtt(`WEBVTT

00:00:09.000 --> 00:00:12.000
Later

00:00:02.000 --> 00:00:04.000
Earlier
`);
    expect(cues.map((c) => c.text)).toEqual(["Earlier", "Later"]);
  });

  it("maps line: settings to top vs bottom regions", () => {
    const cues = parseVtt(`WEBVTT

00:00:01.000 --> 00:00:02.000 line:10%
Top tenth

00:00:03.000 --> 00:00:04.000 line:25%
Top at the boundary

00:00:05.000 --> 00:00:06.000 line:26%
Just below

00:00:07.000 --> 00:00:08.000 line:2
Early grid row

00:00:09.000 --> 00:00:10.000
Default
`);
    expect(cues.map((c) => c.region)).toEqual(["top", "top", "bottom", "top", "bottom"]);
  });

  it("reads position: settings", () => {
    const [cue] = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000 position:35%\nLeft\n");
    expect(cue.position).toBe(35);
  });
});

describe("WebVTT inline markup safety (XSS boundary)", () => {
  it("keeps <i>, <b> and <br> only", () => {
    expect(cueHtml("a<i>b</i>c")).toBe("a<i>b</i>c");
    expect(cueHtml("<b>a</b><br>b")).toBe("<b>a</b><br>b");
  });

  it("escapes raw HTML and drops unknown tags", () => {
    const html = cueHtml('<script>alert(1)</script><img src=x onerror="alert(2)">');
    // Unknown element markup is removed entirely; the surviving text is
    // plain (escaped) text, so no tag can ever reach innerHTML.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror=\"");
    expect(html).toBe("alert(1)");
  });

  it("drops voice/class/timestamp tags without their markup", () => {
    expect(cueHtml('<v Anna>Hello</v>')).toBe("Hello");
    expect(cueHtml('<c.yellow>gold</c>')).toBe("gold");
    expect(cueHtml("<00:00:01.000>tick")).toBe("tick");
  });

  it("rejects tags carrying attributes", () => {
    expect(cueHtml('<i class="x">t</i>')).toBe("t");
    expect(cueHtml('<b onclick="x">t</b>')).toBe("t");
  });

  it("closes unbalanced tags and handles a stray '<'", () => {
    expect(cueHtml("<i>open")).toBe("<i>open</i>");
    expect(cueHtml("a < b")).toBe("a &lt; b");
    expect(cueHtml("tail <unterminated")).toBe("tail &lt;unterminated");
  });

  it("escapes the five dangerous characters", () => {
    expect(cueHtml(`&"'`)).toBe("&amp;&quot;&#39;");
  });

  it("plain text projection strips tags and decodes entities", () => {
    expect(cueText("<i>a</i><br>b")).toBe("ab");
    expect(cueText("a &amp; b &lt;c&gt;")).toBe("a & b <c>");
    expect(cueText("  spaced  ")).toBe("spaced");
  });

  it("a crafted cue can never produce an executable attribute", () => {
    const cues = parseVtt(`WEBVTT

00:00:01.000 --> 00:00:02.000
<img src=x onerror=alert(1)><i onclick='x'>hi</i>
`);
    const out = cues[0].html;
    expect(out).not.toMatch(/onerror|onclick|<img/i);
    // The attribute-carrying <i> is rejected too: only the text survives.
    expect(out).toBe("hi");
  });
});

describe("activeCuesAt", () => {
  const cues = parseVtt(DOC);

  it("selects cues in [start, end)", () => {
    expect(activeCuesAt(cues, 0.5).map((c) => c.text)).toEqual([]);
    expect(activeCuesAt(cues, 1).map((c) => c.text)).toEqual(["First line"]);
    expect(activeCuesAt(cues, 3.5).map((c) => c.text)).toEqual([]);
    expect(activeCuesAt(cues, 7.2).map((c) => c.text)).toEqual(["Bottom line"]);
  });

  it("handles non-finite times and gaps", () => {
    expect(activeCuesAt(cues, Number.NaN)).toEqual([]);
    expect(activeCuesAt(cues, 6.5)).toEqual([]);
  });

  it("groups regions for the two overlay slots", () => {
    const at = activeCuesAt(cues, 4.5);
    expect(regionHtml(at, "top")).toBe("<i>Song cue</i>");
    expect(regionHtml(at, "bottom")).toBe("");
  });
});

describe("multi-line cues (P0-1)", () => {
  const MULTI = `WEBVTT

00:00:01.000 --> 00:00:05.000 line:10%
First lyric line
Second lyric line
Third lyric line
`;

  it("keeps authored line breaks in the cue body", () => {
    const [cue] = parseVtt(MULTI);
    // The parser hands the renderer real newlines; CSS `white-space:
    // pre-line` on `.movie-subs` is what turns them into visible lines.
    expect(cue.html).toBe("First lyric line\nSecond lyric line\nThird lyric line");
    expect(cue.text).toBe("First lyric line\nSecond lyric line\nThird lyric line");
  });

  it("keeps explicit <br> breaks too", () => {
    const [cue] = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA<br>B\n");
    expect(cue.html).toBe("A<br>B");
  });

  it("a multi-line cue renders as one positioned block", () => {
    const [cue] = parseVtt(MULTI);
    const html = regionBlocksHtml([cue], "top");
    expect(html).toBe(`<div class="movie-cue movie-cue-center">First lyric line\nSecond lyric line\nThird lyric line</div>`);
  });
});

describe("positioned columns (P2-5)", () => {
  const CUES = parseVtt(`WEBVTT

00:00:01.000 --> 00:00:05.000 line:10% position:22%
Left voice

00:00:01.000 --> 00:00:05.000 line:10% position:78%
Right voice
`);

  it("classifies cues into left / right / centre columns", () => {
    expect(CUES.map(cueColumn)).toEqual(["left", "right"]);
    expect(cueColumn({ ...CUES[0], position: null })).toBe("center");
    expect(cueColumn({ ...CUES[0], position: 44.9 })).toBe("left");
    expect(cueColumn({ ...CUES[0], position: 45 })).toBe("right");
  });

  it("side-by-side cues become a two-column grid, not a stacked column", () => {
    const layout = regionLayout(CUES, "top");
    expect(layout.split).toBe(true);
    expect(layout.columns.map((c) => c.column)).toEqual(["left", "right"]);
    const html = regionBlocksHtml(CUES, "top");
    expect(html).toContain('class="movie-sub-cols"');
    expect(html).toContain('<div class="movie-cue movie-cue-left">Left voice</div>');
    expect(html).toContain('<div class="movie-cue movie-cue-right">Right voice</div>');
    // The old `regionHtml` join is gone from this path: no <br> stacking.
    expect(html).not.toContain("<br>");
  });

  it("same-column cues stack inside one column", () => {
    const stacked = parseVtt(`WEBVTT

00:00:01.000 --> 00:00:09.000 line:10% position:20%
First

00:00:01.000 --> 00:00:09.000 line:10% position:30%
Second
`);
    const layout = regionLayout(stacked, "top");
    expect(layout.split).toBe(false);
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0].column).toBe("left");
    expect(layout.columns[0].html).toBe("First<br>Second");
  });

  it("a single off-centre cue keeps its column inside the grid", () => {
    const one = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:10% position:10%\nOnly\n");
    const html = regionBlocksHtml(one, "top");
    // The lone cue goes through the grid on purpose: `.movie-cue-left` /
    // `.movie-cue-right` alone would collapse to `text-align: center` under
    // `.movie-subs`. `grid-column` is what keeps the side.
    expect(html).toBe(
      '<div class="movie-sub-cols movie-sub-cols-lone"><div class="movie-cue movie-cue-left">Only</div></div>',
    );
    const right = regionBlocksHtml(
      parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:10% position:90%\nRight only\n"), "top");
    expect(right).toBe(
      '<div class="movie-sub-cols movie-sub-cols-lone"><div class="movie-cue movie-cue-right">Right only</div></div>',
    );
    // A lone centred cue needs no positioning: it stays a bare block.
    const mid = regionBlocksHtml(
      parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:10%\nMiddle\n"), "top");
    expect(mid).toBe('<div class="movie-cue movie-cue-center">Middle</div>');
  });

  it("grid column placement is what holds a lone cue's side (style pin)", () => {
    // DOM-free guard for the CSS contract `regionBlocksHtml` relies on:
    // both sides must be pinned to their own grid column, otherwise a lone
    // off-centre cue would align back to the region's centre.
    const css = fs.readFileSync(new URL("../style.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.movie-sub-cols \.movie-cue-left \{[^}]*grid-column: 1/);
    expect(css).toMatch(/\.movie-sub-cols \.movie-cue-right \{[^}]*grid-column: 2/);
    // And the bare fallback keeps the alignment if markup ever escapes the grid.
    expect(css).toMatch(/\.movie-subs > \.movie-cue-left \{[^}]*text-align: left/);
    expect(css).toMatch(/\.movie-subs > \.movie-cue-right \{[^}]*text-align: right/);
  });

  it("regions stay independent: a top pair never pulls in bottom cues", () => {
    const mixed = parseVtt(`WEBVTT

00:00:01.000 --> 00:00:09.000 line:10% position:20%
Lyric L

00:00:01.000 --> 00:00:09.000 line:10% position:80%
Lyric R

00:00:01.000 --> 00:00:09.000
Spoken
`);
    expect(regionBlocksHtml(mixed, "bottom")).toBe('<div class="movie-cue movie-cue-center">Spoken</div>');
    expect(regionLayout(mixed, "bottom").split).toBe(false);
  });

  it("the paint signature distinguishes columns and content", () => {
    expect(regionSignature(CUES, "top")).toContain("left\u0001Left voice");
    expect(regionSignature(CUES, "top")).toContain("right\u0001Right voice");
    expect(regionSignature(CUES, "bottom")).toBe("");
    expect(regionSignature([], "top")).toBe("");
  });
});
