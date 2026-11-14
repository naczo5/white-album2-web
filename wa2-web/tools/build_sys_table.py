"""Extract the native-PC ``Sys.sav`` slot map from ``WA2.exe`` (static, offline).

The original build keeps three index tables in ``WA2.exe`` .data that give
meaning to the shared system save (``Sys.sav``, 0x269480 bytes):

- ``0x4be530``: 185 ``char*`` script ids, NULL-terminated. The index i in
  this table is the *slot* of the Region A read-line bitmap
  (``Sys.sav[0 .. 0x80000]``, one 0x200-byte / 4096-bit block per script).
  Cross-checked against the sample save: slot 1 -> ``1002`` has 503 set
  bits for 502 message rows in the IR (sentinel bit ``lastTok + 1``).
- ``0x4be4d0``: 23 ``u32`` choice-script ids (``0x7d3`` = 2003 ...) in the
  engine's choice order, ``0xffffffff``-terminated. That order matches the
  ordered unique scripts of ``data/flow.json`` exactly (verified). Choice
  bitmask slots live at ``900 + 4 * choiceIdx + nodeIdx`` in Region C.
- ``0x4c01b0``: the gallery thumbnail table, 168 rows x 10 ``u32`` CG ids
  (``part * 1_000_000 + cgId``; part 0 -> ``v%06d.tga``, part 1 ->
  ``h%06d.tga``). The table ends where the 20-byte-stride ero-scene record
  list starts at ``0x4c1bf0``: ``0x4c1bf0 - 0x4c01b0 = 0x1a40`` = 168 rows.
  The gallery UI cell math (``0x428b60``, ``page * 12 + cell``) agrees with
  12 cells per page.

Region C (``Sys.sav[0x268480 .. 0x269480]``) is 1024 ``u32`` global flags
read and written via ``GetGameFlag``/``SetGameFlag``. ``GFLAG.dat``
(``script.pak``, 62 records x 260 B) names them and stores the slot index at
record ``+256``; ``build_flags.py`` emits that as ``gflagSlots``. Two of the
shipped records share slot 210, so aliases are recorded as data.

Output (committed functional metadata - numeric ids and addresses only, no
game text)::

  {version, source, sysSav, scripts, choiceTable, cgRows, endingSlots,
   endingSlotsConfidence, gateSlots, gflagAliasSlots, openItems}

Usage:
  python3 build_sys_table.py [--exe WA2.EXE] [--out data/sys-slots.json]
                             [--flow [FLOW_JSON]] [--gflag [SCRIPT_PAK]]
"""

from __future__ import annotations

import argparse
import json
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)  # wa2-web/

# --- verified table addresses (VA; image base 0x400000) -----------------
SCRIPT_TABLE_VA = 0x4BE530
SCRIPT_TABLE_MAX = 1024  # engine scan bound is 0x400 entries (0x40ea10)
CHOICE_TABLE_VA = 0x4BE4D0
CHOICE_TABLE_MAX = 64
CHOICE_SENTINEL = 0xFFFFFFFF
CHOICE_BASE = 900
CHOICE_STRIDE = 4
GALLERY_TABLE_VA = 0x4C01B0
GALLERY_ROWS = 168
GALLERY_COLS = 10
GALLERY_END_VA = 0x4C1BF0  # the ero-scene record list starts here

# --- Sys.sav geometry ---------------------------------------------------
SYS_SAV_SIZE = 0x269480
REGION_A = (0x000000, 0x080000)  # 4096 slots x 0x200 B bitmaps
REGION_B = (0x080000, 0x268480)  # 2,000,000 bytes, part*1e6 + cgId
REGION_C = (0x268480, 0x269480)  # 1024 u32 global flags
REGION_A_SLOT_BYTES = 0x200
REGION_A_SLOT_BITS = REGION_A_SLOT_BYTES * 8

# Global flag ids that gate content. Names are functional English labels;
# GFLAG.dat carries the original labels, which never enter this file.
GATE_SLOTS = {
    "replaySlot": 2,  # 2nd-playthrough unlock
    "chiakiNormalSlot": 1,  # gates the Chiaki true-end option (2003 opt1)
    "codaEnteredSlot": 5,  # third part entered
    "setsunaCcSlot": 21,  # cc-setsuna cleared -> coda unlocks
    "reservedSlot99": 99,  # system-reserved choice placeholder; setter forces it to 0
    "choiceSystemSlot": 99,  # GFLAG choice-system slot (GetGameFlag(99) == 0)
    "musicBandBase": 100,  # 100 + trackId
    "movieBandBase": 200,  # 200 + movieId
    "eroBandBase": 300,  # 300..322 ero-scene flags
    "choiceBandBase": CHOICE_BASE,
}

