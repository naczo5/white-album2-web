"""Build native-save ScriptPos anchors from JP LSCR label statements.

The PC build stores a raw ``ScriptPos`` in each slot save: the current
``.bnr`` byte offset. Re-importing that position into the web engine needs a
mapping from bytecode label statements to the scenario IR event indices the
player navigates by.

Every `.bnr` stream carries `(3,X)` line labels followed by `(4,131)` or
`(4,144)` sync ops; X is a JP token coordinate. `bnr_anchor` resolves those
coordinates through the JP txt spine's `next_event_map`, so each label
statement yields one `(byteOffset, eventIndex)` pair anchored on the IR
events (`high` confidence, same machinery as decode_bnr/build_voice).

Output::

  {version: 1, anchors: {"1007": [[byteOffset, eventIndex], ...],
                          "ic/1007": [...]}}

Main-script keys are the bare script id; IC variants are prefixed `ic/`.
Pairs are sorted by byte offset and exact duplicates are dropped.

IMPORTANT (empirical): the PC save's ScriptPos can be AHEAD of the
displayed message because the engine runs ahead through no-wait ops. The
JP sample set shows a 7-event gap (save_00 / 1007); do not assume a fixed
bound. Do not assume "nearest label == displayed event": this artifact is
for ranking text-matched candidates, not for direct positioning without a
text check.

Usage:
  python3 build_native_pos.py MAIN_SCRIPT_PAK [--ic IC_SCRIPT_PAK] OUT_JSON
"""

from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bnr_anchor  # noqa: E402
import kcap  # noqa: E402
import lzss  # noqa: E402
from proto_bgm import iter_statements  # noqa: E402

LABEL_OPS = (131, 144)


def _read_entry(pak_data: bytes, entry: kcap.KcapEntry) -> bytes:
    blob = pak_data[entry.offset:entry.offset + entry.length]
    if entry.is_compressed:
        orig, lz = lzss.split_datahdr(blob)
        return lzss.decompress(lz, orig)
    return blob


def script_anchors(bnr_payload: bytes, txt_payload: bytes) -> list[list[int]]:
    """Return sorted unique [byteOffset, eventIndex] label anchors."""
    events = bnr_anchor.jp_spine_events(txt_payload)
    next_ev = bnr_anchor.next_event_map(events)
    by_stmt = bnr_anchor.anchor_stmts(bnr_payload, next_ev)
    rows: set[tuple[int, int]] = set()
    for idx, off, _pushes, ops, _raw, _floats in iter_statements(bnr_payload):
        xs = [a for o, a in ops if o == 3]
        if xs and any(o == 4 and a in LABEL_OPS for o, a in ops):
            rows.add((off, int(by_stmt[idx])))
    return [[off, ev] for off, ev in sorted(rows)]


def extract_pak_anchors(pak_data: bytes, prefix: str = "") -> dict[str, list]:
    """Anchors for every `.bnr`/`.txt` pair in one KCAP archive."""
    entries = {e.name: e for e in kcap.read_index(pak_data)
               if not e.is_folder}
    bnrs = {n[:-4]: e for n, e in entries.items() if n.endswith(".bnr")}
    txts = {n[:-4]: e for n, e in entries.items() if n.endswith(".txt")}
    if not bnrs:
        raise ValueError("archive has no .bnr entries")
    pairs = sorted(set(bnrs) & set(txts))
    if not pairs:
        raise ValueError("archive has no .txt/.bnr script pairs")

    unpaired = sorted(set(bnrs) - set(txts))
    if unpaired:
        print(f"      WARN skipping {len(unpaired)} .bnr without .txt: "
              f"{', '.join(unpaired[:5])}")

    out: dict[str, list] = {}
    for sid in pairs:
        anchors = script_anchors(_read_entry(pak_data, bnrs[sid]),
                                 _read_entry(pak_data, txts[sid]))
        if anchors:
            out[prefix + sid] = anchors
    return out


def build_native_pos(main_path: str,
                     ic_path: str | None = None) -> dict:
    with open(main_path, "rb") as f:
        anchors = extract_pak_anchors(f.read())
    if ic_path:
        with open(ic_path, "rb") as f:
            anchors.update(extract_pak_anchors(f.read(), prefix="ic/"))
    return {"version": 1, "anchors": anchor_order(anchors)}


def anchor_order(anchors: dict[str, list]) -> dict[str, list]:
    """Stable script-key order with pairs already sorted by offset."""
    return {k: anchors[k] for k in sorted(anchors)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("main_pak", help="JP script.pak (main scenarios)")
    ap.add_argument("out_json", help="output native-pos.json")
    ap.add_argument("--ic", default=None,
                    help="optional JP IC/script.pak (IC variants)")
    args = ap.parse_args()

    try:
        data = build_native_pos(args.main_pak, args.ic)
    except ValueError as exc:
        raise SystemExit(f"ERROR: {args.main_pak}: {exc}") from exc

    os.makedirs(os.path.dirname(os.path.abspath(args.out_json)),
                exist_ok=True)
    with open(args.out_json, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    n_pairs = sum(len(v) for v in data["anchors"].values())
    n_ic = sum(1 for k in data["anchors"] if k.startswith("ic/"))
    print(f"native-pos: {len(data['anchors'])} scripts "
          f"({n_ic} IC), {n_pairs} label anchors -> {args.out_json}")


if __name__ == "__main__":
    main()
