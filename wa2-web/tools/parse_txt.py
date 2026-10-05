"""Parse Leaf WA2 scenario `.txt` token streams into a structured event IR.

Source format (verified on all 205 en.pak v1.3.6 scenario files):
    - bytes decoded as cp932 (Shift-JIS; ASCII-compatible English)
    - zero newlines per file; in-text breaks are literal backslash-n
    - comma-separated tokens; commas inside double quotes are literal
    - token kinds:
        ''                  noop / padding
        '"..."'             dialogue line (speaker = current latch)
        bare NAME           speaker latch when immediately followed by a
                            quoted token; otherwise narration
        bare text           narration
        'mvNN'              play movie NN
        '<img>.tga'         show image, followed by '' then layer token
                            'bak' (background) or 'grp' (graphics/sprite/CG)
        '<name>.AMP'        BGM cue (case-insensitive extension)
        '<name>.ani'        animation overlay cue
        'N. text'           choice option (consecutive run = one choice UI)
        'CATCH'/'CATCH2'/'CATCH3' [+ ids]
                            jump / branch marker. Following bare tokens that
                            are script ids (NNNN or NNNN_NNN) or voice-context
                            names are consumed as its argument list. A bare
                            script id with no CATCH (e.g. '2401','2501' right
                            after an option run) is an option destination:
                            option[i] (i>=1) -> ids[i-1], option 1 falls through.
        '<F..>'             inline font/size markup, kept with the text token

Output per script: dict with `events` list. Event shapes:
    {t:'say', speaker, text}        {t:'narrate', text}
    {t:'movie', id}                 {t:'image', file, layer}
    {t:'filter', file}              {t:'anim', file}
    {t:'choice', options:[{n, text, goto|None}]}
    {t:'jump', kind, targets:[...]} (unconditional or flag-conditional link)
    {t:'latch', name}               (explicit speaker-latch moments, debug aid)

`goto` resolution rule (documents engine behavior inferred from 2019.txt):
a choice run immediately followed by bare script-id tokens assigns those
ids to options 2..K+1 (option 1 = fall through). A CATCH/CATCH2/CATCH3
marker after a choice is preserved as its own `jump` event (branch targets
resolved per docs/FLOW_GRAPH.md; CATCH semantics need play-test
confirmation; only 2 of 176 CATCH sites sit at a file tail, so CATCH is
primarily a voice/sync marker, not flow).
"""

from __future__ import annotations

import json
import os
import re

SCRIPT_ID = re.compile(r"^[0-9]{4}(_[0-9]+)?$")
OPTION = re.compile(r"^([0-9]+)\.\s?(.*)$", re.DOTALL)
MOVIE = re.compile(r"^mv([0-9]+)$")
IMAGE = re.compile(r"^(.*)\.tga$", re.IGNORECASE)
BGM = re.compile(r"^(.*)\.amp$", re.IGNORECASE)
ANIM = re.compile(r"^(.*)\.ani$")
CATCH = re.compile(r"^CATCH[23]?$")
FONT_TAG = re.compile(r"<F[0-9]+[^>]*>")
# Whole-token engine style wrapper, angle or bracket form:
#   <F16"Weren't you...">  [F16"..."]  <F14'...'>  (F12..F28 sizes;
#   F16 = whisper-sized per MAO v2.1.0 reader: rendered italic)
STYLE_TOKEN = re.compile(r"^(?:<|\[)([FfSs])(\d*)\s*(.*?)(?:>|\])$",
                         re.DOTALL | re.IGNORECASE)

# --- Mega-token resplit (second pass) ---
# Quote parity breaks down around structural tokens, merging whole
# conversations (987 tokens across 153 files) into single tokens like:
#   "You've won...~,Setsuna,"Um~ well…",Haruki,"'I won't..."
# Fragments are recovered by splitting on structural shapes and
# `",Name,"` speaker-change markers (Name from the latch census).
STRUCT_SEG = re.compile(
    r"^(mv[0-9]+|[^,]*\.(?:tga|amp|ani)|bak|grp|CATCH[23]?|[0-9]+\..*"
    r"|[0-9]{4}(?:_[0-9]+)?)$", re.IGNORECASE)


