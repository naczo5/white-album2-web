"""Tests for data bundling and chunked .vpk audio packing (synthetic)."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

import pack_bundle  # noqa: E402


def _slice_from_ref(assets_dir, ref: str) -> tuple[bytes, str]:
    path_part, rest = ref.split("#", 1)
    if ":" in rest:
        span, suffix = rest.split(":", 1)
    else:
        span, suffix = rest, ""
    start, end = (int(x) for x in span.split("-", 1))
    data = (assets_dir / path_part).read_bytes()
    return data[start:end], suffix


def test_staging_never_hardlinks_the_manifest(tmp_path):
    """`assemble_pack` must copy manifest.json, not link it.

    The optimizer and bundler rewrite the manifest in place; a shared
    inode made the second pack run start from an already-bundled file
    (`vpk/...#` refs, `.webp` names with the PNGs pruned) and pack no
    audio at all.
    """
    import assemble_pack

    src = tmp_path / "build" / "assets"
    src.mkdir(parents=True)
    (src / "manifest.json").write_text('{"version": 1}', encoding="utf-8")
    (src / "bg").mkdir()
    (src / "bg" / "a.png").write_bytes(b"png")
    dst = tmp_path / "pack" / "assets"
    assemble_pack.copy_tree_filtered(str(src), str(dst))

    assert (dst / "manifest.json").read_text(encoding="utf-8") == '{"version": 1}'
    # rewriting the staged copy must not touch the build copy
    (dst / "manifest.json").write_text('{"version": 2}', encoding="utf-8")
    assert (src / "manifest.json").read_text(encoding="utf-8") == '{"version": 1}'
    assert os.stat(dst / "manifest.json").st_ino != \
        os.stat(src / "manifest.json").st_ino
    # ordinary media files may still be linked (the space win)
    assert (dst / "bg" / "a.png").read_bytes() == b"png"


def test_bundle_data_merges_scripts_and_prunes(tmp_path):
    data = tmp_path / "data"
    (data / "scripts").mkdir(parents=True)
    (data / "novels").mkdir()
    (data / "novels" / "bonus.pdf").write_bytes(b"%PDF-1.4")
    (data / "scripts" / "index.json").write_text(json.dumps(["1001", "1002"]), encoding="utf-8")
    (data / "scripts" / "1001.json").write_text(json.dumps({"script": "1001", "tokens": 1, "warnings": [], "events": []}), encoding="utf-8")
    (data / "scripts" / "1002.json").write_text(json.dumps({"script": "1002", "tokens": 2, "warnings": [], "events": []}), encoding="utf-8")
    (data / "flow.json").write_text(json.dumps({"version": 1, "nodes": []}), encoding="utf-8")
    (data / "luts.json").write_text(json.dumps({"version": 1, "luts": {"sepia": {"r": [0], "g": [1], "b": [2]}}}), encoding="utf-8")
    (data / "flags.json").write_text("{}", encoding="utf-8")

    stats = pack_bundle.bundle_data(str(data), prune=True)
    assert stats["scenarios"] == 2
    assert stats["prunedFiles"] == 6

    bundle = json.loads((data / "bundle.json").read_text(encoding="utf-8"))
    assert [s["script"] for s in bundle["scenarios"]] == ["1001", "1002"]
    assert bundle["luts"]["luts"]["sepia"]["r"] == [0]
    assert not (data / "scripts").exists()
    assert not (data / "flow.json").exists()
    assert not (data / "flags.json").exists()
    # Novels must remain untouched.
    assert (data / "novels" / "bonus.pdf").is_file()


def test_bundle_delivers_cfg(tmp_path):
    data = tmp_path / "data"
    (data / "scripts").mkdir(parents=True)
    (data / "scripts" / "index.json").write_text(json.dumps(["1001"]), encoding="utf-8")
    (data / "scripts" / "1001.json").write_text(
        json.dumps({"script": "1001", "tokens": 1, "events": []}),
        encoding="utf-8",
    )
    (data / "flow.json").write_text(json.dumps({"version": 1, "nodes": []}), encoding="utf-8")
    cfg_payload = {
        "version": 1,
        "vars": [{"idx": 0, "name": "FLG_00", "init": 0}],
        "scripts": {"1001": {"0": [{"t": "play", "from": 0, "to": 1}, {"t": "sload", "script": "1002", "entry": 0}]}},
    }
    (data / "cfg.json").write_text(json.dumps(cfg_payload), encoding="utf-8")

    stats = pack_bundle.bundle_data(str(data))
    assert stats["scenarios"] == 1
    bundle = json.loads((data / "bundle.json").read_text(encoding="utf-8"))
    assert bundle["cfg"] == cfg_payload

    pack_bundle.bundle_data(str(data), prune=True)
    assert not (data / "cfg.json").exists()


def test_pack_audio_groups_dedups_rolls_chunks_and_prunes(tmp_path):
    assets = tmp_path / "assets"
    (assets / "voice" / "ic").mkdir(parents=True)
    (assets / "sfx").mkdir()
    (assets / "bg").mkdir()
    (assets / "bg" / "b01.webp").write_bytes(b"RIFFwebp")

    v0 = b"OggS-line0-" + b"A" * 20
    v1 = b"OggS-line1-" + b"B" * 20
    v2 = b"OggS-line2-" + b"C" * 20
    s_wav = b"RIFF" + b"\x00" * 16
    s_ogg = b"OggS-sfx-" + b"D" * 10

    (assets / "voice" / "ic" / "1002_0000_10.OGG").write_bytes(v0)
    (assets / "voice" / "ic" / "1002_0001_10.OGG").write_bytes(v1)
    (assets / "voice" / "2001_0000_10.OGG").write_bytes(v2)
    (assets / "sfx" / "SE_0001.WAV").write_bytes(s_wav)
    (assets / "sfx" / "SE_0002.ogg").write_bytes(s_ogg)

    manifest = {
        "version": 1,
        "images": {"b01.tga": "bg/b01.webp"},
        "bgm": {},
        "voice": {
            "ic/1002_0000": "voice/ic/1002_0000_10.OGG",
            "ic/1002_0001": "voice/ic/1002_0001_10.OGG",
            "2001_0000": "voice/2001_0000_10.OGG",
        },
        "sfx": {
            "SE_0001.WAV": "sfx/SE_0001.WAV",
            "SE_0001.wav": "sfx/SE_0001.WAV",  # duplicate alias
            "SE_0002.ogg": "sfx/SE_0002.ogg",
        },
        "movies": {},
    }
    (assets / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    # Small chunk limit forces 1002_0000 and 1002_0001 to split into 000/001.
    stats = pack_bundle.pack_audio(str(assets), chunk_bytes=40, prune=True)
    assert stats["entriesPacked"] == 6
    assert stats["prunedFiles"] == 5

    out = json.loads((assets / "manifest.json").read_text(encoding="utf-8"))
    assert out["images"]["b01.tga"] == "bg/b01.webp"
    assert out["voice"]["ic/1002_0000"].startswith("vpk/voice_ic_1002_000.vpk#")
    assert out["voice"]["ic/1002_0001"].startswith("vpk/voice_ic_1002_001.vpk#")
    assert out["voice"]["2001_0000"].startswith("vpk/voice_2001_000.vpk#")
    assert out["sfx"]["SE_0001.WAV"] == out["sfx"]["SE_0001.wav"]

    assert _slice_from_ref(assets, out["voice"]["ic/1002_0000"]) == (v0, "")
    assert _slice_from_ref(assets, out["voice"]["ic/1002_0001"]) == (v1, "")
    assert _slice_from_ref(assets, out["voice"]["2001_0000"]) == (v2, "")
    assert _slice_from_ref(assets, out["sfx"]["SE_0001.WAV"]) == (s_wav, "wav")
    assert _slice_from_ref(assets, out["sfx"]["SE_0002.ogg"]) == (s_ogg, "")

    assert not (assets / "voice").exists()
    assert not (assets / "sfx").exists()
    assert (assets / "bg" / "b01.webp").is_file()

    # Idempotent re-run leaves .vpk refs intact.
    stats2 = pack_bundle.pack_audio(str(assets), chunk_bytes=40, prune=True)
    assert stats2["entriesPacked"] == 0
