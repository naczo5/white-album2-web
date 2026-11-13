// WebVTT parsing for movie subtitles: pure, DOM-free, test-pinned.
//
// The player renders cues as HTML, so the parser is the security boundary:
// cue text is escaped first and only a tiny allow-list of inline tags
// (`<i>`, `<b>`, `<br>`) is ever re-emitted. Everything else — cue classes,
// voice spans, timestamp tags, raw attributes, `<script>` — is dropped
// without its markup, and unbalanced tags are closed so a malformed file
// can never leak markup into the dialogue frame.
//
// Layout hint: WebVTT `line:` settings place song lyrics at the top of the
// frame and spoken lines at the bottom. `line <= 25%` is the top region;
// bare numeric lines are mapped onto a nominal 12-row grid (the engine's
// own caption rows), and `line` counted from the bottom stays bottom.

export type VttRegion = "top" | "bottom";

export interface VttCue {
  /** Seconds from the start of the movie. */
  start: number;
  end: number;
  /** Safe inline HTML: only `<i>`, `<b>`, `<br>` survive. */
  html: string;
  /** Plain-text projection (assertions, screen readers, copy). */
  text: string;
  region: VttRegion;
  /** `position:` percentage, when the file sets one. */
  position: number | null;
}

/** Lines per frame assumed for bare `line:N` settings. */
const LINE_GRID = 12;
const TOP_MAX_PCT = 25;

const TS_RE = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/;

/** `HH:MM:SS.mmm`, `MM:SS.mmm` (and the comma decimal form) -> seconds. */
export function parseTimestamp(raw: string): number | null {
  const m = TS_RE.exec(raw.trim());
  if (!m) return null;
  const h = m[1] === undefined ? 0 : Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || !Number.isFinite(sec)) return null;
  if (min > 59 || sec > 59) return null;
  const frac = m[4] === undefined ? 0 : Number(m[4].padEnd(3, "0")) / 1000;
  return h * 3600 + min * 60 + sec + frac;
}

/** `line:` setting -> approximate top offset %, or null when bottom-anchored. */
function linePercent(value: string): number | null {
  if (value.endsWith("%")) {
    const n = Number(value.slice(0, -1));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null; // negative = counted upward
  return (n / LINE_GRID) * 100;
}

function parseSettings(tokens: string[]): { region: VttRegion; position: number | null } {
  let region: VttRegion = "bottom";
  let position: number | null = null;
  for (const token of tokens) {
    const colon = token.indexOf(":");
    if (colon <= 0) continue;
    const key = token.slice(0, colon).toLowerCase();
    const value = token.slice(colon + 1);
    if (key === "line") {
      const pct = linePercent(value);
      if (pct !== null) region = pct <= TOP_MAX_PCT ? "top" : "bottom";
    } else if (key === "position") {
      const n = Number(value.replace("%", ""));
      if (Number.isFinite(n)) position = Math.max(0, Math.min(100, n));
    }
  }
  return { region, position };
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Allow-listed inline markup -> safe HTML, everything else dropped. */
export function cueHtml(raw: string): string {
  let out = "";
  const open: string[] = [];
  let i = 0;
  const pushText = (s: string) => {
    if (s) out += escapeText(s);
  };
  while (i < raw.length) {
    const lt = raw.indexOf("<", i);
    if (lt < 0) {
      pushText(raw.slice(i));
      break;
    }
    pushText(raw.slice(i, lt));
    const gt = raw.indexOf(">", lt);
    if (gt < 0) {
      // Unterminated tag: the rest is literal text (never markup).
      pushText(raw.slice(lt));
      break;
    }
    const tag = raw.slice(lt + 1, gt).trim().toLowerCase();
    const closing = tag.startsWith("/");
    const name = (closing ? tag.slice(1) : tag).split(/[\s.]/)[0];
    if (name === "br") {
      out += "<br>";
    } else if (name === "i" || name === "b") {
      // No attributes: `<i class="x">` would pass a style hook through.
      const bare = closing ? tag === `/${name}` : tag === name;
      if (bare && closing) {
        const at = open.lastIndexOf(name);
        if (at >= 0) {
          open.splice(at, 1);
          out += `</${name}>`;
        }
      } else if (bare) {
        open.push(name);
        out += `<${name}>`;
      }
    }
    i = gt + 1;
  }
  for (let k = open.length - 1; k >= 0; k--) out += `</${open[k]}>`;
  return out;
}

/** Plain-text projection of cue markup (tags removed, entities decoded). */
export function cueText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function parseCue(timing: string, body: string): VttCue | null {
  const arrow = timing.indexOf("-->");
  if (arrow < 0) return null;
  const start = parseTimestamp(timing.slice(0, arrow));
  const rest = timing.slice(arrow + 3).trim().split(/\s+/);
  const end = parseTimestamp(rest[0] ?? "");
  if (start === null || end === null || end <= start) return null;
  const text = cueText(body);
  if (!text) return null;
  const { region, position } = parseSettings(rest.slice(1));
  return { start, end, html: cueHtml(body), text, region, position };
}

/**
 * Parse a WebVTT document into sorted, safe cues.
 * Header metadata, NOTE/STYLE/REGION blocks and cue identifiers are
 * ignored; malformed cues are skipped rather than throwing (a bad subtitle
 * file must never break playback).
 */
export function parseVtt(raw: string): VttCue[] {
  if (!raw) return [];
  const lines = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  if ((lines[0] ?? "").trim().startsWith("WEBVTT")) i = 1;
  const cues: VttCue[] = [];
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === "") {
      i++;
      continue;
    }
    if (/^(NOTE|STYLE|REGION)(\s|$)/i.test(line)) {
      while (i < lines.length && lines[i].trim() !== "") i++;
      continue;
    }
    let timing = line;
    if (!timing.includes("-->")) {
      // Optional cue identifier on its own line.
      i++;
      timing = (lines[i] ?? "").trim();
      if (!timing.includes("-->")) {
        i++;
        continue;
      }
    }
    i++;
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      body.push(lines[i]);
      i++;
    }
    const cue = parseCue(timing, body.join("\n"));
    if (cue) cues.push(cue);
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return cues;
}

