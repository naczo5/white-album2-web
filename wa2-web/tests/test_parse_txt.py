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
    assert events[1] == {"t": "say", "speaker": "Haruki", "text": "Ah…"}
    assert events[2]["text"] == "Snow falls."


def test_choice_with_marker_after():
    # A CATCH marker after options is preserved as its own jump event;
    # option gotos stay unresolved until play-test confirms the rule.
    toks = P.split_tokens(enc('"t",1. Go,2. Stay,CATCH2,2301'))
    events, warnings = P.parse_tokens(toks)
    ch = [e for e in events if e["t"] == "choice"][0]
    assert [o["text"] for o in ch["options"]] == ["Go", "Stay"]
    assert [o["goto"] for o in ch["options"]] == [None, None]
    jumps = [e for e in events if e["t"] == "jump"]
    assert jumps == [{"t": "jump", "kind": "CATCH2", "targets": ["2301"]}]


def test_router_choice_bare_ids():
    toks = P.split_tokens(enc('1. A,2. B,3. C,2401,2501'))
    events, _ = P.parse_tokens(toks)
    ch = [e for e in events if e["t"] == "choice"][0]
    assert [o["goto"] for o in ch["options"]] == [None, "2401", "2501"]


def test_catch_does_not_swallow_narration():
    toks = P.split_tokens(enc('CATCH2,2020,Prose resumes here.,More prose.'))
    events, _ = P.parse_tokens(toks)
    assert events[0] == {"t": "jump", "kind": "CATCH2", "targets": ["2020"]}
    assert events[1]["text"] == "Prose resumes here."


def test_directives():
    toks = P.split_tokens(enc('mv01,sepia.AMP,b105300.tga,,bak,scene.ani,,grp'))
    events, warnings = P.parse_tokens(toks)
    assert warnings == []
    assert events[0] == {"t": "movie", "id": "mv01"}
    assert events[1] == {"t": "bgm", "file": "sepia.AMP"}
    assert events[2] == {"t": "image", "file": "b105300.tga", "layer": "bak"}
    assert events[3] == {"t": "anim", "file": "scene.ani", "layer": "grp"}


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
    assert events[0] == {"t": "narrate", "text": "And then~ she declared:"}
    assert events[1] == {"t": "latch", "name": "Haruki"}
    assert events[2]["speaker"] == "Haruki"
    toks = P.split_tokens(enc('And then~ she declared:,"No."'))
    events, _ = P.parse_tokens(toks)
    assert events[0]["t"] == "narrate"
    assert events[1] == {"t": "say", "speaker": "", "text": "No."}


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
    assert events[0] == {"t": "latch", "name": "武也"}
    assert events[1] == {"t": "say", "speaker": "武也", "text": "行くぞ"}
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
