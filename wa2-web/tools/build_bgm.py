"""Build BGM cue table from en.pak .bnr bytecode (static, no game run).

Finding (tools/proto_bgm_report.md): LSCR statement with opcode (4,158)
is a BGM play; pushes[0] = track (BGM_%03d; engine derives _a/_b loop
pair or solo file); pushes[1] = fade. Shape (-2,1,255)+(4,5),(3,X),(4,158)
is an explicit stop (rare; engine otherwise sustains BGM across files).

Placement: .bnr statements are segemented on (6,30); each play's fractional
position (stmt/n_stmts) is snapped to the EN IR event index (frac * m).
Accurate to the scene (bak), +/- few lines within it: .bnr (3,X) counters
follow the JP token stream, EN tokens drifted in translation.

Output (build artifact, NOT committed game content - only track numbers +
event indices, like flow.json option labels):
  {version: 1, cues: {script: [{ev, track?, stop?, fade?}, ...]}}
Files with no cue inherit prior BGM (player must NOT stop on file change).

Usage:
  python3 build_bgm.py MAIN_EN_PAK [SPECIAL_EN_PAK] OUT_JSON
  python3 build_bgm.py --selftest   (synthetic opcode check, no game)
"""

from __future__ import annotations

import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import kcap  # noqa: E402
import lzss  # noqa: E402
import parse_txt  # noqa: E402
from proto_bgm import code_off, find_bgm, load_bnr  # noqa: E402


def scene_events(txt_payload: bytes):
    toks = parse_txt.split_tokens(txt_payload)
    events, _ = parse_txt.parse_tokens(toks)
    return events


def track_set(game_dir: str | None) -> set[int]:
    """Track numbers present in main + IC BGM.PAKs (XOR-0xFF names)."""
    import glob as _glob
    have: set[int] = set()
    if not game_dir:
        return have
    for pak in [os.path.join(game_dir, "BGM.PAK"),
                os.path.join(game_dir, "IC", "BGM.PAK")]:
        for p in _glob.glob(pak):
            try:
                with open(p, "rb") as f:
                    data = f.read()
                if data[:4] != b"LAC\x00":
                    continue
                (count,) = struct.unpack_from("<I", data, 4)
                for i in range(count):
                    raw = data[8 + i * 40:8 + i * 40 + 24]
                    s = bytes(b ^ 0xFF for b in raw.split(b"\x00")[0])
                    try:
                        have.add(int(s.decode().split("_")[1]))
                    except (ValueError, IndexError):
                        pass
            except OSError:
                pass
    return have


def build(paks: list[str], game_dir: str | None = None) -> dict:
    with open(paks[0], "rb") as f:
        main = f.read()
    # script -> (pak_data, wins): later paks override (mirrors build.py)
    src: dict[str, bytes] = {}
    for pak_path in paks:
        with open(pak_path, "rb") as f:
            data = f.read()
        for e in kcap.read_index(data):
            if e.is_folder or not e.name.endswith(".bnr"):
                continue
            src[e.name[:-4]] = data
    _ = main
    have = track_set(game_dir)
    cues: dict[str, list[dict]] = {}
    n_play = n_stop = 0
    missing_tracks: set[int] = set()
    for script in sorted(src):
        data = src[script]
        try:
            payload, _entry = load_bnr(data, script)
        except KeyError:
            continue
        plays, stops, n = find_bgm(payload)
        # EN events for fractional snapping
        try:
            entries = {e.name: e for e in kcap.read_index(data)
                       if not e.is_folder}
            tentry = entries[script + ".txt"]
            txt = data[tentry.offset:tentry.offset + tentry.length]
            if tentry.is_compressed:
                orig, lz = lzss.split_datahdr(txt)
                txt = lzss.decompress(lz, orig)
            events = scene_events(txt)
        except KeyError:
            events = []
        m = len(events)
        rows: list[dict] = []
        for p in plays:
            frac = p["stmt"] / max(1, n)
            ev = min(m - 1, int(frac * m)) if m else 0
            if p["track"] == 0:
                # Track 0 = silence/pause (cf. exe "BGM-PAUSE"): normalize
                # to an explicit stop so the player never looks for a file.
                rows.append({"ev": ev, "stop": True})
                n_stop += 1
                continue
            row: dict = {"ev": ev, "track": p["track"],
                         "fade": p["fade"]}
            if have and p["track"] not in have:
                row["missing"] = True
                missing_tracks.add(p["track"])
            rows.append(row)
            n_play += 1
        for s in stops:
            frac = s["stmt"] / max(1, n)
            ev = min(m - 1, int(frac * m)) if m else 0
            rows.append({"ev": ev, "stop": True})
            n_stop += 1
        rows.sort(key=lambda r: r["ev"])
        if rows:
            cues[script] = rows
    print(f"bgm: {len(cues)} scripts, {n_play} plays, {n_stop} stops")
    if missing_tracks:
        print(f"bgm: tracks cued but absent from BGM.PAKs: {sorted(missing_tracks)} "
              f"(player sustains previous BGM; see docs/QA.md)")
    return {"version": 1, "cues": cues}


def selftest() -> None:
    import struct
    # synthetic stream: 3 statements, middle one is a (4,158) play track 7
    def stmt(words):
        return words + [6, 30]
    words = stmt([5, 3, 1]) + stmt([5, 3, 7, 5, 3, -2 & 0xFFFFFFFF,
                                    5, 3, 1, 5, 3, 255, 4, 158]) + stmt([5, 3, 9])
    payload = b"LSCR" + struct.pack("<II", 0x14, 0) + b"\x00" * 16 + \
        struct.pack(f"<{len(words)}I", *words)
    plays, stops, n = find_bgm(payload)
    assert n == 3, n
    assert len(plays) == 1 and plays[0]["track"] == 7, plays
    assert not stops
    print("build_bgm selftest ok")


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "--selftest":
        selftest()
        return
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    import argparse as _ap
    ap = _ap.ArgumentParser(description="build bgm.json from en.pak .bnr")
    ap.add_argument("paks", nargs="+",
                    help="MAIN_EN_PAK [SPECIAL_EN_PAK] OUT_JSON")
    ap.add_argument("--game", default=None,
                    help="installed game dir (for BGM.PAK availability flags)")
    args = ap.parse_args()
    *paks, out = args.paks
    table = build(paks, args.game)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(table, f)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
