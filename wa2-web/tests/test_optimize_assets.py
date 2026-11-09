"""Opt-in asset size pass (synthetic; no game content)."""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

import optimize_assets  # noqa: E402


def make_png(path: str) -> None:
    from PIL import Image
    im = Image.new("RGBA", (64, 64), (20, 40, 80, 255))
    im.save(path, "PNG")


def test_image_pass_rewrites_manifest_and_shrinks(tmp_path):
    pytest.importorskip("PIL")
    assets = tmp_path
    (assets / "images").mkdir()
    make_png(str(assets / "images" / "b100400.png"))
    manifest = {
        "version": 1,
        "images": {
            "b100400.tga": "images/b100400.png",
            "b100400.TGA": "images/b100400.png",
        },
        "bgm": {}, "sfx": {}, "voice": {}, "movies": {},
    }
    (assets / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    stats = optimize_assets.optimize(str(assets), 80, 0, 0, 0, 0, False, False)
    assert stats["changed"] == 2
    out = json.loads((assets / "manifest.json").read_text(encoding="utf-8"))
    assert out["images"]["b100400.tga"] == "images/b100400.webp"
    assert out["images"]["b100400.TGA"] == "images/b100400.webp"
    assert (assets / "images" / "b100400.webp").is_file()
    assert not (assets / "images" / "b100400.png").exists()


def test_dry_run_leaves_files_and_manifest(tmp_path):
    pytest.importorskip("PIL")
    assets = tmp_path
    (assets / "images").mkdir()
    make_png(str(assets / "images" / "a.png"))
    manifest = {"version": 1, "images": {"a.tga": "images/a.png"},
                "bgm": {}, "sfx": {}, "voice": {}, "movies": {}}
    (assets / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    optimize_assets.optimize(str(assets), 80, 0, 0, 0, 0, False, True)
    out = json.loads((assets / "manifest.json").read_text(encoding="utf-8"))
    assert out["images"]["a.tga"] == "images/a.png"
    assert (assets / "images" / "a.png").is_file()


def test_audio_pass_skips_without_ffmpeg(tmp_path):
    if __import__("shutil").which("ffmpeg"):
        pytest.skip("ffmpeg present; covered by a real convert")
    src = tmp_path / "a.wav"
    src.write_bytes(b"RIFF" + b"\x00" * 64)
    assert not optimize_assets.convert_audio(str(src), str(tmp_path / "a.ogg"), 32)
