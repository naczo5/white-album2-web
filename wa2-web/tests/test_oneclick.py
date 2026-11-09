"""One-click bootstrap unit tests (no network, no game content)."""

import json
import argparse
import pytest
import os
import sys
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

import oneclick  # noqa: E402


def touch(p):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x")


def test_locate_game_root_prefers_complete_pak_dir(tmp_path):
    touch(tmp_path / "junk" / "script.pak")
    touch(tmp_path / "game" / "script.pak")
    touch(tmp_path / "game" / "bak.pak")
    touch(tmp_path / "game" / "char.pak")
    touch(tmp_path / "game" / "grp.pak")
    assert oneclick.locate_game_root(tmp_path) == tmp_path / "game"


def test_canonicalize_tree_fixes_iso_cases(tmp_path):
    touch(tmp_path / "SCRIPT.PAK")
    touch(tmp_path / "VOICE.pak")
    touch(tmp_path / "ic" / "BGM.PAK")
    oneclick.canonicalize_tree(tmp_path)
    assert (tmp_path / "script.pak").is_file()
    assert (tmp_path / "VOICE.PAK").is_file()
    assert (tmp_path / "IC" / "BGM.PAK").is_file()
    assert not (tmp_path / "ic").exists()


def test_find_mao_paks_categorizes_main_and_special(tmp_path):
    touch(tmp_path / "Main Game" / "Windows" / "game files" / "en.pak")
    touch(tmp_path / "WHITE ALBUM 2 Special Contents" / "patch" / "en.pak")
    main, special = oneclick.find_mao_paks(tmp_path)
    assert main is not None and "Main Game" in str(main)
    assert special is not None and "Special Contents" in str(special)


def test_safe_name_strips_traversal():
    assert oneclick.safe_name("../../etc/passwd") == "etc/passwd"
    assert oneclick.safe_name("a/../../b") == "a/b"


def test_extract_zip_and_config(tmp_path):
    z = tmp_path / "disc.zip"
    with zipfile.ZipFile(z, "w") as f:
        f.write(__file__, "game/SCRIPT.PAK")
        f.write(__file__, "game/bak.pak")
    out = tmp_path / "out"
    oneclick.extract_zip(z, out)
    assert (out / "game" / "SCRIPT.PAK").is_file()
    cfg = tmp_path / "cfg.json"
    cfg.write_text(json.dumps({
        "images": ["disc1.iso", "disc2.iso"], "assets": False,
        "serve": False, "port": 8123,
    }), encoding="utf-8")
    args = oneclick.parse_args(["--config", str(cfg)])
    assert args.image == ["disc1.iso", "disc2.iso"]
    assert args.assets is False and args.serve is False and args.port == 8123


def test_attach_ic_symlink(tmp_path):
    main = tmp_path / "disc1" / "Game"
    ic = tmp_path / "disc1" / "IC"
    touch(main / "script.pak")
    touch(ic / "BGM.PAK")
    oneclick.attach_ic_dir(main, tmp_path)
    assert (main / "IC").exists()
    assert (main / "IC" / "BGM.PAK").exists()


def test_archive_item_selection_prefers_original_iso(tmp_path):
    from types import SimpleNamespace
    meta = {"metadata": {"identifier": "example"}, "files": [
        {"name": "wa2_disc1.iso", "size": str(2 << 30), "md5": "a" * 32},
        {"name": "wa2_disc2.iso", "size": str(2 << 30), "md5": "b" * 32},
        {"name": "wa2.part1.rar", "size": str(2 << 30)},
        {"name": "wa2_files.xml", "size": "10"},
    ]}
    meta_path = tmp_path / "item.json"
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    args = SimpleNamespace(
        archive_item=["https://archive.org/details/example"],
        include="*.iso,*.rar", min_file_mb=1, i_own_the_game=True,
        skip_space_check=True, item_metadata=str(meta_path),
        workdir=tmp_path / "wd", download_missing=False)
    args.workdir.mkdir(parents=True)
    got = oneclick.archive_items(args)
    assert [n for n, _u, _s, _m in got] == ["wa2_disc1.iso", "wa2_disc2.iso"]


def test_archive_item_requires_local_metadata(tmp_path):
    from types import SimpleNamespace
    args = SimpleNamespace(
        archive_item=["https://archive.org/details/example"],
        include="*.iso", min_file_mb=50, i_own_the_game=True,
        skip_space_check=True, item_metadata=None,
        workdir=tmp_path / "wd", download_missing=False)
    args.workdir.mkdir(parents=True)
    with pytest.raises(SystemExit) as e:
        oneclick.archive_items(args)
    assert "metadata is not cached" in str(e.value)



