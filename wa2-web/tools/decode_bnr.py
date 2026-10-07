r"""Decode .bnr presentation records to per-event data (static, no game run).

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
Ambient channel playback is (4,165) [ch, se, fade_ms, loop, vol, ?]
(0x40f400; 99% of ids are SE.PAK numbers), stopped by (4,166) [ch,0];
both emitted with conf="high" (see docs/PARSING.md).
Standing sprites are (4,154)/(4,155) [prefix_id, face, base, ...] ->
char\{prefix}{base+face:06d}.tga; face 4000 hides the slot. Proven by
exe disassembly + corpus file-existence check (14315/14319); emitted as
spr/sprHide recs with conf="high" (docs/PARSING.md).

Output: {version: 1, recs: {script: [{ev, se?, amb?, ambStop?, cam?,
fadeMs?, conf}]}}
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
import bnr_anchor  # noqa: E402
from proto_bgm import find_se, iter_statements, load_bnr, s32  # noqa: E402

JPGAME: bytes | None = None


def decode_script(data: bytes, script: str) -> list[dict]:
    payload, _ = load_bnr(data, script)
    # Exact anchors via the JP token spine (bnr_anchor): the stream's
    # (4,131)/(4,144) line labels carry JP token coordinates; a record
    # belongs to the next label at-or-after it. Falls back to fractional
    # placement when no --jp spine is available.
    events: list[dict] = []
    anchors: list[int] | None = None
    if JPGAME is not None:
        try:
            e = {x.name: x for x in kcap.read_index(JPGAME)
                 if not x.is_folder}[script + ".txt"]
            txt = JPGAME[e.offset:e.offset + e.length]
            if e.is_compressed:
                orig, lz = lzss.split_datahdr(txt)
                txt = lzss.decompress(lz, orig)
            events = bnr_anchor.jp_spine_events(txt)
        except KeyError:
            events = []
        if events and bnr_anchor.has_sync(payload):
            anchors = bnr_anchor.anchor_stmts(
                payload, bnr_anchor.next_event_map(events))
    if anchors is None:
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
    # SE plays (opcode (4,164), conf high) mapped like BGM.
    se_by_stmt = {r["stmt"]: r["se"] for r in find_se(payload)}
    for idx, off, pushes, ops, _raw, fl in iter_statements(payload):
        op_set = set(ops)
        if anchors is not None:
            ev = anchors[idx]
        else:
            frac = idx / max(1, n)
            ev = min(m - 1, int(frac * m)) if m else 0
        s = [s32(x) for x in pushes]
        if idx in se_by_stmt:
            recs.append({"ev": ev, "se": [se_by_stmt[idx]],
                         "conf": "high"})
        # Ambient/channel SE (opcode (4,165)): [ch, se_id, fade_ms, loop,
        # volume, ?] -> thunk chain 0x40f400 (6 args); 645/646 distinct
        # ids exist as SE_%04d in SE.PAK (99%, conf high). Volume is the
        # raw 0-255 push. Zero-volume (4,166) [ch,0] stops the channel;
        # the skip-guarded (4,168) stop is deliberately not emitted.
        has165 = any(o == 4 and a == 165 for o, a in ops)
        has166 = any(o == 4 and a == 166 for o, a in ops)
        if has165 and len(s) >= 5:
            recs.append({"ev": ev,
                         "amb": {"se": s[1], "ch": max(0, min(3, s[0])),
                                 "vol": s[4], "loop": bool(s[3])},
                         "conf": "high"})
        elif has166 and len(s) >= 2 and s[1] <= 0:
            recs.append({"ev": ev, "ambStop": max(0, min(3, s[0])),
                         "conf": "high"})
        # Standing sprites (4,154)/(4,155): [pid, face, base, pos, ...].
        # WA2.exe: handlers 0x4553f0/0x455590 -> 0x4160e0 -> filename
        # sprintf("%s%06d.tga", table[prefix_id], file) under char\ ;
        # corpus proof: base+face hits a real char.pak file for
        # 14315/14319 statements (docs/PARSING.md). Slot records are keyed
        # by character id (0x402220 scans the 8 slot records comparing the
        # id), so a new show of the same char moves/changes it and the
        # previous pose is replaced. arg3 is the screen position index:
        # stored to record+8 (dedupe-compared at 0x416189) and resolved to
        # an x-offset via exe table 0x4be0bc: [-288, 0, 288, -384, 384,
        # -480, 480, -480, -160, 160, 480] px on the 1280-wide stage.
        # face==4000 hides the slot (1008_030 tail hides kaz/set/koh this
        # way). The 38-entry prefix table below is the exe's stack table
        # (0x4a2904..0x4a2980, built at 0x415bf8); ids 6-9 are dud entries
        # ('a'/uninit) and never occur in the corpus. Bases < 100 only
        # occur in the LF3 digital novel (3 statements) and are ignored as
        # malformed.
        has154 = any(o == 4 and a == 154 for o, a in ops)
        has155 = any(o == 4 and a == 155 for o, a in ops)
        if (has154 or has155) and len(s) >= 3:
            pid, face, base = s[0], s[1], s[2]
            prefix = SPRITE_PREFIXES.get(pid)
            if prefix:
                if face == 4000:
                    recs.append({"ev": ev, "sprHide": pid, "conf": "high"})
                elif base >= 100:
                    pos = s[3] if len(s) >= 4 and 0 <= s[3] <= 10 else None
                    recs.append({"ev": ev,
                                 "spr": {"id": pid,
                                         "stem": "%s%06d" % (prefix,
                                                             base + face),
                                         "pos": pos},
                                 "conf": "high"})
        # Sprite hides: (4,156) [pid, mode, param] and (4,157) [pid] both
        # call the shared sprite-clear routine 0x402610(pid, mode, param)
        # (handlers 0x4555e0/0x455640; 0x402220 finds the char's slot,
        # 8 = absent -> no-op). 175+553 corpus occurrences; emitted with
        # conf="high". This is how characters exit the stage.
        has156 = any(o == 4 and a == 156 for o, a in ops)
        has157 = any(o == 4 and a == 157 for o, a in ops)
        if (has156 or has157) and s:
            recs.append({"ev": ev, "sprHide": s[0], "conf": "high"})
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
                             "sprClear": not has148,
                             "conf": "high"})
            elif x > 0:
                recs.append({"ev": ev,
                             "layer": "grp" if has148 else "bak",
                             "stems": stem_candidates(x, y),
                             "fade": fade,
                             # A backdrop show wipes standing sprites: the
                             # image primitive 0x4167e0 reaches the clear-all
                             # sprite loop 0x402680 (corpus: every sprite
                             # burst re-shows after a bak change; per-script
                             # maxima drop from 11 to <=5 under this model).
                             "sprClear": not has148,
                             "conf": "high"})
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


# Standing-sprite prefix table, proven from WA2.exe .rdata strings
# (0x4a2904..0x4a2980) + the stack array built at 0x415bf8 (slot i holds
# string ptr 0x4a2980-4*i; ids 6-9 are 'a'/uninitialized dud slots and
# never appear as (4,154)/(4,155) push values corpus-wide).
SPRITE_PREFIXES = {
    0: "har", 1: "kaz", 2: "set", 3: "koh", 4: "izu", 5: "mar",
    10: "tak", 11: "ioo", 12: "chi", 13: "pap", 14: "mam", 15: "oto",
    16: "you", 17: "tan", 18: "shi", 19: "tom", 20: "sat", 21: "hon",
    22: "nak", 23: "say", 24: "aco", 25: "mih", 26: "mhh", 27: "ueh",
    28: "yos", 29: "tan", 30: "ham", 31: "mat", 32: "kiz", 33: "suz",
    34: "saw", 35: "miy", 36: "yan",
}


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
    argv = sys.argv[1:]
    jp_path = None
    i = 0
    while i < len(argv):
        if argv[i] == "--jp":
            jp_path = argv[i + 1]
            del argv[i:i + 2]
        else:
            i += 1
    *paks, out_path = argv
    global JPGAME
    if jp_path:
        with open(jp_path, "rb") as f:
            JPGAME = f.read()
        print(f"bnr: exact anchors via {jp_path}")
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
