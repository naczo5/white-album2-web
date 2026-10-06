"""Decode .bnr presentation records to per-event data (static, no game run).

Complements tools/build_bgm.py (which owns the proven (4,158) BGM opcode).
This module decodes the remaining LSCR idioms identified by static analysis
(see docs/PARSING.md):

- image show anchors: token indices matching .txt grp/bak cues (verified)
- fades: `5,3,{101,104,111} + 5,3,1000 + 6,16` (1000 = ms; shape consistent
  across scripts, semantics medium confidence)
- camera/zoom: `6,27 ... 5,4,FLOAT ... 6,18` (floats are seconds/magnitudes;
  medium confidence)

SE trigger shape notes: the ascending-integer-run shape
(1008_030.bnr body offsets 5029-5485, X in 447..817, each 1x, all < 1132
yet > token count) is documented in docs/PARSING.md, but a corpus-wide
filter catches JP token counters just as easily (false positives verified
during development), so value-range SE candidates are never emitted.
The true SE opcode is (4,164): statement [SE,255]+(4,164) (LSCR thunk
0x455720 -> SE channel allocator 0x406450; 12/12 corpus occurrences
address real SE.PAK numbers) and IS emitted below with conf="high".

Output: {version: 1, recs: {script: [{ev, se?, cam?, fadeMs?, conf}]}}
Only conf="high" records drive playback (fades + SE); anything weaker is
reference data the player ignores.
Usage:
  python3 decode_bnr.py MAIN_EN_PAK [SPECIAL_EN_PAK] OUT_JSON
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import kcap  # noqa: E402
import lzss  # noqa: E402
import parse_txt  # noqa: E402
from proto_bgm import find_se, iter_statements, load_bnr, s32  # noqa: E402


def decode_script(data: bytes, script: str) -> list[dict]:
    payload, _ = load_bnr(data, script)
    try:
        entries = {e.name: e for e in kcap.read_index(data)
                   if not e.is_folder}
        tentry = entries[script + ".txt"]
        txt = data[tentry.offset:tentry.offset + tentry.length]
        if tentry.is_compressed:
            orig, lz = lzss.split_datahdr(txt)
            txt = lzss.decompress(lz, orig)
        toks = parse_txt.split_tokens(txt)
        events, _ = parse_txt.parse_tokens(toks)
    except KeyError:
        events = []
    m = len(events)
    recs: list[dict] = []
    n = 0
    for idx, _off, _pushes, _ops, _raw, _floats in iter_statements(payload):
        n = idx + 1
    # SE plays (opcode (4,164), conf high) mapped fractionally like BGM.
    se_by_stmt = {r["stmt"]: r["se"] for r in find_se(payload)}
    for idx, off, pushes, ops, _raw, fl in iter_statements(payload):
        op_set = set(ops)
        frac = idx / max(1, n)
        ev = min(m - 1, int(frac * m)) if m else 0
        s = [s32(x) for x in pushes]
        if idx in se_by_stmt:
            recs.append({"ev": ev, "se": [se_by_stmt[idx]],
                         "conf": "high"})
        # Backdrops / event art: (4,146)/(4,147) [M,X,Y,F,...], (4,148).
        # X==0: bare fade (transition timing); X==-2: clear; else filename
        # stems (prefix resolved at lookup). 146/147 -> bak, 148 -> grp.
        has146 = any(o == 4 and a == 146 for o, a in ops)
        has147 = any(o == 4 and a == 147 for o, a in ops)
        has148 = any(o == 4 and a == 148 for o, a in ops)
        if (has146 or has147 or has148) and len(s) >= 4:
            _m, x, y, fade = s[0], s[1], s[2], s[3]
            if x == 0:
                if fade:
                    recs.append({"ev": ev, "fadeMs": fade, "conf": "high"})
            elif x == -2:
                recs.append({"ev": ev, "clear": True,
                             "layer": "grp" if has148 else "bak",
                             "conf": "high"})
            elif x > 0:
                recs.append({"ev": ev,
                             "layer": "grp" if has148 else "bak",
                             "stems": stem_candidates(x, y),
                             "fade": fade, "conf": "high"})
        # fade: mode push + 1000ms + CMD(6,16)
        if (6, 16) in op_set and 1000 in s:
            recs.append({"ev": ev, "fadeMs": 1000, "conf": "high"})
        # camera/zoom: CMD(6,27)..CMD(6,18) with float args
        if (6, 27) in op_set and (6, 18) in op_set and fl:
            zoom = next((f for f in fl if 0.5 <= f <= 4.0), None)
            dur = next((f for f in fl if 10.0 <= f <= 120.0), None)
            if zoom is not None:
                recs.append({"ev": ev,
                             "cam": {"zoom": round(zoom, 2),
                                     "dur": round(dur, 1) if dur else 1.0},
                             "conf": "hypothesis"})
    # de-dupe identical (ev, kind) rows, keep order
    seen: set[str] = set()
    out = []
    for r in recs:
        k = json.dumps(r, sort_keys=True)
        if k not in seen:
            seen.add(k)
            out.append(r)
    return out


def stem_candidates(x: int, y: int) -> list[str]:
    """Backdrop/event-art filename stems for a (4,146/147/148) X/Y pair.

    Verified against manifest hits: 6-digit zero-padded base from X+Y
    (1004,0 -> 100400; 1008,2 -> 100820; 10130,0 -> 101300; 20050,1 ->
    200501; 9900,0 -> 990000) plus the Y:02d form (1008,2 -> 100802).
    Prefix (b/v/tv) and bak-vs-overlay choice happen at lookup: the player
    tries candidates in order via the image manifest.
    """
    base = (str(x) + str(y)).ljust(6, "0")[:6]
    alt = str(x) + "%02d" % y
    stems = [base]
    if alt != base:
        stems.append(alt)
    return stems


def main() -> None:
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    *paks, out_path = sys.argv[1:]
    src: dict[str, bytes] = {}
    for pak_path in paks:
        with open(pak_path, "rb") as f:
            data = f.read()
        for e in kcap.read_index(data):
            if e.is_folder or not e.name.endswith(".bnr"):
                continue
            src[e.name[:-4]] = data
    recs = {}
    for script in sorted(src):
        rows = decode_script(src[script], script)
        if rows:
            recs[script] = rows
    n_high = sum(1 for v in recs.values() for r in v if r["conf"] == "high")
    n_hyp = sum(1 for v in recs.values() for r in v if r["conf"] != "high")
    print(f"bnr: {len(recs)} scripts, {n_high} high + {n_hyp} hypothesis recs")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "recs": recs}, f)
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
