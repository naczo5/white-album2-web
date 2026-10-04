// Text projection: engine tokens -> safe HTML spans.
//
// Rules (mirror MAO build-script-data.py web projection):
//  - `\n` (literal backslash-n) -> line break
//  - `[F16...]` / `<F16 ...>` (any case) -> whisper span (italic)
//  - other F/S wrappers (`<F14...>`, `[S..]`) are stripped, text kept
//  - ruby `[Rbase^reading]` and engine form `[Rbase|reading]` -> <ruby>
//  - everything else is HTML-escaped

const F16_A = /<(?:F16)\s*([\s\S]*?)>/gi;
const F16_B = /\[(?:F16)([\s\S]*?)\]/gi;
const RUBY = /\[R([^\]|^]+)(?:\^|\|)([^\]]*)\]/g;
// Whole-token engine style form: <F14"content"> / [S...] (tag and content
// combined, no separate closing tag). Inner content starts with a quote.
const STYLE_WHOLE = /^(?:<|\[)([FfSs])(\d*)\s*([\s\S]*)(?:>|\])$/i;
// Bare tags with no content (only these are stripped blindly).
const WRAP_STRIP = /<\/?[FS]\d*\s*>/gi;
// Per-character timing tags (<W10>… / [W10]…): engine-only, never shown.
const TIMING_STRIP = /[<[]W\d+[\]>]/gi;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface TextSpan {
  text: string;
  whisper?: boolean;
  ruby?: string; // reading; text is the base
}

/**
 * Split raw engine text into styled spans.
 * A span is cut at every whisper or ruby boundary so each span carries
 * at most one style + optional ruby reading.
 */
export function spanize(raw: string): TextSpan[] {
  // Insert sentinels: \u0003..\u0004 = whisper, \u0001base\u0002reading\u0005 = ruby.
  let s = raw.replace(RUBY, (_m, base: string, reading: string) =>
    `\u0001${base}\u0002${reading}\u0005`);
  s = s.replace(F16_A, (_m, inner: string) => `\u0003${inner}\u0004`);
  s = s.replace(F16_B, (_m, inner: string) => `\u0003${inner}\u0004`);
  s = s.replace(TIMING_STRIP, "");
  // Mid-string engine wrappers: drop the tag, keep the content.
  s = s.replace(/<[FS]\d+([^<>]*)>/gi, (_m, inner: string) => inner);
  // Whole-token style form: unwrap to inner content (F16 already handled).
  const whole = STYLE_WHOLE.exec(s);
  if (whole) {
    let inner = whole[3].trim();
    if (inner.length >= 2 && "\"'「".includes(inner[0])) inner = inner.slice(1);
    if (inner.length >= 1 && "\"'」".includes(inner[inner.length - 1])) {
      inner = inner.slice(0, -1);
    }
    s = inner;
  }
  s = s.replace(WRAP_STRIP, "");
  const out: TextSpan[] = [];
  const re = /\u0003([\s\S]*?)\u0004|\u0001([\s\S]*?)\u0002([\s\S]*?)\u0005/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (text: string, whisper: boolean) => {
    if (text) out.push(whisper ? { text, whisper: true } : { text });
  };
  while ((m = re.exec(s)) !== null) {
    push(s.slice(last, m.index), false);
    if (m[1] !== undefined) {
      // Whisper region may itself contain ruby markers; recurse plain.
      const inner = m[1].replace(/\u0001([\s\S]*?)\u0002([\s\S]*?)\u0005/g,
        (_mm, b: string, r: string) => `\u0006${b}\u0007${r}\u0006`);
      const parts = inner.split(/(\u0006[\s\S]*?\u0007[\s\S]*?\u0006)/g);
      for (const part of parts) {
        const rm = /^\u0006([\s\S]*?)\u0007([\s\S]*?)\u0006$/.exec(part);
        if (rm) out.push({ text: rm[1], whisper: true, ruby: rm[2] });
        else push(part, true);
      }
    } else {
      out.push({ text: m[2], ruby: m[3] });
    }
    last = m.index + m[0].length;
  }
  push(s.slice(last), false);
  return out;
}

/** Render engine text to HTML. `\\n` -> <br>. Quotes kept as-is. */
export function renderText(raw: string): string {
  return spanize(raw)
    .map((sp) => {
      let t = escapeHtml(sp.text).replace(/\\k/g, "<br><br>").replace(/\\n/g, "<br>");
      if (sp.ruby !== undefined) {
        t = `<ruby>${t}<rt>${escapeHtml(sp.ruby)}</rt></ruby>`;
      }
      return `<span${sp.whisper ? ' class="whisper"' : ""}>${t}</span>`;
    })
    .join("");
}

/** Plain-text projection (backlog/search/exports): strip markup. */
export function plainText(raw: string): string {
  let s = raw
    .replace(RUBY, (_m, base: string) => base)
    .replace(F16_A, (_m, inner: string) => inner)
    .replace(F16_B, (_m, inner: string) => inner);
  s = s.replace(TIMING_STRIP, "");
  const whole = STYLE_WHOLE.exec(s);
  if (whole) {
    let inner = whole[3].trim();
    if (inner.length >= 2 && "\"'「".includes(inner[0])) inner = inner.slice(1);
    if (inner.length >= 1 && "\"'」".includes(inner[inner.length - 1])) {
      inner = inner.slice(0, -1);
    }
    s = inner;
  }
  // Mid-string engine wrappers: drop the tag, keep the content.
  s = s.replace(/<([FS])(\d+)([^<>]*)>/gi, (_m, _k: string, _s: string, inner: string) => inner);
  return s.replace(WRAP_STRIP, "").replace(/\\k/g, "\n\n").replace(/\\n/g, "\n");
}
