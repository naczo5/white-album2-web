"""Leaf LZSS decompressor for KCAP flag=1 payloads (`.bnr`, `.tga`).

Algorithm (verified: decompresses en.pak `1001.bnr` stored length 1538
-> exactly 8992 bytes starting with magic `LSCR`):

    dict       = bytearray([0x20]) * 0x1000   # prefilled with spaces
    write_ptr  = 0xFEE                        # starts near the end
    stream of flag bytes, LSB-first; per bit group of 8:
        bit 1 -> literal: next byte copied to output + dict[write_ptr]
        bit 0 -> match: two bytes b1, b2;
                 pos = b1 | ((b2 & 0xF0) << 4)
                 length = (b2 & 0x0F) + 3
                 copy `length` bytes from dict[pos...] (overlapping allowed)

Callers must strip the 8-byte DATAHDR (u32 stored_len, u32 original_len)
before calling :func:`decompress`, and may assert len(output) == original_len.
"""

from __future__ import annotations

import struct

DICT_SIZE = 0x1000
DICT_FILL = 0x20
WRITE_START = 0xFEE


def split_datahdr(payload: bytes) -> tuple[int, bytes]:
    """Split a flag=1 entry payload into (original_length, lzss_bytes)."""
    if len(payload) < 8:
        raise ValueError(f"payload too short for DATAHDR: {len(payload)}")
    (stored_len, original_len) = struct.unpack_from("<II", payload, 0)
    if stored_len != len(payload):
        raise ValueError(f"DATAHDR stored_len {stored_len} != actual {len(payload)}")
    return (original_len, payload[8:])


def decompress(data: bytes, expected_len: int | None = None) -> bytes:
    d = bytearray([DICT_FILL]) * DICT_SIZE
    w = WRITE_START
    out = bytearray()
    pos = 0
    n = len(data)
    while pos < n:
        flags = data[pos]
        pos += 1
        for _ in range(8):
            if flags & 1:
                if pos >= n:
                    raise ValueError("truncated literal")
                b = data[pos]
                pos += 1
                out.append(b)
                d[w] = b
                w = (w + 1) % DICT_SIZE
            else:
                if pos + 1 >= n:
                    raise ValueError("truncated match")
                b1 = data[pos]
                b2 = data[pos + 1]
                pos += 2
                ref = b1 | ((b2 & 0xF0) << 4)
                length = (b2 & 0x0F) + 3
                for _ in range(length):
                    b = d[(ref) % DICT_SIZE]
                    out.append(b)
                    d[w] = b
                    w = (w + 1) % DICT_SIZE
                    ref = (ref + 1) % DICT_SIZE
            flags >>= 1
            if pos >= n:
                break
    if expected_len is not None and len(out) != expected_len:
        raise ValueError(f"decompressed {len(out)} != expected {expected_len}")
    return bytes(out)