def strip_style(tok: str) -> tuple[str, str | None]:
    """Split a whole-token style wrapper into (inner_text, style).

    style is 'whisper' for F16, else None (other F/S sizes render plain,
    matching MAO's web projection which strips non-F16 wrappers).
    Non-wrapper tokens return (tok, None).
    """
    m = STYLE_TOKEN.match(tok)
    if not m:
        return (tok, None)
    kind, size, inner = m.group(1).upper(), m.group(2), m.group(3)
    style = "whisper" if (kind == "F" and size == "16") else None
    inner = inner.strip()
    if len(inner) >= 2 and inner[0] in "\"'「" and inner[-1] in "\"'」":
        inner = inner[1:-1]
    return (inner, style)


def split_tokens(data: bytes) -> list[str]:
    """Decode cp932 and quote-aware split on commas."""
    text = data.decode("cp932")
    toks: list[str] = []
    cur: list[str] = []
    in_q = False
    for ch in text:
        if ch == '"':
            in_q = not in_q
            cur.append(ch)
        elif ch == "," and not in_q:
            toks.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    toks.append("".join(cur))
    return toks


def is_dialogue(tok: str) -> bool:
    if len(tok) < 2:
        return False
    if tok.startswith('"') and tok.endswith('"'):
        return True
    if tok.startswith("「") and tok.endswith("」"):
        return True
    if tok.startswith("『") and tok.endswith("』"):
        return True
    # An opening Japanese bracket without its close (F16 tails, page
    # debris): still spoken text, never narration (audit B2 residue).
    if tok.startswith(("「", "『")):
        return True
    # balanced single quotes: email/message text ('...'). Unbalanced
    # apostrophes ('cause, dogs') never match both sides.
    if len(tok) > 2 and tok.startswith("'") and tok.endswith("'"):
        return True
    return False


def strip_dialogue(tok: str) -> str:
    """Remove one layer of dialogue brackets (tolerates unbalanced tails)."""
    if tok.startswith(("\"", "'", "「", "『")):
        tok = tok[1:]
    if tok.endswith(("\"", "'", "」", "』")):
        tok = tok[:-1]
    return tok.strip().rstrip(">").strip()


def is_spoken(tok: str) -> bool:
    """True for quoted lines and style-wrapped spoken lines (<F16"...">)."""
    if is_dialogue(tok):
        return True
    m = STYLE_TOKEN.match(tok)
    if not m:
        return False
    inner = m.group(3).strip()
    if inner[:1] in ("\"", "'", "「", "『"):
        return True
    # unbalanced-quote dialogue fragment (leading \n debris from \k pages)
    while inner.startswith("\\n") or inner.startswith("\\k"):
        inner = inner[2:].lstrip()
    return inner[:1] in ("\"", "'", "「", "『")


def valid_name(tok: str) -> bool:
    """Speaker-latch validation (audit B1: narration must not latch).

    Rejects anything containing engine markup debris (backslash sequences,
    quotes) or longer than a real display name. `…`/`???` pass (genuine
    unattributed beats) but never enter the mega census (audit B4).
    """
    t = tok.strip()
    if not t or len(t) > 28:
        return False
    if t == "???":
        return True  # explicit unknown-speaker tag (engine-real)
    import re as _re
    if not _re.search(r"[\w\u3040-\u30ff\u4e00-\u9faf]", t):
        # pure punctuation pause beat (…, ………, --): renders as its own
        # line, never latches, never enters the census (audit B4)
        return False
    # sentence punctuation never appears in display names (audit B1:
    # narration fragments like "And then~ she declared:" must not latch)
    if _re.search(r"[~.,:;!?…～'\"\\<>\[\]]", t):
        return False
    return True


def census_name(tok: str) -> bool:
    return valid_name(tok) and tok.strip() not in ("…", "--")


def classify_bare(tok: str) -> str:
    """Classify a bare (unquoted, non-empty) token by shape."""
    if CATCH.match(tok):
        return "catch"
    if OPTION.match(tok):
        return "option"
    if MOVIE.match(tok):
        return "movie"
    if IMAGE.match(tok):
        return "image"
    if BGM.match(tok):
        return "filter"
    if ANIM.match(tok):
        return "anim"
    if SCRIPT_ID.match(tok):
        return "script_id"
    if tok in ("bak", "grp"):
        return "layer"
    return "text"


