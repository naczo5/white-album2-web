"""JP-spine scenario IR builder: MAO en.pak overlay + manuscript text.

Rebuilds the per-script event IR on the JP script.pak spine instead of the
MAO en.pak stream. Evidence (docs/PARSING.md §"MAO en.pak layout"):

- The patched WA2.exe runs TWO script streams: the JP script.pak spine
  (the exe still loads and interprets it; four `script` refs vs JP's one)
  with en.pak substituted per line. Display order/structure = JP order.
- EN naive comma token i == JP naive comma token i, 1:1 (corpus-verified);
  EN files carry EXTRA tokens appended at the file end in source-line
  order (overflow fragments of earlier truncated lines: 1002 has 35
  extras; 143/174 scripts differ by >5 tokens, total 2667).
- Long EN tokens are truncated mid-word in the EN txt (the full line lives
  in the tail fragments); the MAO manuscript (script-data/*.json) carries
  the complete, punctuated English per line and aligns 1:1 with JP display
  events by ordinal (fuzzy; drift <= ~16 lines/script).
- JP txt has zero `"` characters, so quote-aware splitting never fires on
  the spine; `parse_txt.split_tokens` == naive split for JP.

Pipeline per script:
  1. JP naive tokens -> parse_tokens  (structural ground truth)
  2. EN naive tokens substituted per token (payload only; wrapper/shape
     preserved so classification matches the spine; tail extras dropped)
  3. hybrid token list -> parse_tokens -> IR events
  4. manuscript pass: say/narrate text replaced by the aligned manuscript
     English (complete lines, real punctuation); EN-token text stays as
     the fallback for unaligned lines.

Output IR schema is unchanged ({script, tokens, events, warnings}).
Script classes: JP+EN -> hybrid (spine + EN payload); EN-only -> naive EN
parse + English-containment manuscript pass; JP-only (omake/system stubs)
-> JP parse + JP-containment manuscript pass.
Usage:
  python3 build_ir.py JP_PAK [EN_PAK ...] MAO_DIR IR_DIR
"""

from __future__ import annotations

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import kcap  # noqa: E402
import lzss  # noqa: E402
import parse_txt  # noqa: E402
from build_voice import (  # noqa: E402
    _fill_runs,
    _norm_en,
    jp_norm,
    match_jp_to_mao,
)
from parse_txt import _FW_DIGITS  # noqa: E402

# MAO manuscript typography -> engine conventions (straight quotes, and
# real newlines become the engine's literal \n sequences the reader maps
# to <br>).
_QMAP = str.maketrans({"“": '"', "”": '"', "‘": "'", "’": "'",
                       "\r": ""})

_man_index_cache: dict[str, dict[str, str]] = {}


def naive_tokens(txt: bytes) -> list[str]:
    """The engine's split: raw ASCII commas (safe in cp932: trail bytes
    of multi-byte chars are >= 0x40)."""
    return [t.decode("cp932", "replace") for t in txt.split(b",")]


_QUOTES = "\"'「『」』"


def strip_quotes(s: str) -> str:
    if len(s) >= 2 and s[0] in _QUOTES and s[-1] in _QUOTES:
        return s[1:-1]
    if s[:1] in _QUOTES:
        s = s[1:]
    if s[-1:] in _QUOTES:
        s = s[:-1]
    return s.strip()


