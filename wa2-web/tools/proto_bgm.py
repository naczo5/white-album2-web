"""Prototype BGM scene->track extractor (static only, no game execution).

Finding (see report in __doc__ tail / tools/proto_bgm_report.md):
  LSCR bytecode statement containing opcode (4,158) == BGM play.
  pushes[0] = track number (BGM_%03d; engine derives _a/_b loop pair).
  pushes[1] = fade/mode (-2 = default, else ms-ish 0/1/2/60/120/180/240).
  pushes[2..3] ~= (1, 255|0|30|128|200) (channel/volume-ish, not decoded).
  Variant shape pushes+(6,23),(4,158) is also a play (same arg0 = track).
  Shape (-2,1,255)+(4,5),(3,X),(4,158) is a BGM stop (rare; X = JP tok).

Provenance:
  exe  WA2.exe  fn 0x4068a0 formats "BGM_%03d[.ogg|_a.ogg|_b.ogg]" from its
  int arg0 (sprintf at 0x4069af..406a53); wrapper 0x40fb80 range-checks
  arg0 <= 199 (0x40fb85: cmpl $0xc7) and forwards the LSCR stack array
  (0x423d3b: push ebx,1,edx,eax,-2,ecx -> call 0x40fb80, where the -2 and 1
  constants match the bnr push pattern [track,-2,1,255]).
  Corpus check: all 40+2 distinct pushes[0] values across 206+49 bnr files
  are within BGM.PAK's number set; nothing outside 0..79 ever appears.

Usage:
  python3 proto_bgm.py EN_PAK SCRIPT [SCRIPT ...] [--bgm-pak BGM.PAK]
  e.g. python3 proto_bgm.py /tmp/opencode/wa2v21/en.pak 2001 2019 2301
"""

from __future__ import annotations

import argparse
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import kcap  # noqa: E402
import lzss  # noqa: E402
import parse_txt  # noqa: E402

NEG2 = 0xFFFFFFFF - 1  # 0xFFFFFFFE (-2)
OP_BGM = 158
OP_SE = 164
TRACK_MAX_EXE = 199  # exe 0x40fb85 bound (real tracks: 1..79 per BGM.PAK)
SE_VOL = 255  # pushes[1] of every (4,164) statement (cf. exe push 0xff)


def code_off(payload: bytes) -> int:
    """Byte offset where the u32 statement stream starts."""
    if payload[4] == 0x44:  # LSCRD: 68-byte section table; main code = last section
        nsec = struct.unpack_from("<I", payload, 8)[0]
        offs = [struct.unpack_from("<I", payload, 12 + i * 8 + 4)[0]
                for i in range(nsec)]
        return offs[-1]
    return 28  # LSCR 0x14 / 0x1c: single-section code at 28


def iter_statements(payload: bytes):
    """Yield (idx, byte_off, pushes, ops, raw, floats) split on (6,30).

    pushes = (5,3,X) int pushes; floats = (5,4,F) float pushes (camera
    magnitudes/durations); ops = (2|3|4|6, arg) pairs."""
    base = code_off(payload)
    code = payload[base:]
    n = len(code) // 4
    vals = list(struct.unpack_from(f"<{n}I", code, 0))
    idx = 0
    cur: list[int] = []
    start = 0  # u32-index of statement start
    for k, v in enumerate(vals):
        cur.append(v)
        if len(cur) >= 2 and cur[-2] == 6 and cur[-1] == 30:
            body = cur[:-2]
            pushes: list[int] = []
            floats: list[float] = []
            ops: list[tuple[int, int]] = []
            raw = 0
            i = 0
            while i < len(body):
                if body[i] == 5 and i + 2 < len(body) and body[i + 1] == 3:
                    pushes.append(body[i + 2])
                    i += 3
                elif body[i] == 5 and i + 2 < len(body) and body[i + 1] == 4:
                    floats.append(struct.unpack("<f", struct.pack("<I", body[i + 2]))[0])
                    i += 3
                elif body[i] in (2, 3, 4, 6) and i + 1 < len(body):
                    ops.append((body[i], body[i + 1]))
                    i += 2
                else:
                    raw += 1
                    i += 1
            yield (idx, base + start * 4, pushes, ops, raw, floats)
            idx += 1
            cur = []
            start = k + 1
    # trailing words without terminator (should be empty)


def s32(u: int) -> int:
    return u - 0x100000000 if u >= 0x80000000 else u


def find_bgm(payload: bytes):
    """Return (plays, stops, n_stmts). plays: dicts with stmt/offset/track/fade.

    Stop shape is ops-based: (4,5),(3,X),(4,158) with pushes (fade,1,255)
    (explicit silence; fade varies, e.g. 120 seen in 1011_020). Anything
    with (4,5) in ops is a stop, regardless of pushes[0] value.
    """
    plays, stops = [], []
    n = 0
    for idx, off, pushes, ops, _raw, _floats in iter_statements(payload):
        n = idx + 1
        if not any(o == 4 and a == OP_BGM for o, a in ops):
            continue
        if any(o == 4 and a == 5 for o, a in ops):
            stops.append({"stmt": idx, "off": off,
                          "pushes": [s32(x) for x in pushes], "ops": ops})
        elif pushes and pushes[0] <= TRACK_MAX_EXE:
            plays.append({"stmt": idx, "off": off, "track": pushes[0],
                          "fade": s32(pushes[1]) if len(pushes) > 1 else None,
                          "pushes": [s32(x) for x in pushes],
                          "ops": ops})
        else:
            stops.append({"stmt": idx, "off": off,
                          "pushes": [s32(x) for x in pushes], "ops": ops})
    return plays, stops, n


