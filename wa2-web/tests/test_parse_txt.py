"""Unit tests for tools/parse_txt.py (synthetic, no assets)."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

import parse_txt as P  # noqa: E402


def enc(s: str) -> bytes:
    return s.encode("cp932")


def test_split_respects_quotes():
    toks = P.split_tokens(enc('A,"x,y",B'))
    assert toks == ["A", '"x,y"', "B"]


def test_say_latch_and_narration():
    toks = P.split_tokens(enc('Haruki,"Ah…",Snow falls.,Setsuna,"Hey."'))
    events, warnings = P.parse_tokens(toks)
    assert warnings == []
    kinds = [e["t"] for e in events]
    assert kinds == ["latch", "say", "narrate", "latch", "say"]
    assert events[1]["t"] == "say" and events[1]["speaker"] == "Haruki" \
        and events[1]["text"] == "Ah…" and events[1]["tok"] == 1
    assert events[2]["text"] == "Snow falls." and events[2]["tok"] == 2


def test_choice_with_marker_after():
    # A CATCH marker after options is preserved as its own jump event;
    # option gotos stay unresolved until play-test confirms the rule.
    toks = P.split_tokens(enc('"t",1. Go,2. Stay,CATCH2,2301'))
    events, warnings = P.parse_tokens(toks)
    ch = [e for e in events if e["t"] == "choice"][0]
    assert [o["text"] for o in ch["options"]] == ["Go", "Stay"]
    assert [o["goto"] for o in ch["options"]] == [None, None]
    jumps = [e for e in events if e["t"] == "jump"]
    assert jumps == [{"t": "jump", "kind": "CATCH2", "targets": ["2301"], "tok": 3}]


def test_router_choice_bare_ids():
    toks = P.split_tokens(enc('1. A,2. B,3. C,2401,2501'))
    events, _ = P.parse_tokens(toks)
    ch = [e for e in events if e["t"] == "choice"][0]
    assert [o["goto"] for o in ch["options"]] == [None, "2401", "2501"]


def test_catch_does_not_swallow_narration():
    toks = P.split_tokens(enc('CATCH2,2020,Prose resumes here.,More prose.'))
    events, _ = P.parse_tokens(toks)
    assert events[0] == {"t": "jump", "kind": "CATCH2", "targets": ["2020"], "tok": 0}
    assert events[1]["text"] == "Prose resumes here."


def test_directives():
    toks = P.split_tokens(enc('mv01,sepia.AMP,b105300.tga,,bak,scene.ani,,grp'))
    events, warnings = P.parse_tokens(toks)
    assert warnings == []
    assert events[0]["t"] == "movie" and events[0]["id"] == "mv01"
    assert events[1]["t"] == "filter" and events[1]["file"] == "sepia.AMP"
    assert events[2]["t"] == "image" and events[2]["file"] == "b105300.tga" \
        and events[2]["layer"] == "bak"
    assert events[3]["t"] == "anim" and events[3]["file"] == "scene.ani" \
        and events[3]["layer"] == "grp"


def test_numeric_image_name_is_not_an_option():
    # `1.tga` matches the option shape (`1.` + text); directive shapes must
    # win or the image becomes choice option 1 with text "tga".
    assert P.classify_bare("1.tga") == "image"
    toks = P.split_tokens(enc('1.tga,,grp'))
    events, _ = P.parse_tokens(toks)
    assert events[0]["t"] == "image" and events[0]["layer"] == "grp"


def test_whisper_style_token():
    toks = P.split_tokens(enc('Chiaki,<F16"Weren\'t you…">'))
    events, warnings = P.parse_tokens(toks)
    assert warnings == []
    say = [e for e in events if e["t"] == "say"][0]
    assert say["speaker"] == "Chiaki" and say["style"] == "whisper"


def test_narration_does_not_latch():
    # Audit B1: a sentence before dialogue stays narration; the line's
    # speaker is unknown, not the sentence.
    toks = P.split_tokens(enc('And then~ she declared:,Haruki,"No."'))
    events, _ = P.parse_tokens(toks)
    assert events[0]["t"] == "narrate" and events[0]["tok"] == 0
    assert events[1] == {"t": "latch", "name": "Haruki", "tok": 1}
    assert events[2]["speaker"] == "Haruki"
    toks = P.split_tokens(enc('And then~ she declared:,"No."'))
    events, _ = P.parse_tokens(toks)
    assert events[0]["t"] == "narrate"
    assert events[1]["t"] == "say" and events[1]["speaker"] == "" \
        and events[1]["text"] == "No."


def test_latch_validation():
    assert P.valid_name("Haruki")
    assert P.valid_name("???")
    assert P.valid_name("Male Student 1")
    assert not P.valid_name("And then~ she declared:")
    assert not P.valid_name("…")
    assert not P.valid_name("………")
    assert not P.valid_name("--")
    assert not P.valid_name("x" * 29)
    assert P.census_name("Haruki")
    assert P.census_name("???")  # unambiguous ,???, marker
    assert not P.census_name("…")
    assert not P.census_name("--")


def test_jp_brackets_dialogue():
    toks = P.split_tokens(enc('武也,「行くぞ」'))
    events, _ = P.parse_tokens(toks)
    assert events[0] == {"t": "latch", "name": "武也", "tok": 0}
    assert events[1]["t"] == "say" and events[1]["speaker"] == "武也" \
        and events[1]["text"] == "行くぞ"
    # unbalanced opener (F16 tail): still dialogue, never narration
    toks = P.split_tokens('「知るかよ。\\n<F16…俺が誘ったのは一人だけだって～の」>'.encode("cp932"))
    events, _ = P.parse_tokens(toks)
    assert events[0]["t"] == "say"


def test_clean_frag_debris():
    assert P.clean_frag('\\n"Hello."') == '"Hello."'
    assert P.clean_frag('"Hello."\\k\\n') == '"Hello."'


def test_inline_markup_preserved_for_renderer():
    toks = P.split_tokens(enc('"How should I know?\\n<F16…I only asked>"'))
    events, _ = P.parse_tokens(toks)
    assert "<F16" in events[0]["text"]  # renderer strips to whisper spans


def test_mega_options_merge_across_speaker_tags():
    # "1. A,Setsuna,2. B" is one choice UI, not two forced single-option
    # screens. The speaker tag is emitted after the merged choice so the
    # following dialogue keeps its latch.
    toks = P.split_tokens(enc('"A,1. Yes,Setsuna,2. No,B"'))
    events, _ = P.parse_tokens(toks)
    events, warnings = P.resplit_mega(events, {"Setsuna"}, [])
    choices = [e for e in events if e["t"] == "choice"]
    assert len(choices) == 1
    assert [o["n"] for o in choices[0]["options"]] == [1, 2]
    assert [o["text"] for o in choices[0]["options"]] == ["Yes", "No"]
    assert events[2] == {"t": "latch", "name": "Setsuna"}
    assert any(w.startswith("MEGA_CHOICE: 2 options") for w in warnings)


def test_mega_fullwidth_option_numbers():
    # JP spine options are fullwidth (１．); a mega structural segment must
    # normalize them instead of raising ValueError.
    assert P.structural_event("１．行く", "")[0] == {
        "t": "_opt", "n": 1, "text": "行く"}
    toks = P.split_tokens(enc('"A,１．行く,２．帰る,B"'))
    events, _ = P.parse_tokens(toks)
    events, _ = P.resplit_mega(events, {"Setsuna"}, [])
    ch = [e for e in events if e["t"] == "choice"][0]
    assert [o["n"] for o in ch["options"]] == [1, 2]


def test_fullwidth_date_not_an_option():
    # 2011.3.x-style date stamps on the JP spine must not become choice rows.
    assert P.classify_bare('２０１１．３．１１') == "text"
    toks = P.split_tokens('２０１１．３．１１,テロップ'.encode('cp932'))
    events, _ = P.parse_tokens(toks)
    assert not any(e['t'] == 'choice' for e in events)