def parse_tokens(toks: list[str]) -> tuple[list[dict], list[str]]:
    events: list[dict] = []
    warnings: list[str] = []
    latch = ""
    i = 0
    n = len(toks)
    while i < n:
        tok = toks[i]
        if tok == "":
            i += 1
            continue
        if is_dialogue(tok):
            events.append({"t": "say", "speaker": latch,
                           "text": strip_dialogue(tok), "tok": i})
            i += 1
            continue
        inner, style = strip_style(tok)
        if style is not None or inner != tok:
            # Whole-token style wrapper: content keeps dialogue status when
            # it reads as a spoken line (heuristic: a speaker is latched).
            # F16 (whisper size) is recorded; other sizes render plain.
            if latch and is_spoken(tok):
                events.append({"t": "say", "speaker": latch, "tok": i,
                               "text": inner,
                               **({"style": style} if style else {})})
            else:
                events.append({"t": "narrate", "tok": i, "text": inner,
                               **({"style": style} if style else {})})
            i += 1
            continue
        kind = classify_bare(tok)
        if kind == "movie":
            events.append({"t": "movie", "id": tok})
        elif kind == "filter":
            # .AMP files are image color-grade LUTs (sepia/nega/night/...),
            # NOT music: fullscreen filter applied from this point on.
            events.append({"t": "filter", "file": tok})
        elif kind == "anim":
            layer = None
            j = i + 1
            while j < n and toks[j] == "":
                j += 1
            if j < n and toks[j] in ("bak", "grp"):
                layer = toks[j]
                i = j  # consume layer token; loop's i+=1 moves past
            events.append({"t": "anim", "file": tok, "layer": layer})
        elif kind == "image":
            layer = None
            j = i + 1
            while j < n and toks[j] == "":
                j += 1
            if j < n and toks[j] in ("bak", "grp"):
                layer = toks[j]
                i = j  # consume layer token; loop's i+=1 moves past
            else:
                warnings.append(f"token {i}: image {tok} without layer token")
            events.append({"t": "image", "file": tok, "layer": layer})
        elif kind == "option":
            opts: list[dict] = []
            while i < n and classify_bare(toks[i]) == "option":
                m = OPTION.match(toks[i])
                assert m is not None
                opts.append({"n": int(m.group(1)), "text": m.group(2), "goto": None})
                i += 1
            # lookahead: bare script ids = option destinations (opt1 falls through)
            ids: list[str] = []
            while i < n and classify_bare(toks[i]) == "script_id":
                ids.append(toks[i])
                i += 1
            for k, sid in enumerate(ids):
                if k + 1 < len(opts):
                    opts[k + 1]["goto"] = sid
                else:
                    warnings.append(f"token {i}: excess jump target {sid}")
                    events.append({"t": "jump", "kind": "fallthrough", "targets": [sid]})
            if len(opts) != len({o["n"] for o in opts}):
                warnings.append(f"token {i}: duplicate option numbers")
            events.append({"t": "choice", "options": opts})
            continue  # i already advanced
        elif kind == "catch":
            targets: list[str] = []
            j = i + 1
            # Consume a run of script ids (jump/branch target list). A single
            # bare name token immediately followed by dialogue is a voice-
            # context arg (e.g. CATCH,Chikashi,"..."). Anything else is left
            # for the main loop so narration is never swallowed into targets.
            while j < n and classify_bare(toks[j]) == "script_id":
                targets.append(toks[j])
                j += 1
            if (j < n and toks[j] != "" and not is_dialogue(toks[j])
                    and classify_bare(toks[j]) == "text"
                    and valid_name(toks[j])
                    and j + 1 < n and is_spoken(toks[j + 1])):
                targets.append(toks[j])
                j += 1
            events.append({"t": "jump", "kind": tok, "targets": targets})
            i = j
            continue
        elif kind == "script_id":
            events.append({"t": "jump", "kind": "bare", "targets": [tok]})
        elif kind == "layer":
            warnings.append(f"token {i}: stray layer token {tok}")
            events.append({"t": "layer", "layer": tok})
        else:  # text: speaker latch or narration
            if i + 1 < n and is_spoken(toks[i + 1]):
                if valid_name(tok):
                    latch = tok
                    events.append({"t": "latch", "name": tok})
                else:
                    # audit B1: narration masquerading as a speaker (long /
                    # markup-debris tokens). Keep the text, drop the claim.
                    events.append({"t": "narrate", "tok": i, "text": tok})
                    latch = ""
            else:
                events.append({"t": "narrate", "tok": i, "text": tok})
        i += 1
    return (events, warnings)