def hybrid_token(jp: str, en: str | None) -> tuple[str, str]:
    """EN payload substituted into the JP token's shape.

    Returns (token, note). Classification must be identical to the spine:
    dialogue wrappers stay JP, structural tokens switch only when
    classify_bare agrees, bare narration keeps the JP class by stripping
    any EN quote wrapper MAO added.
    """
    if en is None:
        return jp, "no_en"
    if jp == "":
        return "", "shape"  # empties are structural; EN empties align 1:1
    if en == "":
        return jp, "en_empty"
    kj = parse_txt.classify_bare(jp)
    if kj != "text":
        if parse_txt.classify_bare(en) == kj:
            return en, "en_struct"
        return jp, "struct_mismatch"
    if parse_txt.is_dialogue(jp):
        payload = strip_quotes(en)
        return jp[0] + payload + (jp[-1] if len(jp) > 1 else ""), "en_text"
    # bare narration / name token: strip EN quote wrappers so the token
    # class cannot flip say/narrate/latch against the spine
    payload = strip_quotes(en)
    # Name-eligibility guard: an EN payload that reads as a speaker name
    # (or CATCH voice-context arg) where the JP token does not would be
    # swallowed by the CATCH/jump arg rule or latch, changing event
    # counts. Fullwidth ？？？ -> ASCII ??? is the corpus case (1007).
    if not parse_txt.valid_name(jp) and parse_txt.valid_name(payload):
        return jp, "name_guard"
    return payload, "en_text"


def manuscript_index(mao_dir: str) -> dict[str, str]:
    """script id -> manuscript file path (first route wins)."""
    idx = _man_index_cache.get(mao_dir)
    if idx is not None:
        return idx
    idx = {}
    data = json.load(open(os.path.join(mao_dir, "index.json"),
                          encoding="utf-8"))
    for r in data["routes"]:
        for s in r["scripts"]:
            idx.setdefault(s["id"], os.path.join(mao_dir, s["file"]))
    _man_index_cache[mao_dir] = idx
    return idx


def manuscript_lines(mao_dir: str, script: str) -> list[dict] | None:
    """Manuscript rows for a pak script: its own file plus _N continuations
    (MAO splits long branch scripts; pak 1012_030.txt covers manuscript
    1012_030 + 1012_030_2). Base file first, then _2, _3, ..."""
    idx = manuscript_index(mao_dir)
    parts: list[tuple[int, str]] = []
    if script in idx:
        parts.append((0, idx[script]))
    for sid, path in idx.items():
        m = re.match(re.escape(script) + r"_(\d+)$", sid)
        if m:
            parts.append((int(m.group(1)) + 1, path))
    if not parts:
        return None
    parts.sort()
    lines: list[dict] = []
    for _k, path in parts:
        try:
            j = json.load(open(path, encoding="utf-8"))
        except (OSError, ValueError):
            continue
        lines.extend(j.get("lines") or [])
    return lines or None


def match_en_to_mao(en_texts: list[str], mao_en: list[str],
                    window: int = 60) -> dict[int, int]:
    """EN line ordinal -> manuscript line ordinal by normalized containment.

    EN-only scripts have no JP spine text to align with, but the EN txt
    fragments are (truncated) prefixes of the manuscript English, so the
    same monotonic containment matcher works on the English side. Pure.
    """
    mnorm = [_norm_en(x) for x in mao_en]
    o2m: dict[int, int] = {}
    cur = 0
    for o, text in enumerate(en_texts):
        ne = _norm_en(text)
        if not ne:
            continue
        hit = None
        for j in range(cur, min(cur + window, len(mnorm))):
            if ne and ne in mnorm[j]:
                hit = j
                break
            mj = mnorm[j]
            if mj and mj in ne and len(mj) >= 20:
                hit = j
                break
        if hit is not None:
            o2m[o] = hit
            cur = hit
    _fill_runs(o2m, len(en_texts), len(mnorm))
    return o2m