def find_se(payload: bytes):
    """Return list of SE plays: {stmt, off, se}.

    Opcode (4,164): statement shape [SE, 255] + (4,164) (2 pushes only;
    pushes[1] = volume, constant 255 corpus-wide, cf. exe `push 0xff`).
    Provenance: LSCR thunk 0x455720 calls the SE channel allocator
    0x406450 with the 2 script args; handler table base+40 = 164 with 6
    corroborating sibling slots; 12/12 corpus occurrences address real
    SE.PAK numbers. See docs/PARSING.md.
    """
    out = []
    for idx, off, pushes, ops, _raw, _floats in iter_statements(payload):
        if not any(o == 4 and a == OP_SE for o, a in ops):
            continue
        if len(pushes) >= 2 and pushes[1] == SE_VOL:
            out.append({"stmt": idx, "off": off, "se": s32(pushes[0])})
    return out


def load_bnr(en_pak_data: bytes, script: str):
    entries = {e.name: e for e in kcap.read_index(en_pak_data)
               if not e.is_folder}
    e = entries[script + ".bnr"]
    stored = en_pak_data[e.offset:e.offset + e.length]
    if e.is_compressed:
        orig, lz = lzss.split_datahdr(stored)
        payload = lzss.decompress(lz, orig)
    else:
        payload = stored
    return payload, e


def scene_table(txt_payload: bytes):
    """EN txt events + bak-scene segments: (ev_idx, tok, bg, kind, text)."""
    toks = parse_txt.split_tokens(txt_payload)
    events, _ = parse_txt.parse_tokens(toks)
    rows = []
    cur_bg = "OPEN"
    for i, ev in enumerate(events):
        t = ev["t"]
        if t == "image" and ev.get("layer") == "bak":
            cur_bg = ev["file"]
        text = ev.get("text", "")[:70] if isinstance(ev.get("text"), str) else ""
        rows.append({"i": i, "tok": ev.get("tok"), "bg": cur_bg,
                     "kind": t, "text": text})
    return rows


def map_plays(plays, events, n_stmts):
    out = []
    m = len(events)
    for p in plays:
        frac = p["stmt"] / max(1, n_stmts)
        ei = min(m - 1, int(frac * m))
        # nearest say/narrate at/after ei for the snippet
        snip, stok = "", None
        for r in events[ei:ei + 40]:
            if r["kind"] in ("say", "narrate") and r["text"]:
                snip, stok = r["text"], r["tok"]
                break
        out.append({**p, "frac": round(frac, 4), "ev": ei,
                    "scene": events[ei]["bg"], "tok": events[ei]["tok"],
                    "snippet": snip, "snip_tok": stok})
    return out


def bgm_files(bgm_pak_path: str | None):
    if not bgm_pak_path:
        return {}
    with open(bgm_pak_path, "rb") as f:
        data = f.read()
    (count,) = struct.unpack_from("<I", data, 4)
    names = []
    for i in range(count):
        raw = data[8 + i * 40:8 + i * 40 + 24]
        names.append(bytes(c ^ 0xFF for c in raw.split(b"\x00")[0]).decode())
    return {n: True for n in names}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("en_pak")
    ap.add_argument("scripts", nargs="+")
    ap.add_argument("--bgm-pak", default=None)
    args = ap.parse_args()
    with open(args.en_pak, "rb") as f:
        pak = f.read()
    entries = {e.name: e for e in kcap.read_index(pak) if not e.is_folder}
    have = bgm_files(args.bgm_pak)
    for script in args.scripts:
        payload, entry = load_bnr(pak, script)
        plays, stops, n = find_bgm(payload)
        tentry = entries[script + ".txt"]
        txt = pak[tentry.offset:tentry.offset + tentry.length]
        if tentry.is_compressed:
            orig, lz = lzss.split_datahdr(txt)
            txt = lzss.decompress(lz, orig)
        events = scene_table(txt)
        rows = map_plays(plays, events, n)
        print(f"### {script}  bnr_entry_off={entry.offset} "
              f"stored_len={entry.length} decomp_len={len(payload)} "
              f"code_off={code_off(payload)} n_stmts={n} "
              f"plays={len(plays)} stops={len(stops)}")
        for r in rows:
            ok = ("?" if not have else
                  ("A+B" if have.get(f"BGM_{r['track']:03d}_A.OGG")
                   and have.get(f"BGM_{r['track']:03d}_B.OGG")
                   else ("solo" if have.get(f"BGM_{r['track']:03d}.OGG")
                         else "MISSING")))
            print(f"  stmt {r['stmt']:5d} (bnr+{r['off']}) frac={r['frac']:.3f} "
                  f"-> ev {r['ev']} tok {r['tok']} scene {r['scene']} "
                  f"TRACK {r['track']:02d} fade {r['fade']} [{ok}] "
                  f"| {r['snippet'][:60]}")
        for s in stops:
            print(f"  stmt {s['stmt']:5d} (bnr+{s['off']}) STOP {s['pushes']}")


if __name__ == "__main__":
    main()
