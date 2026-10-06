"""Unit tests for tools/build_voice.py exact voice anchor chain (pure)."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

from build_voice import (  # noqa: E402
    jp_norm,
    match_jp_to_mao,
    match_mao_to_en,
    resolve_voice_key,
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