# GFLAG.dat slot -> endings.json id. All 11 endings are verified 1:1 from
# GFLAG.dat records + .bnr SetGameFlag calls (`high` confidence).
ENDING_SLOTS = {
    0: ("ic-end", "high"),
    20: ("cc-normal1", "high"),
    21: ("cc-setsuna", "high"),
    22: ("cc-koharu", "high"),
    23: ("cc-chiaki-true", "high"),
    24: ("cc-chiaki-normal", "high"),
    25: ("cc-mari", "high"),
    30: ("coda-normal", "high"),
    31: ("coda-kazusa-true", "high"),
    32: ("coda-cheating", "high"),
    33: ("coda-setsuna-true", "high"),
}

OPEN_ITEMS = [
    "Region A slot 0 is untrustworthy: the script->slot resolver at "
    "0x40ea10 falls back to index 0 for ids absent from the 0x4be530 table "
    "and accumulates them there. The sample save shows a 52-bit gap "
    "(63->115) and a tail out to bit 1760 while 1001 itself has 85 message "
    "lines. Excluded from import; keep as reference only.",
    "GFLAG.dat record 0 holds slot 0 (ic-end clear flag written by 1013); "
    "record 61 holds slot 900 (choiceBandBase reservation in Region C).",
    "Region C band 900+ is shared: 900 + 4*choiceIdx + nodeIdx choice "
    "bitmasks share base 900 named in GFLAG.dat record 61. Read "
    "the 23x4 band from choiceTable first, then treat any remaining "
    "900..991 bits as unclassified.",
    "Movie and music band ids overlap in the low 200s (movie sentinel 80, "
    "music 100 + trackId); treat 201..224 as movies and 101..199 as music.",
    "Slot 99 is system-reserved and force-zeroed: the guarded flag setter at "
    "0x405320 compares the index with 99, substitutes 0 and reports the "
    "rejection; SetSelectMess compares GetGameFlag(99) (always 0) against "
    "choice gate conditions. Not an ending slot.",
]


# ------------------------------------------------------------------ PE ---
def parse_pe(data: bytes) -> tuple[int, list[dict]]:
    """Return (image_base, sections) for a PE32 executable.

    Each section dict carries name/va/vsize/raw_off/raw_size. Raises
    ValueError on a non-PE blob so callers fail loudly instead of reading
    garbage offsets.
    """
    if len(data) < 0x40 or data[:2] != b"MZ":
        raise ValueError("not an MZ executable")
    pe_off = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe_off:pe_off + 4] != b"PE\x00\x00":
        raise ValueError("missing PE signature")
    n_sec = struct.unpack_from("<H", data, pe_off + 6)[0]
    opt_size = struct.unpack_from("<H", data, pe_off + 20)[0]
    opt_off = pe_off + 24
    magic = struct.unpack_from("<H", data, opt_off)[0]
    if magic != 0x10B:  # PE32 only; this binary is 32-bit
        raise ValueError(f"unexpected optional header magic 0x{magic:x}")
    image_base = struct.unpack_from("<I", data, opt_off + 28)[0]
    sections = []
    sec_off = opt_off + opt_size
    for i in range(n_sec):
        o = sec_off + i * 40
        name = data[o:o + 8].rstrip(b"\x00").decode("latin-1")
        vsize, va, raw_size, raw_off = struct.unpack_from("<IIII", data, o + 8)
        sections.append({"name": name, "va": va, "vsize": vsize,
                         "raw_off": raw_off, "raw_size": raw_size})
    return image_base, sections


def va_to_off(sections: list[dict], image_base: int, va: int) -> int | None:
    """Map a VA to a file offset, or None when it is not file-backed.

    A section's file bytes only cover ``raw_size``; addresses inside the
    zero-filled tail of a larger virtual size have no file image.
    """
    rva = va - image_base
    for s in sections:
        if s["va"] <= rva < s["va"] + max(s["vsize"], s["raw_size"]):
            rel = rva - s["va"]
            if rel >= s["raw_size"]:
                return None
            return s["raw_off"] + rel
    return None


def read_cstr(data: bytes, sections, image_base: int, va: int) -> str:
    off = va_to_off(sections, image_base, va)
    if off is None or off >= len(data):
        raise ValueError(f"VA 0x{va:x} is not file-backed")
    end = data.find(b"\x00", off)
    if end < 0:
        raise ValueError(f"unterminated string at VA 0x{va:x}")
    return data[off:end].decode("latin-1")


