"""One-shot migration: fix misnamed nested-LAC audio (static, no game run).

Background: tools/extract_assets.py:extract_lac_nested() decoded nested
BGM/SE LAC entry names as cp932 instead of XOR-0xFF, so all 165 BGM + 1962
SE files were written as voice-%05d / ic-voice-%05d with sniffed extensions
and the manifest bgm/sfx tables are unrecoverable ordinals. The bytes on
disk are correct audio; only names + manifest keys are wrong.

This script re-extracts ONLY the 4 audio LACs (BGM.PAK, IC/BGM.PAK, SE.PAK,
IC/SE.PAK) with the fixed decoder, writes properly-named files
(BGM_001_A.OGG, SE_0000.wav, ...), deletes the misnamed voice-* files, and
rebuilds the manifest bgm/sfx tables. Everything else in the assets dir is
untouched.

Usage: python3 fix_audio_names.py GAME_DIR ASSETS_DIR
       (run once per assets copy, e.g. .cache/assets and web/public/assets)
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from extract_assets import convert_w, extract_lac_nested  # noqa: E402


def place(payload: bytes, dst: str, name: str, missing: list) -> bool:
    if payload[:4] == b"OggS":
        if not dst.lower().endswith(".ogg"):
            dst = os.path.splitext(dst)[0] + ".ogg"
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as f:
            f.write(payload)
        return True
    # Leaf .w / RIFF -> .wav
    wav = os.path.splitext(dst)[0] + ".wav"
    os.makedirs(os.path.dirname(wav), exist_ok=True)
    tmp = wav + ".tmp"
    if convert_w(payload, tmp, name, missing):
        os.replace(tmp, wav)
        return True
    return False


def main() -> None:
    game, assets = sys.argv[1], sys.argv[2]
    jobs = [
        ("BGM.PAK", "bgm"),
        (os.path.join("IC", "BGM.PAK"), os.path.join("ic", "bgm")),
        ("SE.PAK", "sfx"),
        (os.path.join("IC", "SE.PAK"), os.path.join("ic", "sfx")),
    ]
    import tempfile
    manifest_path = os.path.join(assets, "manifest.json")
    manifest = json.load(open(manifest_path))
    missing: list[str] = []
    new_tables: dict[str, dict[str, str]] = {"bgm": {}, "sfx": {}}
    # delete misnamed predecessors FIRST (voice-* patterns only; real
    # BGM_*/SE_* names never match, but ordering makes that structural).
    removed = 0
    for sub in ("bgm", "sfx", os.path.join("ic", "bgm"),
                os.path.join("ic", "sfx")):
        d = os.path.join(assets, sub)
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            if "voice-" in fn:
                os.unlink(os.path.join(d, fn))
                removed += 1
    print(f"  removed {removed} misnamed voice-* files")
    for pak_rel, sub in jobs:
        pak = os.path.join(game, pak_rel)
        if not os.path.isfile(pak):
            print(f"  skip {pak_rel}: not found")
            continue
        tmp = tempfile.mkdtemp(prefix="wa2fix-")
        inner = extract_lac_nested(pak, tmp)
        table = "bgm" if "bgm" in sub else "sfx"
        n = 0
        for name, _size in inner:
            ipath = os.path.join(tmp, name)
            if not os.path.isfile(ipath):
                # nested LAC names use backslash joins on some entries
                ipath = os.path.join(tmp, *name.split("\\"))
                if not os.path.isfile(ipath):
                    missing.append(f"{pak_rel}:{name}: lost in tmp")
                    continue
            with open(ipath, "rb") as f:
                payload = f.read()
            dst = os.path.join(assets, sub, name)
            if place(payload, dst, name, missing):
                # on-disk name may differ in extension from LAC name
                # (.WAV->.wav); key every plausible spelling. IC entries
                # get ic/-prefixed keys (mirrors the voice table) since
                # IC filenames collide with main-pak names.
                ns = "ic/" if sub.startswith("ic/") else ""
                final = os.path.basename(dst if os.path.exists(dst)
                                        else os.path.splitext(dst)[0] + ".wav")
                rel = os.path.relpath(
                    os.path.join(assets, sub, final), assets)
                for key in {name, name.lower(), final, final.lower()}:
                    if ns:
                        new_tables[table][ns + key] = rel
                        new_tables[table][(ns + key).lower()] = rel
                    else:
                        new_tables[table][key] = rel
                n += 1
        print(f"  {pak_rel}: {n}/{len(inner)} placed -> {sub}/")
    manifest["bgm"] = new_tables["bgm"]
    manifest["sfx"] = new_tables["sfx"]
    json.dump(manifest, open(manifest_path, "w"), indent=1)
    print(f"  manifest bgm={len(new_tables['bgm'])} sfx={len(new_tables['sfx'])}")
    if missing:
        print(f"  {len(missing)} warnings:")
        for m in missing[:10]:
            print(f"    {m}")


if __name__ == "__main__":
    main()
