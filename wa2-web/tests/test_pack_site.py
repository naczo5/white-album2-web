"""Packaging tool smoke test (synthetic, no game assets)."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

import pack_site  # noqa: E402


def test_pack_site_selftest():
    pack_site.selftest()


def test_compact_json(tmp_path):
    p = tmp_path / "a.json"
    p.write_text('{\n  "a": 1,\n  "b": "\u96ea"\n}\n', encoding="utf-8")
    assert pack_site.compact_json(str(tmp_path)) == 1
    assert p.read_text(encoding="utf-8") == '{"a":1,"b":"\u96ea"}'


def test_human_sizes():
    assert pack_site.human(0) == "0 B"
    assert pack_site.human(1023) == "1023 B"
    assert pack_site.human(1024) == "1.0 KB"
    assert pack_site.human(1536) == "1.5 KB"
    assert pack_site.human(1024 ** 3) == "1.0 GB"