def _manuscript_pass(events: list[dict], disp_texts: list[str],
                     mao_lines: list[dict], use_en: bool,
                     warnings: list[str]) -> dict[str, int]:
    """Replace say/narrate text with the aligned manuscript English.

    use_en: align by English containment (EN-only scripts) instead of JP.
    """
    stats = {"manuscript": 0, "fallback": 0}
    disp = [e for e in events if e.get("t") in ("say", "narrate")]
    if len(disp) != len(disp_texts):
        warnings.append("display drift; manuscript pass skipped")
        stats["fallback"] = len(disp)
        return stats
    if use_en:
        o2m = match_en_to_mao(disp_texts,
                              [l.get("english") or "" for l in mao_lines])
    else:
        o2m = match_jp_to_mao(disp_texts,
                              [jp_norm(l.get("japanese") or "")
                               for l in mao_lines])
    for o, e in enumerate(disp):
        m = o2m.get(o)
        en = ""
        if m is not None:
            en = (mao_lines[m].get("english") or "").translate(_QMAP)
            en = en.replace("\n", "\\n").strip()
        if not en:
            stats["fallback"] += 1
            continue
        # engine convention: say bodies carry no outer quote pair (the
        # reader styles dialogue itself)
        e["text"] = strip_quotes(en) if e["t"] == "say" else en
        stats["manuscript"] += 1
    return stats


_OPT_LINE = re.compile(r"^([0-9０-９]+)[.．]\s?(.*)$")


def _choice_pass(events: list[dict], mao_lines: list[dict]) -> int:
    """Complete choice option text from the manuscript.

    Manuscript option rows are `N．text` (JP) with an `N. text` EN twin;
    index EN bodies by the JP body and by the EN body, then replace
    option text (JP spine text or truncated EN) with the full English.
    Presentation only — option number/goto routing is untouched.
    Returns the number of option texts replaced.
    """
    by_jp: dict[str, str] = {}
    by_en: dict[str, str] = {}
    for l in mao_lines:
        m = _OPT_LINE.match((l.get("english") or "").strip())
        if not m:
            continue
        body = m.group(2).translate(_QMAP).replace("\n", "\\n").strip()
        if not body:
            continue
        jm = _OPT_LINE.match((l.get("japanese") or "").strip())
        if jm and jm.group(1).translate(_FW_DIGITS) == \
                m.group(1).translate(_FW_DIGITS):
            by_jp.setdefault(jp_norm(jm.group(2)), body)
        by_en.setdefault(_norm_en(m.group(2)), body)
    n = 0
    for e in events:
        if e.get("t") != "choice":
            continue
        for o in e.get("options") or []:
            t = o.get("text") or ""
            if not t:
                continue
            en = by_jp.get(jp_norm(t)) or by_en.get(_norm_en(t))
            if en and en != t:
                o["text"] = en
                n += 1
    return n


def build_script_ir(jp_txt: bytes | None, en_txt: bytes | None,
                    mao_lines: list[dict] | None) -> tuple[dict, dict]:
    warnings: list[str] = []
    stats = {"manuscript": 0, "fallback": 0}
    if jp_txt is not None and en_txt is not None:
        return _build_hybrid(jp_txt, en_txt, mao_lines, warnings)
    if en_txt is not None:
        toks = naive_tokens(en_txt)
        events, w = parse_txt.parse_tokens(toks)
        warnings.extend(w)
        if mao_lines:
            stats = _manuscript_pass(
                events, [e.get("text") or "" for e in events
                         if e.get("t") in ("say", "narrate")],
                mao_lines, use_en=True, warnings=warnings)
            stats["options"] = _choice_pass(events, mao_lines)
        else:
            stats["fallback"] = sum(1 for e in events
                                    if e.get("t") in ("say", "narrate"))
        return ({"script": "", "tokens": len(toks), "events": events,
                 "warnings": warnings}, stats)
    if jp_txt is not None:
        toks = naive_tokens(jp_txt)
        events, w = parse_txt.parse_tokens(toks)
        warnings.extend(w)
        if mao_lines:
            stats = _manuscript_pass(
                events, [e.get("text") or "" for e in events
                         if e.get("t") in ("say", "narrate")],
                mao_lines, use_en=False, warnings=warnings)
            stats["options"] = _choice_pass(events, mao_lines)
        else:
            warnings.append("no en txt, no manuscript; jp text kept")
            stats["fallback"] = sum(1 for e in events
                                    if e.get("t") in ("say", "narrate"))
        return ({"script": "", "tokens": len(toks), "events": events,
                 "warnings": warnings}, stats)
    raise ValueError("build_script_ir needs jp_txt or en_txt")


