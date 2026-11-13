"""Unit tests for tools/build_voice.py exact voice anchor chain (pure)."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

from build_voice import (  # noqa: E402
    jp_norm,
    load_mao_index,
    load_mao_lines,
    manuscript_files,
    match_jp_to_mao,
    match_mao_to_en,
    resolve_voice_key,
    speaker_name_map,
)


def test_jp_norm_strips_ruby_readings():
    # engine ruby <R surface|reading> keeps the surface only
    assert jp_norm("小難しい<R小難しい曲|こむずかしいの>ばっか") == \
        "小難しい小難しい曲ばっか"
    assert jp_norm("「そ、そう？」") == "そそう"
    assert jp_norm("………") == ""


def test_match_jp_to_mao_containment_and_gapfill():
    jp = ["こんにちは", "………", "さようなら"]
    mao = ["こんにちは", "………", "さようななら"]  # ellipsis row absent from
    # manuscript is absent -> gap fill must not invent it; delta differs
    got = match_jp_to_mao(jp, [m.replace("なら", "") for m in mao])
    assert got[0] == 0
    # exact same-length lists align 1:1 including empty rows
    got = match_jp_to_mao(jp, mao)
    assert got == {0: 0, 1: 1, 2: 2}


def test_match_jp_to_mao_merged_rows():
    # manuscript merges two JP rows into one line
    jp = ["春希だ", "雪菜だ"]
    mao = ["春希だ、雪菜だ", "次の行"]
    got = match_jp_to_mao(jp, mao)
    assert got[0] == 0 and got[1] == 0


def test_match_mao_to_en_first_event_wins():
    mao_en = ["wait for me and also go home", "next line"]
    mao_jp = ["", ""]
    # first two fragments of line 0, then line 1
    events = [("wait", ""), ("for me", ""), ("next line", "")]
    j2e, e2j = match_mao_to_en(mao_en, mao_jp, events)
    assert j2e == {0: 0, 1: 2}
    assert e2j == {0: 0, 1: 0, 2: 1}


def test_match_mao_to_en_jp_fallback_for_untranslated_events():
    # untranslated (JP) engine events match via the manuscript Japanese
    mao_en = ["", ""]
    mao_jp = ["春希だよ", "雪菜だよ"]
    events = [("", jp_norm("「春希だよ」")), ("", jp_norm("雪菜だよ"))]
    j2e, _e2j = match_mao_to_en(mao_en, mao_jp, events)
    assert j2e == {0: 0, 1: 1}


def test_resolve_voice_key_family_base():
    main = {"1008_0199", "2031_0612", "2031_0000"}
    ic = {"1002_0000", "1006_0534"}
    assert resolve_voice_key("1008", 199, main, ic) == "1008_0199"
    assert resolve_voice_key("1008_020", 199, main, ic) == "1008_0199"
    assert resolve_voice_key("2031_3", 612, main, ic) == "2031_0612"
    assert resolve_voice_key("1002", 0, main, ic) == "ic/1002_0000"
    assert resolve_voice_key("1006_2", 534, main, ic) == "ic/1006_0534"
    # unknown everywhere -> None (unvoiced, never a guess)
    assert resolve_voice_key("4009", 0, main, ic) is None
    # main pak wins over ic on ambiguity
    both_main = main | {"1002_0000"}
    assert resolve_voice_key("1002", 0, both_main, ic) == "1002_0000"


def test_speaker_name_map_majority_vote():
    lines = ([{"speakerJa": "春希", "speakerEn": "Haruki"}] * 10 +
             [{"speakerJa": "武也", "speakerEn": "Takeya"}] * 5 +
             [{"speakerJa": "朋", "speakerEn": "Tomo"}] * 4)
    got = speaker_name_map(lines)
    assert got["武也"] == "Takeya"
    assert got["朋"] == "Tomo"
    assert got["春希"] == "Haruki"


def test_speaker_name_map_rejects_ambiguous_and_thin_votes():
    lines = ([{"speakerJa": "謎", "speakerEn": "A"}] * 3 +
             [{"speakerJa": "謎", "speakerEn": "B"}] * 3 +
             [{"speakerJa": "脇", "speakerEn": "Extra"}] * 2)
    got = speaker_name_map(lines)
    assert "謎" not in got  # 50/50 split: stay on the JP name
    assert "脇" not in got  # fewer than 3 votes


def test_speaker_name_map_maps_fullwidth_unknown_tag():
    # 1001/1007 latches carry `？？？`; the UI must never show it beside
    # EN cast names.
    assert speaker_name_map([])["？？？"] == "???"


def _mk_mao(tmp: str, files: dict[str, str], idx: list[dict]) -> dict:
    import json
    with open(os.path.join(tmp, "index.json"), "w") as f:
        json.dump({"routes": [{"scripts": idx}]}, f)
    for name, tag in files.items():
        with open(os.path.join(tmp, name), "w") as f:
            json.dump({"lines": [
                {"japanese": tag, "english": tag,
                 "speakerJa": tag.upper(), "speakerEn": tag.upper()}
            ]}, f)
    return load_mao_index(tmp)


def test_manuscript_files_includes_numeric_continuations():
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        idx = _mk_mao(tmp, {"coda-3906.json": "a", "coda-3906_2.json": "b",
                            "coda-3907.json": "x"},
                      [{"id": "3906", "file": "coda-3906.json"},
                       {"id": "3906_2", "file": "coda-3906_2.json"},
                       {"id": "3907", "file": "coda-3907.json"}])
        got = [os.path.basename(p) for p in manuscript_files(idx, "3906")]
        assert got == ["coda-3906.json", "coda-3906_2.json"]
        assert [os.path.basename(p) for p in manuscript_files(idx, "3907")] \
            == ["coda-3907.json"]


def test_load_mao_lines_joins_continuations_for_speaker_votes():
    """3906's 武也/朋 live only in coda-3906_2.json: the join must see them."""
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        import json
        with open(os.path.join(tmp, "index.json"), "w") as f:
            json.dump({"routes": [{"scripts": [
                {"id": "3906", "file": "coda-3906.json"},
                {"id": "3906_2", "file": "coda-3906_2.json"},
            ]}]}, f)
        with open(os.path.join(tmp, "coda-3906.json"), "w") as f:
            json.dump({"lines": [
                {"speakerJa": "春希", "speakerEn": "Haruki", "japanese": "a",
                 "english": "a"}] * 5}, f)
        with open(os.path.join(tmp, "coda-3906_2.json"), "w") as f:
            json.dump({"lines": [
                {"speakerJa": "武也", "speakerEn": "Takeya", "japanese": "b",
                 "english": "b"}] * 4 +
                [{"speakerJa": "朋", "speakerEn": "Tomo", "japanese": "c",
                  "english": "c"}] * 3}, f)
        import build_voice
        idx = build_voice.load_mao_index(tmp)
        lines = load_mao_lines(idx, "3906")
        assert len(lines) == 12
        got = speaker_name_map(lines)
        assert got["武也"] == "Takeya" and got["朋"] == "Tomo"
        assert got["春希"] == "Haruki"