def read_u32s(data: bytes, sections, image_base: int, va: int,
              count: int, clamp: bool = False) -> list[int]:
    off = va_to_off(sections, image_base, va)
    if off is None:
        raise ValueError(f"VA 0x{va:x} is not file-backed")
    if off + count * 4 > len(data):
        if not clamp:
            raise ValueError(f"read of {count} u32 at VA 0x{va:x} overruns "
                             "file")
        count = max(0, (len(data) - off) // 4)
    return list(struct.unpack_from(f"<{count}I", data, off))


# ----------------------------------------------------------- extraction ---
def extract_scripts(data, sections, image_base) -> list[str]:
    """Script ids from the 0x4be530 pointer table (NULL-terminated)."""
    ptrs = read_u32s(data, sections, image_base, SCRIPT_TABLE_VA,
                     SCRIPT_TABLE_MAX)
    out = []
    for p in ptrs:
        if p == 0:
            break
        out.append(read_cstr(data, sections, image_base, p))
    return out


def extract_choice_table(data, sections, image_base) -> list[int]:
    """Choice-script ids at 0x4be4d0, 0xffffffff-terminated."""
    words = read_u32s(data, sections, image_base, CHOICE_TABLE_VA,
                      CHOICE_TABLE_MAX)
    out = []
    for w in words:
        if w == CHOICE_SENTINEL:
            break
        out.append(w)
    return out


def _is_cg_id(v: int) -> bool:
    """part * 1_000_000 + cgId with part in {0, 1}."""
    if not 100_000 <= v <= 999_999:
        return False
    return v // 1_000_000 in (0, 1)


def extract_cg_rows(data, sections, image_base) -> list[list[int]]:
    """Gallery CG ids: 168 rows x 10 u32, zero-padded on the right.

    Stops early if the table runs into the neighbouring record list, so a
    re-release with a shorter table degrades instead of emitting garbage.
    """
    span = GALLERY_END_VA - GALLERY_TABLE_VA
    max_rows = min(GALLERY_ROWS, span // (GALLERY_COLS * 4))
    words = read_u32s(data, sections, image_base, GALLERY_TABLE_VA,
                      max_rows * GALLERY_COLS, clamp=True)
    rows = []
    for r in range(len(words) // GALLERY_COLS):
        row = words[r * GALLERY_COLS:(r + 1) * GALLERY_COLS]
        if any(v and not _is_cg_id(v) for v in row):
            break  # hit a foreign record; keep what we parsed
        rows.append(row)
    return rows


# --------------------------------------------------------------- checks ---
def check_flow(choice_ids: list[int], flow_path: str) -> list[str]:
    """Verify the engine choice order equals flow.json's unique script order."""
    with open(flow_path, encoding="utf-8") as f:
        flow = json.load(f)
    order: list[int] = []
    for node in flow.get("nodes", []):
        script = (node.get("engine") or {}).get("script")
        if script is None:
            continue
        try:
            sid = int(script)
        except (TypeError, ValueError):
            continue
        if sid not in order:
            order.append(sid)
    if order == choice_ids:
        return []
    only_engine = [s for s in choice_ids if s not in order]
    only_flow = [s for s in order if s not in choice_ids]
    return [f"choice table != flow.json order "
            f"(engine {len(choice_ids)}, flow {len(order)}, "
            f"engine-only {only_engine[:5]}, flow-only {only_flow[:5]})"]


def check_gflag(pak_path: str) -> tuple[list[str], list[int]]:
    """Cross-check GFLAG.dat slot ids against ENDING_SLOTS.

    Returns (problems, alias_slots). Two records legitimately share slot
    210 in the shipped table, so aliases are returned as data rather than
    reported as an error.
    """
    import build_flags  # local import keeps the PE path dependency-free

    with open(pak_path, "rb") as f:
        pak = f.read()
    entries = build_flags.parse_gflag_slots(
        build_flags.get_entry(pak, "GFLAG.dat"))
    by_slot = {e["slot"]: e["name"] for e in entries}
    problems = []
    if len(entries) != 62:
        problems.append(f"GFLAG.dat has {len(entries)} records, expected 62")
    used = [e["slot"] for e in entries if e["slot"]]
    aliases = sorted({s for s in used if used.count(s) > 1})
    for slot in sorted(ENDING_SLOTS):
        if slot not in by_slot:
            problems.append(f"ending slot {slot} missing from GFLAG.dat")
    return problems, aliases


# ----------------------------------------------------------------- main ---
def build_table(exe_path: str, flow_path: str | None = None,
                pak_path: str | None = None) -> tuple[dict, list[str]]:
    with open(exe_path, "rb") as f:
        data = f.read()
    image_base, sections = parse_pe(data)
    scripts = extract_scripts(data, sections, image_base)
    choice_ids = extract_choice_table(data, sections, image_base)
    cg_rows = extract_cg_rows(data, sections, image_base)
    alias_slots: list[int] = []

    table = {
        "version": 1,
        "source": {
            "exe": os.path.basename(exe_path),
            "imageBase": f"0x{image_base:x}",
            "scriptTableVa": f"0x{SCRIPT_TABLE_VA:x}",
            "choiceTableVa": f"0x{CHOICE_TABLE_VA:x}",
            "galleryTableVa": f"0x{GALLERY_TABLE_VA:x}",
            "galleryEndVa": f"0x{GALLERY_END_VA:x}",
            "note": "static PE .data read; no game text is copied here",
        },
        "sysSav": {
            "size": SYS_SAV_SIZE,
            "regions": {
                "A": {
                    "start": REGION_A[0], "end": REGION_A[1],
                    "slotBytes": REGION_A_SLOT_BYTES,
                    "slotBits": REGION_A_SLOT_BITS,
                    "slotCount": len(scripts),
                    "format": "MSB-first read-line bitmap; bit i lives at "
                              "byte i>>3 with mask 0x80>>(i&7); one bit per "
                              "read message line plus a trailing sentinel, "
                              "so the bit count is at most messageLines+1 "
                              "(82 fully-read sample slots match exactly and "
                              "contiguously; partial and branching scripts "
                              "stop early and may have gaps)",
                    "slotKey": "index into scripts[]",
                    "excludedSlots": [0],
                },
                "B": {
                    "start": REGION_B[0], "end": REGION_B[1],
                    "format": "one byte per CG id, index = part*1000000 + "
                              "cgId (part 0 = v%06d.tga, part 1 = "
                              "h%06d.tga)",
                },
                "C": {
                    "start": REGION_C[0], "end": REGION_C[1],
                    "format": "1024 u32 LE global flags (GetGameFlag / "
                              "SetGameFlag)",
                },
            },
            "slotSaveVrb": {
                "offset": 0x54CB0,
                "totalBytes": 800,
                "count": 29,
                "format": "u32 totalBytes (whole block incl. header), u32 "
                          "count, then count records of u32 nameLen (CP932 "
                          "name incl. NUL), name, u32 type (3 = int), u8 "
                          "value; records end at the slot file end 0x54fd0",
                "confidence": "high",
            },
        },
        "scripts": scripts,
        "choiceTable": {
            "scriptIds": [str(s) for s in choice_ids],
            "base": CHOICE_BASE,
            "stride": CHOICE_STRIDE,
            "format": "flag slot = base + stride * choiceIdx + nodeIdx; "
                      "bit k (1<<k) = option k+1 taken at least once",
        },
        "cgRows": cg_rows,
        "endingSlots": {str(k): v[0] for k, v in sorted(ENDING_SLOTS.items())},
        "endingSlotsConfidence": {str(k): v[1]
                                  for k, v in sorted(ENDING_SLOTS.items())},
        "gateSlots": GATE_SLOTS,
        "gflagAliasSlots": alias_slots,
        "openItems": OPEN_ITEMS,
    }

    problems: list[str] = []
    if len(scripts) != 185:
        problems.append(f"script table has {len(scripts)} ids, expected 185")
    if len(choice_ids) != 23:
        problems.append(f"choice table has {len(choice_ids)} ids, expected 23")
    if len(cg_rows) != GALLERY_ROWS:
        problems.append(f"gallery table has {len(cg_rows)} rows, "
                        f"expected {GALLERY_ROWS}")
    ids = [v for row in cg_rows for v in row if v]
    if len(ids) != len(set(ids)):
        problems.append("duplicate CG ids in gallery table")
    if flow_path:
        problems += check_flow(choice_ids, flow_path)
    if pak_path:
        gflag_problems, alias_slots = check_gflag(pak_path)
        problems += gflag_problems
        table["gflagAliasSlots"] = alias_slots
    return table, problems


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--exe", default=os.path.join(
        REPO, "..", ".cache", "game", "WA2.exe"),
        help="path to WA2.exe (default: .cache/game/WA2.exe)")
    ap.add_argument("--out", default=os.path.join(
        REPO, "data", "sys-slots.json"))
    ap.add_argument("--flow", nargs="?", const=os.path.join(
        REPO, "data", "flow.json"), default=None,
        help="verify choiceTable order against flow.json")
    ap.add_argument("--gflag", nargs="?", const=os.path.join(
        REPO, "..", ".cache", "game", "script.pak"), default=None,
        help="verify GFLAG.dat slot ids against script.pak")
    args = ap.parse_args()

    if not os.path.isfile(args.exe):
        raise SystemExit(f"ERROR: WA2.exe not found at {args.exe} "
                         "(BYOA: pass --exe PATH)")

    table, problems = build_table(args.exe, args.flow, args.gflag)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(table, f, ensure_ascii=False, indent=1)

    ids = sum(1 for row in table["cgRows"] for v in row if v)
    print(f"sys-slots: {len(table['scripts'])} scripts, "
          f"{len(table['choiceTable']['scriptIds'])} choice scripts, "
          f"{len(table['cgRows'])} cg rows / {ids} cg ids, "
          f"{len(table['endingSlots'])} ending slots -> {args.out}")
    for p in problems:
        print(f"      WARN {p}")


if __name__ == "__main__":
    main()
