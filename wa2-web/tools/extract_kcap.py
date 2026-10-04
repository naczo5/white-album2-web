"""Extract a Leaf KCAP `.pak` (e.g. user-supplied `en.pak`).

Usage:
    python3 extract_kcap.py INPUT.pak OUT_DIR [--include txt,bnr,tga] [--raw]

Default extracts `.txt` (scenario sources) as-is and decompresses `.bnr`
(LSCR tracks) + `.tga` (images) via tools/lzss.py. Writes OUT_DIR/manifest.json
with per-file {offset, size, compressed, sha1} for parity auditing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import kcap
import lzss


def extract(pak_path: str, out_dir: str, include: set[str] | None = None) -> dict:
    with open(pak_path, "rb") as f:
        data = f.read()
    entries = kcap.read_index(data)
    os.makedirs(out_dir, exist_ok=True)
    manifest: dict = {"pak": os.path.basename(pak_path), "files": []}
    for e in entries:
        if e.is_folder:
            manifest["files"].append({"name": e.name, "folder": True})
            continue
        ext = e.name.rsplit(".", 1)[-1].lower() if "." in e.name else ""
        if include is not None and ext not in include:
            continue
        start, end = kcap.data_range(e)
        payload = data[start:end]
        if len(payload) != e.length:
            raise ValueError(f"{e.name}: payload {len(payload)} != entry {e.length}")
        if e.is_compressed:
            orig_len, lz = lzss.split_datahdr(payload)
            payload = lzss.decompress(lz, orig_len)
        with open(os.path.join(out_dir, e.name), "wb") as f:
            f.write(payload)
        manifest["files"].append(
            {
                "name": e.name,
                "offset": e.offset,
                "stored": e.length,
                "compressed": e.is_compressed,
                "sha1": hashlib.sha1(payload).hexdigest(),
            }
        )
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    return manifest


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pak")
    ap.add_argument("out_dir")
    ap.add_argument("--include", default="txt,bnr,tga",
                    help="comma-separated extensions to extract")
    args = ap.parse_args()
    include = {s.strip().lower() for s in args.include.split(",") if s.strip()}
    m = extract(args.pak, args.out_dir, include)
    files = [f for f in m["files"] if not f.get("folder")]
    print(f"extracted {len(files)} files -> {args.out_dir}")


if __name__ == "__main__":
    main()