def _build_hybrid(jp_txt: bytes, en_txt: bytes,
                  mao_lines: list[dict] | None,
                  warnings: list[str]) -> tuple[dict, dict]:
    stats = {"manuscript": 0, "fallback": 0}
    jp_toks = naive_tokens(jp_txt)
    en_toks = naive_tokens(en_txt)

    hyb: list[str] = []
    notes: dict[str, int] = {}
    for j, jt in enumerate(jp_toks):
        et = en_toks[j] if en_toks is not None and j < len(en_toks) else None
        t, note = hybrid_token(jt, et)
        hyb.append(t)
        notes[note] = notes.get(note, 0) + 1
    if en_toks is not None and len(en_toks) > len(jp_toks):
        notes["tail_dropped"] = len(en_toks) - len(jp_toks)
    if en_toks is not None and len(en_toks) < len(jp_toks):
        warnings.append(f"en short by {len(jp_toks) - len(en_toks)} tokens;"
                        " jp payload kept")

    jp_events, _ = parse_txt.parse_tokens(jp_toks)
    events, hwarn = parse_txt.parse_tokens(hyb)
    warnings.extend(hwarn)
    # Structural sanity: substitution preserves shape, so the hybrid event
    # stream must mirror the spine 1:1. Replay the spine's classification
    # onto the hybrid stream (EN name tokens can fail JP-side latch
    # validation — "Setsuna's Mother" carries an apostrophe — and a
    # mislatched name would corrupt every following speaker).
    if len(events) != len(jp_events):
        warnings.append(f"event drift: hybrid {len(events)} vs jp "
                        f"{len(jp_events)}; spine replay skipped")
    else:
        _replay_spine(jp_events, events, warnings)

    # ---- manuscript pass: complete EN text for display lines ----
    if mao_lines:
        disp = [e for e in jp_events if e.get("t") in ("say", "narrate")]
        hyb_disp = [e for e in events if e.get("t") in ("say", "narrate")]
        if len(hyb_disp) != len(disp):
            warnings.append("hybrid/jp display drift; manuscript pass "
                            "skipped")
            stats["fallback"] = len(hyb_disp)
        else:
            stats = _manuscript_pass(
                events, [e.get("text") or "" for e in disp],
                mao_lines, use_en=False, warnings=warnings)
        stats["options"] = _choice_pass(events, mao_lines)
    else:
        stats["fallback"] = sum(1 for e in events
                                if e.get("t") in ("say", "narrate"))
    return ({"script": "", "tokens": len(jp_toks), "events": events,
             "warnings": warnings}, stats)


def _replay_spine(jp_events: list[dict], hy_events: list[dict],
                  warnings: list[str]) -> None:
    """Force the hybrid event stream onto the JP spine's classification.

    The hybrid tokens preserve shape, but EN name payloads can fail the
    JP-tuned latch validator (apostrophes etc.) and flip latch/narrate or
    stale the following speaker. The spine is authoritative for WHAT each
    line is; the hybrid stream only contributes text.
    """
    name_votes: dict[str, dict[str, int]] = {}
    # pair by ordinal (lengths verified equal by the caller)
    for jp, hy in zip(jp_events, hy_events):
        t = jp["t"]
        if t == "latch":
            name = (hy.get("name") or hy.get("text") or "").strip()
            if not name:
                name = jp["name"]
            votes = name_votes.setdefault(jp["name"], {})
            votes[name] = votes.get(name, 0) + 1
            hy.clear()
            hy.update({"t": "latch", "name": name, "tok": jp["tok"]})
        elif t == "say":
            hy["t"] = "say"
            sp = ""
            if jp.get("speaker"):
                votes = name_votes.get(jp["speaker"])
                sp = max(votes, key=votes.get) if votes else jp["speaker"]
            hy["speaker"] = sp
            if "tok" not in hy:
                hy["tok"] = jp["tok"]
        elif t == "narrate":
            hy["t"] = "narrate"
            if "tok" not in hy:
                hy["tok"] = jp["tok"]
        elif t == "choice":
            jpo, hyo = jp.get("options") or [], hy.get("options") or []
            if len(jpo) != len(hyo):
                warnings.append(f"option count drift at tok {jp.get('tok')}"
                                f" ({len(jpo)} jp vs {len(hyo)} en)")
            opts = []
            for k, jo in enumerate(jpo):
                ho = hyo[k] if k < len(hyo) else {}
                opts.append({"n": jo["n"], "goto": jo["goto"],
                             "text": ho.get("text") or jo["text"]})
            hy.clear()
            hy.update({"t": "choice", "options": opts, "tok": jp["tok"]})
        else:
            # image/anim/filter/movie/jump/layer: structural passthrough
            # (classify_bare-guarded substitution) — copy spine fields
            hy.clear()
            hy.update(jp)


