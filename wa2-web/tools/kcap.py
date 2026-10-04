"""Leaf KCAP archive parser (WHITE ALBUM 2 Extended Edition `.pak` family).

Layout (verified byte-for-byte against MAO v1.3.6 `en.pak`, 78,973,128 bytes,
and cross-checked with hoshino-yui/wa2recode `kcap_types.h` + AllenHeartcore
`WhiteAlbum2_Unpaker` notes):

    KCAPHDR  (16 B): magic b'KCAP', u32 unknown1, u32 unknown2, u32 entry_count
    KCAPENTRY(44 B): u32 flag, char filename[24], u32 unknown1, u32 unknown2,
                     u32 offset (absolute file offset), u32 length

`flag` meanings:
    0xCCCCCCCC -> folder placeholder (length 0, no data; e.g. bak/fnt/grp/script)
    0          -> raw stored file (scenario `.txt`: Shift-JIS token streams)
    1          -> LZSS-compressed file: 8-byte DATAHDR
                   (u32 stored_length == entry.length, u32 original_length)
                   followed by (length - 8) bytes of LZSS data
                   (`.bnr` LSCR tracks, `.tga` images)

NOTE on a common misreading: the byte pattern FF FF FF FF FF FF 00 00 that
appears every 44 bytes is the per-entry (unknown1=0xFFFFFFFF,
unknown2=0x0000FFFF) pair at entry_offset+28 -- it is NOT an entry marker,
and entries do NOT start there. Entries start 28 bytes earlier.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

MAGIC = b"KCAP"
HEADER_SIZE = 16
ENTRY_SIZE = 44
FOLDER_FLAG = 0xCCCCCCCC
FLAG_RAW = 0
FLAG_LZSS = 1


@dataclass
class KcapEntry:
    name: str
    flag: int
    offset: int
    length: int

    @property
    def is_folder(self) -> bool:
        return self.flag == FOLDER_FLAG

    @property
    def is_compressed(self) -> bool:
        return self.flag == FLAG_LZSS


def read_index(data: bytes) -> list[KcapEntry]:
    """Parse the KCAP header + entry table. Raises ValueError on bad magic."""
    if data[:4] != MAGIC:
        raise ValueError(f"bad KCAP magic: {data[:4]!r}")
    (unk1, unk2, count) = struct.unpack_from("<III", data, 4)
    entries: list[KcapEntry] = []
    pos = HEADER_SIZE
    for _ in range(count):
        (flag,) = struct.unpack_from("<I", data, pos)
        raw_name = data[pos + 4 : pos + 28]
        name = raw_name.split(b"\x00")[0].decode("ascii", errors="replace")
        (_u1, _u2, offset, length) = struct.unpack_from("<IIII", data, pos + 28)
        entries.append(KcapEntry(name=name, flag=flag, offset=offset, length=length))
        pos += ENTRY_SIZE
    return entries


def data_range(entry: KcapEntry) -> tuple[int, int]:
    """Absolute (start, end) byte range of an entry's stored payload."""
    return (entry.offset, entry.offset + entry.length)


def census(entries: list[KcapEntry]) -> dict:
    """Small inventory helper used by tests and the asset pipeline."""
    out: dict = {"total": len(entries), "folders": 0, "raw": 0, "compressed": 0, "by_ext": {}}
    for e in entries:
        if e.is_folder:
            out["folders"] += 1
            continue
        out["raw" if not e.is_compressed else "compressed"] += 1
        ext = e.name.rsplit(".", 1)[-1].lower() if "." in e.name else "(none)"
        out["by_ext"][ext] = out["by_ext"].get(ext, 0) + 1
    return out