/** Cues visible at `timeSec` (start inclusive, end exclusive). */
export function activeCuesAt(cues: VttCue[], timeSec: number): VttCue[] {
  if (!Number.isFinite(timeSec)) return [];
  return cues.filter((c) => timeSec >= c.start && timeSec < c.end);
}

/** Join the active cues of one region for display. */
export function regionHtml(cues: VttCue[], region: VttRegion): string {
  return cues
    .filter((c) => c.region === region)
    .map((c) => c.html)
    .join("<br>");
}

/** Which horizontal column a cue belongs to. Cues without a `position:`
 * setting are centred; a lyric sheet that sets `position:` for a left
 * (<45%) and a right (>=45%) voice must render side by side, not stacked
 * into an eight-line column. */
export type VttColumn = "left" | "right" | "center";

export const COLUMN_SPLIT_PCT = 45;

export function cueColumn(cue: VttCue): VttColumn {
  if (cue.position === null || !Number.isFinite(cue.position)) return "center";
  return cue.position < COLUMN_SPLIT_PCT ? "left" : "right";
}

export interface VttRegionLayout {
  /** Side-by-side or stacked columns, left to right. Empty when the region
   * has no active cue. */
  columns: { column: VttColumn; html: string }[];
  /** Two distinct off-centre columns are present: the region must use the
   * grid (`.movie-sub-cols`) instead of stacking cues vertically. */
  split: boolean;
}

/**
 * Group one region's active cues into display columns.
 *
 * A single cue (or several cues that share a column / are all centred)
 * keeps the historical stacked output: `regionHtml` is exactly the `html`
 * of the merged block, so existing callers and tests stay valid. Only a
 * genuine left+right pair takes the two-column path.
 */
export function regionLayout(cues: VttCue[], region: VttRegion): VttRegionLayout {
  const active = cues.filter((c) => c.region === region);
  if (active.length === 0) return { columns: [], split: false };
  const centred = active.filter((c) => cueColumn(c) === "center");
  const left = active.filter((c) => cueColumn(c) === "left");
  const right = active.filter((c) => cueColumn(c) === "right");
  // A centred cue with no side cue keeps the plain block. A centred cue that
  // sits alongside one side column belongs to that column (it is the same
  // speaker continuing); only left+right together split the frame.
  if (left.length > 0 && right.length > 0) {
    return {
      columns: [
        { column: "left", html: [...left, ...centred].map((c) => c.html).join("<br>") },
        { column: "right", html: right.map((c) => c.html).join("<br>") },
      ],
      split: true,
    };
  }
  const single: VttColumn = left.length > 0 ? "left" : right.length > 0 ? "right" : "center";
  const html = [...active].map((c) => c.html).join("<br>");
  return { columns: [{ column: single, html }], split: false };
}

/** Render one region as positioned blocks: a single `.movie-cue` block per
 * column, wrapped in `.movie-sub-cols` only when both sides are used. */
export function regionBlocksHtml(cues: VttCue[], region: VttRegion): string {
  const layout = regionLayout(cues, region);
  if (layout.columns.length === 0) return "";
  if (layout.split) {
    return `<div class="movie-sub-cols">${
      layout.columns.map((c) => `<div class="movie-cue movie-cue-${c.column}">${c.html}</div>`).join("")
    }</div>`;
  }
  const [only] = layout.columns;
  // A lone off-centre cue (one voice singing alone, or a spoken line the
  // file anchors left/right) must keep its side. Rendered bare inside the
  // centred `.movie-subs` band it collapsed back to `text-align: center`,
  // so it goes into the same grid and claims its own column: `grid-column`
  // honours both a lone left/right cue and a left+right pair with zero
  // overlap. Centred cues stay bare — they have nothing to position.
  if (only.column === "center") {
    return `<div class="movie-cue movie-cue-center">${only.html}</div>`;
  }
  return `<div class="movie-sub-cols movie-sub-cols-lone">${
    `<div class="movie-cue movie-cue-${only.column}">${only.html}</div>`
  }</div>`;
}

/** Signature for the cue paint cache (covers columns, not just text). */
export function regionSignature(cues: VttCue[], region: VttRegion): string {
  const layout = regionLayout(cues, region);
  return layout.columns.map((c) => `${c.column}\u0001${c.html}`).join("\u0000");
}