def txt_entry(data: bytes, script: str) -> bytes | None:
    try:
        e = {x.name: x for x in kcap.read_index(data)
             if not x.is_folder}[script + ".txt"]
    except KeyError:
        return None
    t = data[e.offset:e.offset + e.length]
    if e.is_compressed:
        orig, lz = lzss.split_datahdr(t)
        t = lzss.decompress(lz, orig)
    return t


def main() -> None:
    argv = sys.argv[1:]
    *paks, mao_dir, ir_dir = argv
    os.makedirs(ir_dir, exist_ok=True)
    jp_pak, en_paks = paks[0], paks[1:]
    jp_data = open(jp_pak, "rb").read()

    # later paks override (mirrors build.py: special beats main stub)
    en_txts: dict[str, bytes] = {}
    for p in en_paks:
        d = open(p, "rb").read()
        for e in kcap.read_index(d):
            if e.is_folder or not e.name.endswith(".txt"):
                continue
            t = d[e.offset:e.offset + e.length]
            if e.is_compressed:
                orig, lz = lzss.split_datahdr(t)
                t = lzss.decompress(lz, orig)
            en_txts[e.name[:-4]] = t

    jp_scripts = sorted({e.name[:-4] for e in kcap.read_index(jp_data)
                         if not e.is_folder and e.name.endswith(".txt")})
    # The JP pak is the spine: the patched exe routes only through its
    # script set. MAO's EN-only `NNNN_N` files (2031_2 etc.) are toolchain
    # splits of branch content that the JP base files carry inline — no JP
    # script targets them (corpus-verified), so they are not emitted.
    # Standalone EN-only ids (5200/7000-class omake) stay: the exe's extra
    # menus launch them directly, and data/terminals.json pins them.
    emit = set(jp_scripts) | {
        s for s in en_txts
        if s not in jp_scripts and not re.fullmatch(r"\d{4}_\d+", s)
    }
    index: list[str] = []
    tot_man = tot_fb = 0
    for script in sorted(emit):
        jp_txt = txt_entry(jp_data, script)
        en_txt = en_txts.get(script)
        mao = (manuscript_lines(mao_dir, script)
               if os.path.isdir(mao_dir) else None)
        ir, stats = build_script_ir(jp_txt, en_txt, mao)
        ir["script"] = script
        tot_man += stats["manuscript"]
        tot_fb += stats["fallback"]
        with open(os.path.join(ir_dir, script + ".json"), "w",
                  encoding="utf-8") as f:
            json.dump(ir, f, ensure_ascii=False, indent=1)
        index.append(script)
        if ir["warnings"]:
            print(f"      WARN {script}: {'; '.join(ir['warnings'])}")
    with open(os.path.join(ir_dir, "index.json"), "w",
              encoding="utf-8") as f:
        json.dump(index, f)
    print(f"ir: {len(index)} jp-spine scripts; display text: "
          f"{tot_man} manuscript + {tot_fb} en-token fallback")


if __name__ == "__main__":
    main()