def parse_file(path: str, names: set[str] | None = None) -> dict:
    with open(path, "rb") as f:
        data = f.read()
    toks = split_tokens(data)
    events, warnings = parse_tokens(toks)
    if names is None:
        # internal two-pass: validated census from this file's own latches
        names = {e["name"] for e in events if e["t"] == "latch"
                 and census_name(e["name"])}
    events, warnings = resplit_mega(events, names, warnings)
    events, warnings = merge_adjacent_choices(events, warnings)
    name = os.path.basename(path)
    return {
        "script": name[:-4] if name.endswith(".txt") else name,
        "tokens": len(toks),
        "events": events,
        "warnings": warnings,
    }


def merge_adjacent_choices(events, warnings):
    """Merge choice events with nothing between them (inline options split
    by speaker tags render as one choice UI)."""
    out = []
    for e in events:
        if e["t"] == "choice" and out and out[-1]["t"] == "choice":
            prev = out[-1]
            nums = {o["n"] for o in prev["options"]}
            for o in e["options"]:
                if o["n"] in nums:
                    warnings.append("duplicate option number in merge")
                prev["options"].append(o)
            prev["options"].sort(key=lambda o: o["n"])
            warnings.append("merged adjacent choice events into one UI")
        else:
            out.append(e)
    return out, warnings


def clean_frag(s: str) -> str:
    r"""Strip splitter debris: edge commas/spaces, literal \n \k breaks,
    and one unbalanced edge quote (audit B3)."""
    s = s.strip()
    while True:
        changed = False
        for seq in ("\\n", "\\k"):
            if s.startswith(seq):
                s = s[len(seq):].lstrip()
                changed = True
            if s.endswith(seq):
                s = s[:-len(seq)].rstrip()
                changed = True
        ns = s.strip(",").strip()
        if ns != s:
            s = ns
            changed = True
        if not changed:
            break
    if s.startswith('"') and not s.endswith('"'):
        s = s[1:]
    elif s.endswith('"') and not s.startswith('"'):
        s = s[:-1]
    return s.strip().strip(",").strip()


