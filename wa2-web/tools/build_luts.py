"""Extract .AMP color-grade LUTs (grp.pak) -> web LUT table JSON.

.AMP files are per-channel tone curves: 3x256 bytes (RGB, e.g.
evening.AMP) or 5x256 bytes (RGB + 2 extra channels, e.g. sepia.AMP).
The web player applies the RGB curves exactly via SVG
feComponentTransfer; channels 3-4 have no documented rendering and are
preserved in the JSON for future mapping (see docs/PARSING.md).

Usage: python3 build_luts.py GAME_GRP_PAK OUT_JSON
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from extract_assets import decode_entry, scan_pak  # noqa: E402


def main() -> None:
    pak, out_path = sys.argv[1], sys.argv[2]
    luts = {}
    for name, flag, stored in scan_pak(pak):
        if not name.lower().endswith(".amp"):
            continue
        _n, payload = decode_entry(name, flag, stored)
        n = len(payload)
        if n not in (256, 768, 1280):
            print(f"  skip {name}: {n} bytes (not 1x/3x/5x256)")
            continue
        ch = [list(payload[i * 256:(i + 1) * 256]) for i in range(n // 256)]
        if n == 256:
            # single-channel LUT (nega = invert): replicate across RGB
            ch = [ch[0], ch[0], ch[0]]
        luts[name.rsplit(".", 1)[0].lower()] = {
            "r": ch[0], "g": ch[1], "b": ch[2],
            "extra": ch[3:] if len(ch) > 3 else [],
        }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "luts": luts}, f)
    print(f"{len(luts)} LUTs -> {out_path}")


if __name__ == "__main__":
    main()
