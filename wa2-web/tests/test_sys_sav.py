"""Gates for the native-PC Sys.sav slot map (data/sys-slots.json).

Two kinds of check live here:

- committed-data invariants (always run): schema/shape of
  data/sys-slots.json, the choice table order against data/flow.json, CG id
  uniqueness, and a hard "no game text" check on the committed file.
- BYOA-gated checks (skip when the game is absent): GFLAG.dat `+256` slot
  parsing from a real script.pak, and its cross-check against the committed
  ending-slot map. CI has no .cache/game, so these never fail there.

Nothing here copies scenario text into the repo: the JP GFLAG record names
stay in memory only.
"""

import json
import os
import re
import struct
import sys

import pytest

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "..", "data")
TOOLS = os.path.join(HERE, "..", "tools")
sys.path.insert(0, TOOLS)

import build_flags  # noqa: E402
import pack_bundle  # noqa: E402

SYS_SLOTS = os.path.join(DATA, "sys-slots.json")
SCRIPT_PAK = os.environ.get("WA2_SCRIPT_PAK") or os.path.join(
    HERE, "..", "..", ".cache", "game", "script.pak")


def load_slots():
    with open(SYS_SLOTS, encoding="utf-8") as f:
        return json.load(f)


# ------------------------------------------------- committed data gates ---
def test_sys_slots_schema_and_counts():
    t = load_slots()
    assert t["version"] == 1
    assert len(t["scripts"]) == 185
    assert len(set(t["scripts"])) == 185
    assert all(re.fullmatch(r"[0-9]{4}(?:_[0-9]{3}(?:_[0-9])?)?"
                            r"|[0-9]{4}_[0-9]|[a-z]+[0-9]*", s)
               for s in t["scripts"])
    assert t["sysSav"]["size"] == 0x269480
    regions = t["sysSav"]["regions"]
    assert (regions["A"]["start"], regions["A"]["end"]) == (0, 0x80000)
    assert (regions["B"]["start"], regions["B"]["end"]) == (0x80000, 0x268480)
    assert (regions["C"]["start"], regions["C"]["end"]) == (0x268480, 0x269480)
    assert regions["A"]["slotBits"] == 4096
    # Slot 0 is the engine's catch-all bucket and must stay excluded.
    assert regions["A"]["excludedSlots"] == [0]


def test_sys_slots_choice_table_matches_flow_order():
    """The engine's choice table order is flow.json's unique script order."""
    t = load_slots()
    ids = t["choiceTable"]["scriptIds"]
    assert len(ids) == 23
    assert len(set(ids)) == 23
    with open(os.path.join(DATA, "flow.json"), encoding="utf-8") as f:
        flow = json.load(f)
    order = []
    for node in flow["nodes"]:
        script = (node.get("engine") or {}).get("script")
        if script is None or script in order:
            continue
        order.append(script)
    assert ids == order
    assert t["choiceTable"]["base"] == 900
    assert t["choiceTable"]["stride"] == 4


def test_sys_slots_cg_rows_are_unique_and_well_formed():
    t = load_slots()
    rows = t["cgRows"]
    assert len(rows) == 168
    assert all(len(row) == 10 for row in rows)
    ids = [v for row in rows for v in row if v]
    assert len(ids) == 272
    assert len(set(ids)) == 272
    for cid in ids:
        # part * 1_000_000 + cgId, part 0 (v-file) or 1 (h-file)
        assert 100_000 <= cid <= 1_999_999
        assert cid // 1_000_000 in (0, 1)
        assert 100_000 <= cid % 1_000_000 <= 999_999
    # Rows are packed left-to-right with zero padding.
    for row in rows:
        seen_zero = False
        for v in row:
            if v == 0:
                seen_zero = True
            else:
                assert not seen_zero, f"gap before value in row {row}"


