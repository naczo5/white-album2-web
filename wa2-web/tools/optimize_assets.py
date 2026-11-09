"""Opt-in size pass for a converted asset tree (after extract_assets.py).

    python3 optimize_assets.py BUILD_ASSETS [--webp-quality 90] \
        [--avif-quality 0] [--voice-kbps 32] [--bgm-kbps 96] [--se-kbps 48] \
        [--keep] [--dry-run]

What it does
------------
- PNG images -> WebP (Pillow, quality Q, alpha preserved) or AVIF when
  requested and supported. Manifest *keys* stay engine ids (`b100400.tga`);
  only the URL values change, so the player needs no code change. This is
  the single biggest lever: lossy WebP typically cuts PNG by 60-80%.
- WAV/OGG audio -> Opus in Ogg when ffmpeg is installed. Voice is already
  lossy OGG; re-encoding is a second generation, so it is opt-in and
  reported per table (voice 32 kbps, BGM 96, SE 48 by default).
- Originals are deleted unless --keep. `missing.json` is left alone.

Run tools/pack_site.py afterwards to get exact package sizes.

The conversion is not reversible from the optimized tree; keep the
original paks / an unoptimized assets copy if you may want lossless later.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess



def _safe_rel(rel: str) -> bool:
    return bool(rel) and not os.path.isabs(rel) and ".." not in rel.replace("\\", "/").split("/")


def human(n: int) -> str:
    for u in ("B", "KB", "MB", "GB"):
        if n < 1024 or u == "GB":
            return f"{n:.1f} {u}" if u != "B" else f"{n} B"
        n /= 1024
    return f"{n} B"


def convert_image(src: str, dst: str, quality: int, fmt: str) -> bool:
    try:
        from PIL import Image
    except ImportError:
        print("WARN Pillow not installed; image pass skipped")
        return False
    try:
        with Image.open(src) as im:
            im.load()
            if fmt == "webp":
                im.save(dst, "WEBP", quality=quality, method=6)
            elif fmt == "avif":
                im.save(dst, "AVIF", quality=quality)
            else:
                raise ValueError(fmt)
        return True
    except Exception as e:
        print(f"WARN {src}: {e}")
        return False


def convert_audio(src: str, dst: str, kbps: int) -> bool:
    if not shutil.which("ffmpeg"):
        print("WARN ffmpeg not installed; audio pass skipped")
        return False
    r = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", src,
         "-c:a", "libopus", "-b:a", f"{kbps}k", dst],
        capture_output=True, text=True)
    if r.returncode != 0:
        print(f"WARN {src}: ffmpeg failed: {r.stderr.strip()[-200:]}")
        return False
    return True


def optimize(assets: str, webp_quality: int, avif_quality: int,
             voice_kbps: int, bgm_kbps: int, se_kbps: int,
             keep: bool, dry_run: bool) -> dict:
    manifest_path = os.path.join(assets, "manifest.json")
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)
    before = 0
    after = 0
    changed = 0
    # image pass: one conversion per unique file, rewrite every key pointing
    # at it (the extractor stores name + lowercased alias).
    img_map: dict[str, str] = {}
    for key, rel in list((manifest.get("images") or {}).items()):
        if not isinstance(rel, str) or not _safe_rel(rel):
            continue
        src = os.path.join(assets, rel)
        if not os.path.isfile(src):
            continue
        before += os.path.getsize(src)
        if src in img_map:
            after += os.path.getsize(os.path.join(assets, img_map[src]))
            continue
        fmt = "avif" if avif_quality > 0 else ("webp" if webp_quality > 0 else "")
        if not fmt or not src.lower().endswith((".png", ".bmp", ".tga")):
            after += os.path.getsize(src)
            continue
        dst_rel = os.path.splitext(rel)[0] + f".{fmt}"
        dst = os.path.join(assets, dst_rel)
        if dry_run:
            print(f"would convert {rel} -> {dst_rel}")
            after += os.path.getsize(src)
            continue
        q = avif_quality if fmt == "avif" else webp_quality
        if convert_image(src, dst, q, fmt):
            img_map[src] = dst_rel
            after += os.path.getsize(dst)
            if not keep:
                os.unlink(src)
        else:
            after += os.path.getsize(src)
    for key, rel in list((manifest.get("images") or {}).items()):
        src = os.path.join(assets, rel) if isinstance(rel, str) and _safe_rel(rel) else ""
        if src in img_map:
            manifest["images"][key] = img_map[src]
            changed += 1
    # audio pass: per-table bitrate. Running twice would re-encode an
    # already-Opus `.ogg` (generation loss), so skip entries recorded in
    # `.opus-done.json` and record successes there.
    done_path = os.path.join(assets, ".opus-done.json")
    done_set = set()
    if os.path.isfile(done_path):
        try:
            done_set = set(json.load(open(done_path, encoding="utf-8")))
        except (OSError, ValueError):
            done_set = set()
    for table, kbps in (("voice", voice_kbps), ("bgm", bgm_kbps),
                        ("sfx", se_kbps)):
        if kbps <= 0:
            continue
        for key, rel in list((manifest.get(table) or {}).items()):
            if not isinstance(rel, str) or not _safe_rel(rel):
                continue
            src = os.path.join(assets, rel)
            if not os.path.isfile(src):
                continue
            if f"{table}/{key}" in done_set or rel in done_set:
                after += os.path.getsize(src)
                continue
            before += os.path.getsize(src)
            dst_rel = os.path.splitext(rel)[0] + ".ogg"
            dst = os.path.join(assets, dst_rel)
            if dry_run:
                print(f"would convert {rel} -> {dst_rel} ({kbps}k)")
                after += os.path.getsize(src)
                continue
            same = os.path.abspath(src) == os.path.abspath(dst)
            out = dst + ".tmp.ogg" if same else dst
            if convert_audio(src, out, kbps):
                manifest[table][key] = dst_rel
                changed += 1
                done_set.add(f"{table}/{key}")
                if same:
                    os.replace(out, dst)
                after += os.path.getsize(dst)
                if not keep and not same:
                    os.unlink(src)
            else:
                after += os.path.getsize(src)
    if not dry_run:
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=1)
        with open(done_path, "w", encoding="utf-8") as f:
            json.dump(sorted(done_set), f, indent=1)
    return {"changed": changed, "bytesBefore": before, "bytesAfter": after}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("assets")
    ap.add_argument("--webp-quality", type=int, default=90)
    ap.add_argument("--avif-quality", type=int, default=0,
                    help="use AVIF instead of WebP when > 0 (Pillow build must support it)")
    ap.add_argument("--voice-kbps", type=int, default=32)
    ap.add_argument("--bgm-kbps", type=int, default=96)
    ap.add_argument("--se-kbps", type=int, default=48)
    ap.add_argument("--keep", action="store_true", help="keep source files")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    stats = optimize(os.path.abspath(args.assets), args.webp_quality,
                     args.avif_quality, args.voice_kbps, args.bgm_kbps,
                     args.se_kbps, args.keep, args.dry_run)
    print(f"optimized {stats['changed']} manifest entries: "
          f"{human(stats['bytesBefore'])} -> {human(stats['bytesAfter'])}")
    if args.dry_run:
        print("dry run: manifest not written")


if __name__ == "__main__":
    main()
