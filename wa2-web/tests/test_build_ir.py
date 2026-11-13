"""Unit tests for tools/build_ir.py spine replay + speaker payload rules.

Synthetic token streams only (no game content): the JP spine decides WHAT
each event is, and the EN payload may only contribute text — a narration
row must never be promoted to a speaker latch by the hybrid stream.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

import build_ir  # noqa: E402


def enc(s: str) -> bytes:
    return s.encode("cp932")


def test_replay_spine_never_uses_hybrid_text_as_a_name():
    """A hybrid `text` payload must not be latched as a speaker name."""
    jp = [{"t": "narrate", "tok": 0, "text": "音楽科の松川に、意味もなく罵られ。"},
          {"t": "latch", "name": "春希", "tok": 1},
          {"t": "say", "speaker": "春希", "tok": 2, "text": "「いける…」"}]
    hy = [{"t": "narrate", "tok": 0,
           "text": "Matsukawa had insulted me for no reason."},
          {"t": "narrate", "tok": 1, "text": "Haruki"},
          {"t": "say", "speaker": "", "tok": 2, "text": "This could work…"}]
    build_ir._replay_spine(jp, hy, [])
    assert hy[1] == {"t": "latch", "name": "春希", "tok": 1}
    assert hy[2]["t"] == "say" and hy[2]["speaker"] == "春希"
    assert hy[0]["t"] == "narrate"


def test_replay_spine_fullwidth_unknown_name_normalizes_to_ascii():
    """JP `？？？` latches must surface as the EN `???` tag (IC 1001 68/69)."""
    jp = [{"t": "latch", "name": "？？？", "tok": 68},
          {"t": "say", "speaker": "？？？", "tok": 69,
           "text": "「最低の思い込み、しちゃうよ？」"}]
    hy = [{"t": "latch", "name": "？？？", "tok": 68},
          {"t": "say", "speaker": "？？？", "tok": 69,
           "text": "\"I might convince myself…\""}]
    build_ir._replay_spine(jp, hy, [])
    assert hy[0] == {"t": "latch", "name": "???", "tok": 68}
    assert hy[1]["speaker"] == "???"


def test_replay_spine_ascii_unknown_name_kept():
    jp = [{"t": "latch", "name": "？？？", "tok": 3},
          {"t": "say", "speaker": "？？？", "tok": 4, "text": "「…」"}]
    hy = [{"t": "latch", "name": "???", "tok": 3},
          {"t": "say", "speaker": "???", "tok": 4, "text": '"..."'}]
    build_ir._replay_spine(jp, hy, [])
    assert hy[0]["name"] == "???" and hy[1]["speaker"] == "???"


def test_replay_spine_empty_hybrid_name_falls_back_to_jp():
    jp = [{"t": "latch", "name": "雪菜", "tok": 7},
          {"t": "say", "speaker": "雪菜", "tok": 8, "text": "「うん」"}]
    hy = [{"t": "latch", "name": "", "tok": 7},
          {"t": "say", "speaker": "", "tok": 8, "text": '"Yeah."'}]
    build_ir._replay_spine(jp, hy, [])
    assert hy[0]["name"] == "雪菜"
    assert hy[1]["speaker"] == "雪菜"


def test_replay_spine_hybrid_latch_keeps_its_text_name():
    """A hybrid LATCH row carries the EN name in `text` (resplit shape)."""
    jp = [{"t": "latch", "name": "雪菜", "tok": 3},
          {"t": "say", "speaker": "雪菜", "tok": 4, "text": "「うん」"}]
    hy = [{"t": "latch", "text": "Setsuna", "tok": 3},
          {"t": "say", "speaker": "", "tok": 4, "text": '"Yeah."'}]
    build_ir._replay_spine(jp, hy, [])
    assert hy[0] == {"t": "latch", "name": "Setsuna", "tok": 3}
    # every say in the block now speaks under the EN name
    assert hy[1]["speaker"] == "Setsuna"


def test_replay_spine_narrate_never_donates_its_text_as_a_name():
    """Only a hybrid latch may fall back to `text`; narrate rows may not."""
    jp = [{"t": "latch", "name": "雪菜", "tok": 3}]
    hy = [{"t": "narrate", "text": "Setsuna", "tok": 3}]
    build_ir._replay_spine(jp, hy, [])
    assert hy[0] == {"t": "latch", "name": "雪菜", "tok": 3}


def test_hybrid_build_emits_latch_and_speaker_for_jp_unknown_tag():
    """End-to-end hybrid path: JP `？？？` + EN `???` -> latch/say(???)."""
    jp = enc("前文。,？？？,「これ以上、ここから動こうとしないなら…」")
    en = enc('Narration.,???,"If you still won\'t even try to leave…"')
    ir, _stats = build_ir.build_script_ir(jp, en, None)
    ev = ir["events"]
    assert [e["t"] for e in ev] == ["narrate", "latch", "say"]
    assert ev[1] == {"t": "latch", "name": "???", "tok": 1}
    assert ev[2]["speaker"] == "???" and ev[2]["text"].startswith("If you still")


def test_hybrid_build_keeps_jp_narration_out_of_latch():
    """A hybrid EN sentence that *could* read as a name never latches."""
    jp = enc("音楽科の松川に、意味もなく罵られ。,春希,「いける…」")
    en = enc('Matsukawa had insulted me for no reason.,Haruki,"This could work…"')
    ir, _stats = build_ir.build_script_ir(jp, en, None)
    kinds = [e["t"] for e in ir["events"]]
    assert kinds == ["narrate", "latch", "say"]
    assert ir["events"][1]["name"] == "Haruki"
    assert ir["events"][2]["speaker"] == "Haruki"


def test_manuscript_lines_joins_split_files():
    """`manuscript_lines` folds `_2`, `_3`, ... continuations (3906)."""
    import json
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        idx = {"routes": [{"scripts": [
            {"id": "3906", "file": "coda-3906.json"},
            {"id": "3906_2", "file": "coda-3906_2.json"},
            {"id": "3906_10", "file": "coda-3906_10.json"},
        ]}]}
        with open(os.path.join(tmp, "index.json"), "w") as f:
            json.dump(idx, f)
        for name, tag in (("coda-3906.json", "a"),
                          ("coda-3906_2.json", "b"),
                          ("coda-3906_10.json", "c")):
            with open(os.path.join(tmp, name), "w") as f:
                json.dump({"lines": [{"japanese": tag, "english": tag}]}, f)
        build_ir._man_index_cache.pop(tmp, None)
        rows = build_ir.manuscript_lines(tmp, "3906")
        assert [r["japanese"] for r in rows] == ["a", "b", "c"]