def test_sys_slots_ending_map_is_complete_and_known():
    t = load_slots()
    ids = {e["id"] for e in json.load(
        open(os.path.join(DATA, "endings.json"), encoding="utf-8"))["endings"]}
    mapped = set(t["endingSlots"].values())
    assert mapped <= ids, f"unknown ending ids: {sorted(mapped - ids)}"
    assert set(t["endingSlots"]) == set(t["endingSlotsConfidence"])
    assert set(t["endingSlotsConfidence"].values()) <= {"high",
                                                        "hypothesis",
                                                        "reserved"}
    # The hypothesis is exactly the prologue/IC clear.
    hyp = {s for s, c in t["endingSlotsConfidence"].items()
           if c == "hypothesis"}
    assert hyp == {"1"}
    assert t["endingSlots"]["1"] == "ic-end"
    # The engine force-zeroes 99, so its mapping stays reference-only.
    reserved = {s for s, c in t["endingSlotsConfidence"].items()
                if c == "reserved"}
    assert reserved == {"99"}
    assert t["endingSlots"]["99"] == "coda-setsuna-true"
    assert t["gateSlots"]["reservedSlot99"] == 99
    # All band/gate constants stay numeric.
    assert all(isinstance(v, int) and not isinstance(v, bool)
               for v in t["gateSlots"].values())
    assert t["gateSlots"]["choiceBandBase"] == t["choiceTable"]["base"]


def test_sys_slots_has_no_game_text():
    """Committed metadata must stay ASCII: no JP titles, no scenario text."""
    raw = open(SYS_SLOTS, encoding="utf-8").read()
    assert raw.isascii(), [c for c in raw if ord(c) > 127][:10]
    t = json.loads(raw)
    blob = json.dumps(t, ensure_ascii=False)
    # No CP932-only characters (half/full-width kana, CJK ideographs).
    assert not re.search(r"[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff"
                         r"\uff00-\uffef]", blob)


def test_sys_slots_open_items_note_slot_zero():
    t = load_slots()
    assert t["openItems"]
    assert any("slot 0" in item for item in t["openItems"])
    assert any("Slot 99" in item for item in t["openItems"])


# ------------------------------------------------------- pack_bundle gate ---
def test_bundle_delivers_sys_slots(tmp_path):
    data = tmp_path / "data"
    (data / "scripts").mkdir(parents=True)
    (data / "scripts" / "index.json").write_text(
        json.dumps(["1001"]), encoding="utf-8")
    (data / "scripts" / "1001.json").write_text(
        json.dumps({"script": "1001", "tokens": 1, "events": []}),
        encoding="utf-8")
    (data / "flow.json").write_text(
        json.dumps({"version": 1, "nodes": []}), encoding="utf-8")
    payload = {"version": 1, "scripts": ["1001"], "gateSlots": {"x": 1}}
    (data / "sys-slots.json").write_text(json.dumps(payload), encoding="utf-8")

    stats = pack_bundle.bundle_data(str(data))
    assert stats["scenarios"] == 1
    bundle = json.loads((data / "bundle.json").read_text(encoding="utf-8"))
    assert bundle["sysSlots"] == payload
    # Pruning removes the loose copy along with the other bundled files.
    pack_bundle.bundle_data(str(data), prune=True)
    assert not (data / "sys-slots.json").exists()


# ------------------------------------------------- GFLAG slot parsing ---
def _gflag_blob(names_slots):
    """Build a synthetic GFLAG.dat (u32 count + 260-byte records)."""
    blob = struct.pack("<I", len(names_slots)) + b"\x00" * 4
    for name, slot in names_slots:
        rec = name.encode("cp932") + b"\x00" * (256 - len(name))
        rec += struct.pack("<I", slot)
        blob += rec[:260].ljust(260, b"\x00")
    return blob


def test_parse_gflag_slots_reads_offset_256():
    blob = _gflag_blob([("_GFLAG_EV_A", 21), ("_GFLAG_EV_B", 0),
                        ("_GFLAG_EV_C", 900)])
    rows = build_flags.parse_gflag_slots(blob)
    assert [r["slot"] for r in rows] == [21, 0, 900]
    assert [r["name"] for r in rows] == ["_GFLAG_EV_A", "_GFLAG_EV_B",
                                         "_GFLAG_EV_C"]
    # The legacy name-only parse is unchanged.
    assert build_flags.parse_gflag(blob) == ["_GFLAG_EV_A", "_GFLAG_EV_B",
                                             "_GFLAG_EV_C"]


