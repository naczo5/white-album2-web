#!/usr/bin/env python3
"""Bundle scenario JSONs and pack tiny audio files into chunked .vpk archives.

Reduces remote object counts and HTTP requests by orders of magnitude:
- data/bundle.json combines scripts/* and metadata JSONs into 1 request.
- assets/vpk/*.vpk packs voice/* and sfx/* into ~1.5 MB byte-range chunks
  (grouped by script so consecutive voice lines share 1 fetch), updating
  assets/manifest.json entries to "vpk/<chunk>.vpk#<start>-<end>[:wav]".

Usage:
    python3 pack_bundle.py --data PACK/data --assets PACK/assets \
        [--chunk-mb 1.5] [--prune-data] [--prune-audio] [--dry-run]
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import shutil

DEFAULT_CHUNK_BYTES = int(1.5 * 1024 * 1024)

BUNDLE_TOP_FILES = (
    ("flow", "flow.json"),
    ("endings", "endings.json"),
    ("links", "links.json"),
    ("terminals", "terminals.json"),
    ("bgm", "bgm.json"),
    ("bnr", "bnr.json"),
    ("voicemap", "voicemap.json"),
    ("speakers", "speakers.json"),
    ("luts", "luts.json"),
    ("sysSlots", "sys-slots.json"),
)

EXTRA_REDUNDANT_DATA = ("flags.json", "sprites.json")


def _safe_rel(rel: str) -> bool:
    return bool(rel) and not os.path.isabs(rel) and ".." not in rel.replace("\\", "/").split("/")


def human(n: int) -> str:
    val = float(n)
    for u in ("B", "KB", "MB", "GB"):
        if val < 1024 or u == "GB":
            return f"{val:.1f} {u}" if u != "B" else f"{int(val)} B"
        val /= 1024
    return f"{n} B"


def bundle_data(data_dir: str, prune: bool = False, dry_run: bool = False) -> dict:
    index_path = os.path.join(data_dir, "scripts", "index.json")
    flow_path = os.path.join(data_dir, "flow.json")
    if not os.path.isfile(index_path) or not os.path.isfile(flow_path):
        raise SystemExit(f"ERROR: {data_dir} is missing scripts/index.json or flow.json")

    with open(index_path, encoding="utf-8") as f:
        script_ids = json.load(f)

    bundle: dict = {"version": 1, "scenarios": []}
    files_before = 1  # index.json

    for sid in script_ids:
        sp = os.path.join(data_dir, "scripts", f"{sid}.json")
        if not os.path.isfile(sp):
            continue
        files_before += 1
        with open(sp, encoding="utf-8") as f:
            bundle["scenarios"].append(json.load(f))

    for key, fname in BUNDLE_TOP_FILES:
        fp = os.path.join(data_dir, fname)
        if os.path.isfile(fp):
            files_before += 1
            with open(fp, encoding="utf-8") as f:
                bundle[key] = json.load(f)

    out_path = os.path.join(data_dir, "bundle.json")
    raw = json.dumps(bundle, separators=(",", ":"), ensure_ascii=False).encode("utf-8")

    pruned = 0
    if not dry_run:
        with open(out_path, "wb") as f:
            f.write(raw)
        if prune:
            scripts_dir = os.path.join(data_dir, "scripts")
            if os.path.isdir(scripts_dir):
                for _dp, _ds, fs in os.walk(scripts_dir):
                    pruned += len(fs)
                shutil.rmtree(scripts_dir)
            for _key, fname in BUNDLE_TOP_FILES:
                fp = os.path.join(data_dir, fname)
                if os.path.isfile(fp):
                    os.unlink(fp)
                    pruned += 1
            for fname in EXTRA_REDUNDANT_DATA:
                fp = os.path.join(data_dir, fname)
                if os.path.isfile(fp):
                    os.unlink(fp)
                    pruned += 1

    return {
        "scenarios": len(bundle["scenarios"]),
        "bundleBytes": len(raw),
        "filesBefore": files_before,
        "prunedFiles": pruned,
    }


def _voice_group(key: str) -> str:
    m = re.match(r"^((?:ic/)?\d+)_", key)
    return m.group(1) if m else "misc"


def _is_wav(rel: str, data: bytes) -> bool:
    return rel.lower().endswith((".wav", ".w")) or data[:4] == b"RIFF"


def _remove_empty_dirs(root: str, remove_root: bool = False) -> None:
    if not os.path.isdir(root):
        return
    for dp, _ds, _fs in os.walk(root, topdown=False):
        if not remove_root and os.path.abspath(dp) == os.path.abspath(root):
            continue
        try:
            if not os.listdir(dp):
                os.rmdir(dp)
        except OSError:
            pass


def pack_audio(
    assets_dir: str,
    chunk_bytes: int = DEFAULT_CHUNK_BYTES,
    prune: bool = False,
    dry_run: bool = False,
) -> dict:
    manifest_path = os.path.join(assets_dir, "manifest.json")
    if not os.path.isfile(manifest_path):
        raise SystemExit(f"ERROR: missing {manifest_path}")

    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)

    vpk_dir = os.path.join(assets_dir, "vpk")
    if not dry_run:
        os.makedirs(vpk_dir, exist_ok=True)

    packed_rel_to_ref: dict[str, str] = {}
    source_files_to_prune: set[str] = set()
    bytes_before = 0
    bytes_after = 0
    vpk_count = 0
    entries_packed = 0

    def pack_group(table_name: str, prefix: str, keys: list[str]) -> None:
        nonlocal bytes_before, bytes_after, vpk_count, entries_packed
        table = manifest.get(table_name) or {}
        seq = 0
        buf = bytearray()

        def flush() -> None:
            nonlocal seq, buf, bytes_after, vpk_count
            if not buf:
                return
            chunk_name = f"{prefix}_{seq:03d}.vpk"
            if not dry_run:
                with open(os.path.join(vpk_dir, chunk_name), "wb") as out:
                    out.write(buf)
            bytes_after += len(buf)
            vpk_count += 1
            seq += 1
            buf = bytearray()

        for k in sorted(keys):
            rel = table.get(k)
            if not isinstance(rel, str) or "#" in rel or rel.startswith("vpk/") or not _safe_rel(rel):
                continue
            norm_rel = os.path.normpath(rel)
            if norm_rel in packed_rel_to_ref:
                table[k] = packed_rel_to_ref[norm_rel]
                entries_packed += 1
                continue
            src = os.path.join(assets_dir, rel)
            if not os.path.isfile(src):
                continue
            with open(src, "rb") as f:
                data = f.read()
            bytes_before += len(data)
            if buf and len(buf) + len(data) > chunk_bytes:
                flush()
            start = len(buf)
            buf.extend(data)
            end = len(buf)
            suffix = ":wav" if _is_wav(rel, data) else ""
            ref = f"vpk/{prefix}_{seq:03d}.vpk#{start}-{end}{suffix}"
            table[k] = ref
            packed_rel_to_ref[norm_rel] = ref
            source_files_to_prune.add(src)
            entries_packed += 1
        flush()

    voice_table = manifest.get("voice") or {}
    voice_groups: dict[str, list[str]] = collections.defaultdict(list)
    for k in voice_table:
        voice_groups[_voice_group(k)].append(k)
    for grp in sorted(voice_groups):
        safe_grp = grp.replace("/", "_")
        pack_group("voice", f"voice_{safe_grp}", voice_groups[grp])

    sfx_table = manifest.get("sfx") or {}
    if sfx_table:
        pack_group("sfx", "sfx", list(sfx_table.keys()))

    pruned = 0
    manifest_bytes = 0
    if not dry_run:
        raw_manifest = json.dumps(manifest, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        manifest_bytes = len(raw_manifest)
        with open(manifest_path, "wb") as f:
            f.write(raw_manifest)
        if prune:
            for src in source_files_to_prune:
                if os.path.isfile(src):
                    os.unlink(src)
                    pruned += 1
            _remove_empty_dirs(os.path.join(assets_dir, "voice"), remove_root=True)
            _remove_empty_dirs(os.path.join(assets_dir, "sfx"), remove_root=True)
            _remove_empty_dirs(os.path.join(assets_dir, "ic"), remove_root=True)
            for meta in (".opus-done.json", "missing.json"):
                mp = os.path.join(assets_dir, meta)
                if os.path.isfile(mp):
                    os.unlink(mp)
                    pruned += 1

    return {
        "entriesPacked": entries_packed,
        "vpkFiles": vpk_count,
        "bytesBefore": bytes_before,
        "bytesAfter": bytes_after,
        "manifestBytes": manifest_bytes,
        "prunedFiles": pruned,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", help="pack/data directory to bundle into data/bundle.json")
    ap.add_argument("--assets", help="pack/assets directory whose voice/ and sfx/ to pack into vpk/")
    ap.add_argument("--chunk-mb", type=float, default=1.5, help="target max .vpk chunk size in MiB (default: 1.5)")
    ap.add_argument("--prune-data", action="store_true", help="remove redundant individual data JSONs after bundling")
    ap.add_argument("--prune-audio", action="store_true", help="remove original loose voice/ and sfx/ files after packing")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.data and not args.assets:
        ap.error("provide at least one of --data or --assets")

    if args.data:
        ds = bundle_data(os.path.abspath(args.data), prune=args.prune_data, dry_run=args.dry_run)
        print(
            f"data bundle: {ds['scenarios']} scenarios ({ds['filesBefore']} files -> 1 bundle.json, "
            f"{human(ds['bundleBytes'])}, pruned {ds['prunedFiles']})"
        )

    if args.assets:
        chunk_bytes = max(64 * 1024, int(args.chunk_mb * 1024 * 1024))
        aus = pack_audio(
            os.path.abspath(args.assets),
            chunk_bytes=chunk_bytes,
            prune=args.prune_audio,
            dry_run=args.dry_run,
        )
        print(
            f"audio vpk: {aus['entriesPacked']} manifest entries -> {aus['vpkFiles']} .vpk chunks "
            f"({human(aus['bytesBefore'])} -> {human(aus['bytesAfter'])}, pruned {aus['prunedFiles']})"
        )


if __name__ == "__main__":
    main()