def test_novels_are_preserved_and_injected(tmp_path, monkeypatch):
    from types import SimpleNamespace
    web = tmp_path / "web"
    src = web / "public" / "data" / "novels"
    src.mkdir(parents=True)
    (src / "novel.pdf").write_bytes(b"pdf")
    monkeypatch.setattr(oneclick, "WEB", web)
    args = SimpleNamespace(workdir=tmp_path / "work")
    (tmp_path / "work").mkdir()
    kept = oneclick.preserve_novels(args)
    assert kept and (kept / "novel.pdf").is_file()
    build = tmp_path / "build"
    oneclick.inject_novels(kept, build)
    assert (build / "data" / "novels" / "novel.pdf").is_file()


def test_extract_iso_roundtrip(tmp_path):
    pytest = __import__("pytest")
    pycdlib = pytest.importorskip("pycdlib")
    import io
    iso_path = tmp_path / "t.iso"
    iso = pycdlib.PyCdlib()
    iso.new(interchange_level=3, joliet=3, rock_ridge="1.09")
    data = b"FAKEPAK"
    iso.add_fp(io.BytesIO(data), len(data), "/SCRIPT.PAK;1",
               rr_name="script.pak", joliet_path="/script.pak")
    iso.write(str(iso_path))
    iso.close()
    out = tmp_path / "out"
    assert oneclick.extract_iso(iso_path, out)
    oneclick.canonicalize_tree(out)
    assert (out / "script.pak").read_bytes() == data


def test_extract_7z_roundtrip(tmp_path):
    pytest = __import__("pytest")
    py7zr = pytest.importorskip("py7zr")
    src = tmp_path / "g"
    src.mkdir()
    (src / "script.pak").write_bytes(b"x")
    z = tmp_path / "g.7z"
    with py7zr.SevenZipFile(z, "w") as a:
        a.writeall(str(src), "g")
    out = tmp_path / "out"
    assert oneclick.extract_7z(z, out)
    assert (out / "g" / "script.pak").is_file()


def make_sheet(tmp_path, files):
    import json
    p = tmp_path / "hashes.json"
    p.write_text(json.dumps({"version": 1, "item": "example", "files": files}),
                 encoding="utf-8")
    return p


def test_verify_sheet_ok_advisory_and_strict(tmp_path):
    from types import SimpleNamespace
    sheet = make_sheet(tmp_path, [
        {"name": "disc1.rar", "size": 11, "md5": "5eb63bbbe01eeed093cb22bb8f5acdc3"},
        {"name": "cover.png", "size": 5, "md5": "c410987cdea585256a19e903905182f2"},
    ])
    (tmp_path / "disc1.rar").write_bytes(b"hello world")  # md5 41011…
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "cover.png").write_bytes(b"heya!")  # md5 1017…
    args = SimpleNamespace(
        hashes=str(sheet), game_dir=None, source_dir=[str(tmp_path)],
        image=[], archive_item=[], strict_hashes=True,
        workdir=tmp_path / "wd", item_metadata=None)
    args.workdir.mkdir()
    assert oneclick.verify_sheet(args) == "archive copy verified: 2/2 files"


def test_verify_sheet_missing_is_advisory(tmp_path):
    sheet = make_sheet(tmp_path, [
        {"name": "disc1.rar", "size": 11, "md5": "5eb63bbbe01eeed093cb22bb8f5acdc3"}])
    from types import SimpleNamespace
    args = SimpleNamespace(
        hashes=str(sheet), game_dir=None, source_dir=[str(tmp_path / "empty")],
        image=[], archive_item=[], strict_hashes=False,
        workdir=tmp_path / "wd", item_metadata=None)
    (tmp_path / "empty").mkdir()
    args.workdir.mkdir()
    assert oneclick.verify_sheet(args) == "mismatch"


def test_verify_sheet_disabled(tmp_path):
    from types import SimpleNamespace
    args = SimpleNamespace(
        hashes="", game_dir=None, source_dir=[], image=[], archive_item=[],
        strict_hashes=False, workdir=tmp_path / "wd", item_metadata=None)
    args.workdir.mkdir()
    assert oneclick.verify_sheet(args) == "skipped"


def test_verify_only_with_repo_sheet(tmp_path, monkeypatch):
    import hashlib
    big = tmp_path / "disc1.rar"
    payload = b"x" * (1 << 21)
    big.write_bytes(payload)
    sheet = make_sheet(tmp_path, [
        {"name": "disc1.rar", "size": len(payload),
         "md5": hashlib.md5(payload).hexdigest()},
    ])
    args = argparse.Namespace(
        hashes=str(sheet), source_dir=[str(tmp_path)], item_metadata=None,
        game_dir=None, image=[], archive_item=[], strict_hashes=False,
        workdir=tmp_path / "wd", download_missing=False)
    args.workdir.mkdir()
    oneclick.run_item_verification(args)
    assert "OK" in (args.workdir / "verify-report.txt").read_text(encoding="utf-8")
