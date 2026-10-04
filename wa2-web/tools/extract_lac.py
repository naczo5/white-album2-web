"""Leaf LAC installer-archive extractor (WHITE ALBUM 2 `.LAC` files).

Layout (reverse-engineered from the Extended Edition installer):
    u32 magic b'LAC\\x00', u32 file_count
    file_count entries of 120 bytes:
        char name[64] (Shift-JIS/ASCII, NUL-padded; backslash paths)
        u32 unknown1, unknown2, unknown3 (0 in practice)
        u32 size, u32 size2 (identical; payloads stored raw)
        ... checksums, FILETIMEs ...
    folder entries (size 0) and install-script records may follow the
    file entries; payloads concatenate back-to-back after the last
    file entry's record. Extraction stops at the first entry with an
    empty name or an impossible size.

Usage:
    python3 extract_lac.py INPUT.LAC OUT_DIR [--list]
"""

from __future__ import annotations

import argparse
import os
import struct
import sys

MAGIC = b"LAC\x00"
HEADER_SIZE = 8
ENTRY_SIZE = 120


def decode_name(raw: bytes) -> str:
    try:
        return raw.split(b"\x00")[0].decode("cp932")
    except UnicodeDecodeError:
        return raw.split(b"\x00")[0].decode("ascii", errors="replace")


def read_index(data: bytes) -> list[tuple[str, int]]:
    if data[:4] != MAGIC:
        raise ValueError(f"bad LAC magic: {data[:4]!r}")
    (count,) = struct.unpack_from("<I", data, 4)
    out = []
    pos = HEADER_SIZE
    for _ in range(count):
        name = decode_name(data[pos:pos + 64])
        (_u1, _u2, _u3, size, _size2) = struct.unpack_from(
            "<IIIII", data, pos + 64)
        if not name or size > len(data):
            break  # folder records / install-script tail, not files
        out.append((name, size))
        pos += ENTRY_SIZE
    return out


def extract(lac_path: str, out_dir: str) -> list[tuple[str, int]]:
    with open(lac_path, "rb") as f:
        data = f.read()
    entries = read_index(data)
    pos = HEADER_SIZE + len(entries) * ENTRY_SIZE
    os.makedirs(out_dir, exist_ok=True)
    done = []
    for name, size in entries:
        if size == 0:
            continue  # folder record, no payload
        blob = data[pos:pos + size]
        if len(blob) != size:
            raise ValueError(f"{name}: truncated ({len(blob)} != {size})")
        target = os.path.join(out_dir, *name.split("\\"))
        os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
        with open(target, "wb") as f:
            f.write(blob)
        done.append((name, size))
        pos += size
    return done


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("lac")
    ap.add_argument("out_dir", nargs="?")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()
    with open(args.lac, "rb") as f:
        entries = read_index(f.read())
    total = sum(s for _, s in entries)
    print(f"{args.lac}: {len(entries)} files, {total / 1e9:.2f} GB")
    for name, size in entries:
        print(f"  {size:>12,}  {name}")
    if args.out_dir and not args.list:
        for name, size in extract(args.lac, args.out_dir):
            print(f"wrote {name} ({size:,})")


if __name__ == "__main__":
    sys.exit(main())