def resplit_mega(events: list[dict], names: set[str],
                 warnings: list[str]) -> tuple[list[dict], list[str]]:
    """Split mega say/narrate events into dialogue/stage/narration fragments.

    Quote parity breaks down around structural tokens, merging whole
    conversations (987 tokens across 153 files) into single tokens like:
      "You've won...~,Setsuna,"Um~ well…",Haruki,"'I won't..."
    Fragments recover one engine display unit each: dialogue fragments
    (quoted) become say events with latch tracking, structural segments
    become stage/jump events, and the rest become narration (one per
    comma-piece, \\n kept as in-box breaks). Events without structural
    shapes or `",Name,"` speaker markers pass through byte-identical.
    Returns (new_events, warnings).
    """
    if not names:
        return events, warnings
    name_pat = re.compile(r",\s*(" + "|".join(
        sorted(re.escape(n) for n in names if n)) + r")\s*,")
    out: list[dict] = []
    pending_opts: list[dict] = []
    latch = ""

    def flush_opts():
        if pending_opts:
            out.append({"t": "choice", "options": [
                {"n": o["n"], "text": o["text"], "goto": None}
                for o in pending_opts]})
            warnings.append(f"MEGA_CHOICE: {len(pending_opts)} options "
                            f"recovered inside a mega-token (verify in game)")
            pending_opts.clear()

    def emit_frags(page, style, tok):
        # cut on structural segments first (directives/ids/options/layers)
        segs = []
        for piece in page.split(","):
            s = piece.strip()
            if s and STRUCT_SEG.match(s):
                segs.append("\x00" + s)  # marker: structural
            else:
                segs.append(piece)
        # then on `,Name,` speaker markers inside the remaining text
        frags = []
        for s in segs:
            if s.startswith("\x00"):
                frags.append(s)
                continue
            parts = name_pat.split("," + s + ",")
            for i, p in enumerate(parts):
                if i % 2 == 1:
                    frags.append("\x01" + p)  # marker: latch name
                elif p:
                    frags.append(p)
        # repair image/anim + layer adjacency lost by the comma split;
        # also reattach CATCH voice-context names (audit B4: CATCH,<name>
        # keeps the name as a jump target AND a latch for what follows)
        merged = []
        i = 0
        while i < len(frags):
            f = frags[i]
            if (f.startswith("\x00") and (
                    IMAGE.match(f[1:]) or ANIM.match(f[1:]))):
                j = i + 1
                while j < len(frags) and not frags[j].strip().strip(","):
                    j += 1
                if j < len(frags) and frags[j].startswith("\x00") and \
                        frags[j][1:] in ("bak", "grp"):
                    merged.append(f + "\x00" + frags[j][1:])
                    i = j + 1
                    continue
            if f.startswith("\x00") and CATCH.match(f[1:]):
                j = i + 1
                while j < len(frags) and not frags[j].strip().strip(","):
                    j += 1
                if j < len(frags) and frags[j].startswith("\x01"):
                    merged.append(f + "\x00" + frags[j][1:])
                    merged.append(frags[j])
                    i = j + 1
                    continue
            merged.append(f)
            i += 1
        for f in merged:
            emit_frag(f, style, tok)

    def emit_frag(f, style, tok):
        nonlocal latch
        if not f.strip().strip(","):
            return
        if f.startswith("\x01"):
            flush_opts()
            latch = f[1:]
            out.append({"t": "latch", "name": latch})
            return
        if f.startswith("\x00"):
            flush_opts()
            body = f[1:]
            if "\x00" in body and CATCH.match(body.split("\x00")[0]):
                # reattached voice-context name: target + latch both kept
                mark, voice = body.split("\x00")
                out.append({"t": "jump", "kind": mark, "targets": [voice]})
                return  # the latch frag itself follows in the stream
            if "\x00" in body:  # image+layer pair
                img, layer = body.split("\x00")
                kind = "image" if IMAGE.match(img) else "anim"
                out.append({"t": kind, "file": img, "layer": layer})
                return
            sub, w = structural_event(body, latch)
            if w:
                warnings.append(w)
            if isinstance(sub, list):
                out.extend(sub)
            elif sub is not None:
                if sub.get("t") == "_opt":
                    pending_opts.append(sub)
                else:
                    out.append(sub)
            return
        c = clean_frag(f)
        if not c:
            return
        # Dialogue iff the fragment opens a quote or carries an
        # unbalanced one (writer style: closing quotes often belong
        # to the next fragment's speaker marker).
        q = c.count('"') + c.count("「")
        if c.startswith(('"', "'", "「")) or q % 2 == 1:
            flush_opts()
            say_text = strip_dialogue(c)
            ent = {"t": "say", "speaker": latch, "text": say_text,
                 "tok": tok}
            if style:
                ent["style"] = style
            out.append(ent)
        else:
            flush_opts()
            nent = {"t": "narrate", "text": c, "tok": tok}
            if style:
                nent["style"] = style
            out.append(nent)

    for e in events:
        if e["t"] == "latch":
            flush_opts()
            latch = e["name"]
            out.append(e)
            continue
        if e["t"] not in ("say", "narrate"):
            flush_opts()
            out.append(e)
            continue
        text = e["text"]
        style = e.get("style")
        # engine page breaks (\k) are hard display boundaries: each piece
        # is its own unit (fixes \k-joined dialogue megas like 5104's
        # `"Morning~ Io~ Takeya."\k\n"…"\k\n…`).
        pages = [p for p in text.split("\\k") if p.strip().strip(",")]
        if len(pages) <= 1:
            struct_hit = any(STRUCT_SEG.match(s.strip())
                             for s in text.split(","))
            name_hit = bool(name_pat.search("," + text + ","))
            if not (struct_hit or name_hit):
                flush_opts()
                out.append(e)
                continue
            emit_frags(text, style, e.get("tok"))
        else:
            for page in pages:
                struct_hit = any(STRUCT_SEG.match(s.strip())
                                 for s in page.split(","))
                name_hit = bool(name_pat.search("," + page + ","))
                if not (struct_hit or name_hit):
                    # plain page: keep say/narrate type by quote rule
                    c = clean_frag(page)
                    if c.startswith(('"', "'", "「")):
                        flush_opts()
                        out.append({"t": "say", "speaker": latch,
                                    "text": c[1:-1] if len(c) >= 2 else c,
                                    "tok": e.get("tok"),
                                    **({"style": style} if style else {})})
                    else:
                        flush_opts()
                        out.append({"t": "narrate", "text": c,
                                    "tok": e.get("tok"),
                                    **({"style": style} if style else {})})
                else:
                    emit_frags(page, style, e.get("tok"))
    flush_opts()
    return out, warnings