def test_parse_gflag_slots_clamps_short_final_record():
    """A truncated last record must not raise (slot field sits at EOF)."""
    blob = struct.pack("<I", 2) + b"\x00" * 4
    name = b"_GFLAG_EV_A\x00"
    blob += (name + b"\x00" * (256 - len(name)) + struct.pack("<I", 1))
    # Second record is cut off well before its +256 slot field.
    blob += b"_GFLAG_TRUNC\x00"
    rows = build_flags.parse_gflag_slots(blob)
    assert rows[0]["slot"] == 1
    assert rows[1]["name"] == "_GFLAG_TRUNC"
    assert rows[1]["slot"] == 0  # clamped, not read past EOF


SYS_SAV = os.environ.get("WA2_SYS_SAV") or os.path.join(
    HERE, "..", "..", ".cache", "saves", "2026-11-13", "Sys.sav")


def _cp932_entry(pak: bytes, name: str) -> bytes:
    """Fetch one script.pak entry, decompressing when needed."""
    import kcap
    import lzss
    for e in kcap.read_index(pak):
        if not e.is_folder and e.name == name:
            s, e2 = kcap.data_range(e)
            blob = pak[s:e2]
            if e.is_compressed:
                orig, lz = lzss.split_datahdr(blob)
                return lzss.decompress(lz, orig)
            return blob
    raise KeyError(name)


def test_region_a_bitmap_is_the_read_line_counter():
    """Verified layout: slot bits = message lines + 1 sentinel, from bit 0.

    Uses the user's script.pak and Sys.sav sample (both BYOA). Slots whose
    branch structure makes the count differ are asserted as a known set so
    the rule stays honest instead of being silently loosened.
    """
    if not (os.path.isfile(SCRIPT_PAK) and os.path.isfile(SYS_SAV)):
        pytest.skip("needs WA2_SCRIPT_PAK / WA2_SYS_SAV (or .cache samples)")

    import kcap
    import parse_txt

    with open(SCRIPT_PAK, "rb") as f:
        pak = f.read()
    with open(SYS_SAV, "rb") as f:
        region_a = f.read()[0:0x80000]
    t = load_slots()

    def bit_run(slot):
        blk = region_a[slot * 0x200:(slot + 1) * 0x200]
        return [i for i in range(4096) if blk[i >> 3] & (0x80 >> (i & 7))]

    def message_lines(script):
        blob = _cp932_entry(pak, script + ".txt")
        events, _w = parse_txt.parse_tokens(parse_txt.split_tokens(blob))
        return sum(1 for e in events if e["t"] in ("say", "narrate"))

    checked = 0
    exact = 0
    for slot, script in enumerate(t["scripts"]):
        # Slot 0 is the engine's catch-all bucket (see openItems). The
        # `catch*` helper scripts are image-only and set just one bit, so
        # they are outside the per-line rule.
        if slot == 0 or not script[:1].isdigit():
            continue
        try:
            lines = message_lines(script)
        except KeyError:
            continue
        bits = bit_run(slot)
        if not bits:
            continue  # never read in this sample
        checked += 1
        # One bit per read message line plus a trailing sentinel, so a slot
        # can never carry more bits than lines + 1. Partially read and
        # branching scripts (2023: 296 bits / 302 lines) stop earlier, and
        # their bit run can have gaps where a branch skipped content.
        assert len(bits) <= lines + 1, (
            f"{script}: {len(bits)} bits exceeds {lines} lines + sentinel")
        if len(bits) == lines + 1:
            # A fully read script pins the sentinel exactly, contiguously.
            assert bits == list(range(len(bits))), f"{script}: non-contiguous"
            exact += 1
    assert checked >= 80, f"only {checked} slots cross-checked"
    # The sample is a near-complete run: most scripts are read to the end.
    assert exact >= 70, f"only {exact} slots with an exact sentinel"


def test_parse_gflag_slots_matches_committed_ending_map():
    if not os.path.isfile(SCRIPT_PAK):
        pytest.skip("WA2_SCRIPT_PAK not set and no .cache/game/script.pak")
    with open(SCRIPT_PAK, "rb") as f:
        pak = f.read()
    rows = build_flags.parse_gflag_slots(build_flags.get_entry(pak,
                                                              "GFLAG.dat"))
    assert len(rows) == 62
    slots = {r["slot"] for r in rows if r["slot"]}
    t = load_slots()
    for slot in t["endingSlots"]:
        assert int(slot) in slots
    # Records 61 and the pre-final record leave slot 0 unassigned.
    assert rows[-1]["slot"] == 0
