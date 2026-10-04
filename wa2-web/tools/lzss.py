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
    # Bulk-oriented: literals accumulate in a chunk; matches copy via
    # slices (length <= 18, ref < 0x1000, so at most one wraparound and
    # usually none). Overlapping matches still copy progressively.
    d = bytearray([DICT_FILL]) * DICT_SIZE
    w = WRITE_START
    out = bytearray()
    lit = bytearray()
    pos = 0
    n = len(data)
    while pos < n:
        flags = data[pos]
        pos += 1
        for _ in range(8):
            if flags & 1:
                if pos >= n:
                    raise ValueError("truncated literal")
                lit.append(data[pos])
                pos += 1
            else:
                if pos + 1 >= n:
                    raise ValueError("truncated match")
                b1 = data[pos]
                b2 = data[pos + 1]
                pos += 2
                ref = b1 | ((b2 & 0xF0) << 4)
                length = (b2 & 0x0F) + 3
                if lit:
                    out.extend(lit)
                    m = len(lit)
                    first = m if w + m <= DICT_SIZE else DICT_SIZE - w
                    d[w:w + first] = lit[:first]
                    if first < m:
                        d[0:m - first] = lit[first:]
                    w = (w + m) % DICT_SIZE
                    del lit[:]
                # Bulk copy is safe iff source and destination ranges do
                # not overlap: match distance >= length. (Overlapping
                # matches must read bytes they just wrote, progressively.)
                dist = (w - ref) % DICT_SIZE
                if dist >= length:
                    if ref + length <= DICT_SIZE:
                        seq = bytes(d[ref:ref + length])
                    else:
                        seq = bytes(d[ref:] + d[:ref + length - DICT_SIZE])
                    out.extend(seq)
                    if w + length <= DICT_SIZE:
                        d[w:w + length] = seq
                    else:
                        first = DICT_SIZE - w
                        d[w:] = seq[:first]
                        d[:length - first] = seq[first:]
                    w = (w + length) % DICT_SIZE
                else:
                    for _ in range(length):
                        b = d[ref]
                        out.append(b)
                        d[w] = b
                        w += 1
                        if w == DICT_SIZE:
                            w = 0
                        ref += 1
                        if ref == DICT_SIZE:
                            ref = 0
            flags >>= 1
            if pos >= n:
                break
    if lit:
        out.extend(lit)
    if expected_len is not None and len(out) != expected_len:
        raise ValueError(f"decompressed {len(out)} != expected {expected_len}")
    return bytes(out)