def structural_event(seg: str, latch: str) -> tuple:
    """Classify a structural segment found inside a mega-token."""
    s = seg.strip()
    if MOVIE.match(s):
        return {"t": "movie", "id": s}, ""
    if IMAGE.match(s):
        # layer token usually follows as its own segment; mega form keeps
        # them adjacent (tga,,grp) but the comma-split lost adjacency, so
        # layer resolves as unknown here and is repaired by fixup below.
        return {"t": "image", "file": s, "layer": None}, ""
    if BGM.match(s):
        return {"t": "filter", "file": s}, ""
    if ANIM.match(s):
        return {"t": "anim", "file": s, "layer": None}, ""
    if CATCH.match(s):
        return {"t": "jump", "kind": s, "targets": []}, ""
    if SCRIPT_ID.match(s):
        return {"t": "jump", "kind": "bare", "targets": [s]}, ""
    if s in ("bak", "grp"):
        return {"t": "layer", "layer": s}, ""
    m = OPTION.match(s)
    if m:
        return {"t": "_opt", "n": int(m.group(1)),
                "text": m.group(2)}, ""
    return None, f"unresolved structural segment {s!r}"


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help=".txt file or directory")
    ap.add_argument("out", help="output .json file or directory")
    args = ap.parse_args()
    if os.path.isdir(args.src):
        os.makedirs(args.out, exist_ok=True)
        files = sorted(f for f in os.listdir(args.src) if f.endswith(".txt"))
        # pass 1 (no resplit): corpus-wide latch census for mega resolution
        census: set[str] = set()
        cache: dict[str, tuple[list[str], list[dict]]] = {}
        for fn in files:
            with open(os.path.join(args.src, fn), "rb") as f:
                toks = split_tokens(f.read())
            events, _ = parse_tokens(toks)
            census.update(e["name"] for e in events if e["t"] == "latch"
                             and census_name(e["name"]))
            cache[fn] = (toks, events)
        print(f"latch census: {len(census)} names")
        index = []
        for fn in files:
            toks, events = cache[fn]
            warnings: list = []
            events, warnings = resplit_mega(events, census, warnings)
            events, warnings = merge_adjacent_choices(events, warnings)
            ir = {"script": fn[:-4], "tokens": len(toks),
                  "events": events, "warnings": warnings}
            with open(os.path.join(args.out, fn[:-4] + ".json"), "w", encoding="utf-8") as f:
                json.dump(ir, f, ensure_ascii=False, indent=1)
            index.append({"script": ir["script"], "tokens": ir["tokens"],
                          "events": len(ir["events"]), "warnings": len(ir["warnings"])})
        with open(os.path.join(args.out, "index.json"), "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=1)
        print(f"parsed {len(files)} scripts -> {args.out}")
    else:
        ir = parse_file(args.src)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(ir, f, ensure_ascii=False, indent=1)
        print(f"{ir['script']}: {ir['tokens']} tokens, "
              f"{len(ir['events'])} events, {len(ir['warnings'])} warnings")


if __name__ == "__main__":
    main()
