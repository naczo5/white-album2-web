"""Unit tests for the ASS -> WebVTT movie subtitle converter.

Synthetic subtitle text only (the MAO Movie Patcher `.ass` sources are game
content and never committed). Covers timestamp math, style-level + inline
italic/bold mapping, `[Script Info]` frame geometry, top-vs-bottom and
column placement, drawing-block skipping, chronological sort, and the
manifest hygiene rules (`--subs-only` guard + stale-track pruning).
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

import extract_assets as EA  # noqa: E402


ASS_HEAD = """[Script Info]
Title: synthetic
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: SongBottom,Baskervville,44,&H00FFFFFF,&H00FFFFFF,&H00101828,&H90000000,0,-1,0,0,100,100,0,0,1,2.4,1.2,2,64,64,22,1
Style: SongTop,Baskervville,44,&H00FFFFFF,&H00FFFFFF,&H00101828,&H90000000,0,-1,0,0,100,100,0,0,1,2.4,1.2,8,64,64,22,1
Style: Narrative,Baskervville,46,&H00E8EDF5,&H00FFFFFF,&H00202A38,&H90000000,0,-1,0,0,100,100,1,0,1,2.4,1.0,8,64,64,0,1
Style: Profile,Arimo,28,&H00FFFFFF,&H00FFFFFF,&H00101828,&H90000000,-1,0,0,0,100,100,0,0,1,2.4,1.0,7,0,0,0,1
Style: Credit,Arimo,30,&H00FFFFFF,&H00FFFFFF,&H00101828,&H90000000,-1,0,0,0,100,100,0,0,1,2.4,1.0,1,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def ass(body: str) -> str:
    return ASS_HEAD + body + "\n"


def cues(vtt: str) -> list[tuple[str, str, list[str]]]:
    """Parse a WebVTT document back into (start, settings, text lines)."""
    out = []
    blocks = vtt.strip().split("\n\n")[1:]
    for b in blocks:
        lines = b.split("\n")
        timing = lines[0]
        start, rest = timing.split(" --> ")
        end, _, settings = rest.partition(" ")
        out.append((start, settings, lines[1:]))
    assert all("WEBVTT" in l for l in vtt.split("\n")[:1])
    return out


def body_lines(vtt: str) -> list[str]:
    return ["\n".join(c[2]) for c in cues(vtt)]


def test_ass_time_ms_centiseconds_and_milliseconds():
    assert EA.ass_time_ms("0:00:01.50") == 1500
    assert EA.ass_time_ms("0:00:06.00") == 6000
    assert EA.ass_time_ms("1:02:03.45") == 3723450
    assert EA.ass_time_ms("0:00:01.500") == 1500
    assert EA.ass_time_ms("bogus") is None


def test_vtt_time_formats_milliseconds():
    assert EA.vtt_time(0) == "00:00:00.000"
    assert EA.vtt_time(1500) == "00:00:01.500"
    assert EA.vtt_time(3723450) == "01:02:03.450"


def test_ass_text_tag_mapping():
    body, drawing = EA.ass_text_to_vtt(r"{\i1}line one{\i0}\Nline two")
    assert body == "<i>line one</i>\nline two"
    assert not drawing
    body, _ = EA.ass_text_to_vtt(r"{\b1}loud{\b0}\nsoft")
    assert body == "<b>loud</b>\nsoft"
    # other override tags are stripped, never leaked into the cue text
    body, _ = EA.ass_text_to_vtt(r"{\an8\pos(640,410)\fad(180,180)}Hi")
    assert body == "Hi"
    body, _ = EA.ass_text_to_vtt(r"one{\i1}two")
    assert "{" not in body and "<i>" in body


def test_ass_text_skips_drawing_blocks():
    _body, drawing = EA.ass_text_to_vtt(r"{\p1}m 0 0 l 100 100{\p0}")
    assert drawing


def test_ass_header_reads_play_res_and_style_flags():
    (res_x, res_y), styles = EA.ass_header(ASS_HEAD + "\n")
    assert (res_x, res_y) == (1280, 720)
    assert styles["Narrative"]["italic"] is True
    assert styles["Narrative"]["bold"] is False
    assert styles["Profile"]["bold"] is True  # Bold: -1 means enabled
    assert styles["Profile"]["italic"] is False
    assert styles["SongTop"]["alignment"] == 8
    assert styles["Credit"]["alignment"] == 1


def test_ass_header_defaults_when_sections_absent():
    (res_x, res_y), styles = EA.ass_header("WEBVTT\n")
    assert (res_x, res_y) == EA._ASS_DEFAULT_RES
    assert styles == {}


def test_style_level_italic_and_bold_wrap_the_whole_cue():
    # Narrative is italic in [V4+ Styles]; the cue carries no inline tag.
    assert EA.ass_text_to_vtt("Hi there", {"italic": True})[0] == \
        "<i>Hi there</i>"
    assert EA.ass_text_to_vtt("Hi", {"bold": True})[0] == "<b>Hi</b>"
    # both flags open in canonical nesting order and close cleanly
    assert EA.ass_text_to_vtt("Hi", {"italic": True, "bold": True})[0] == \
        "<b><i>Hi</i></b>"


def test_inline_toggle_off_inside_an_italic_style():
    italic = {"italic": True}
    assert EA.ass_text_to_vtt(r"ital{\i0}plain", italic)[0] == \
        "<i>ital</i>plain"
    assert EA.ass_text_to_vtt(r"{\i0}plain{\i1}ital", italic)[0] == \
        "plain<i>ital</i>"
    # a toggle that governs no text never emits an empty tag pair
    assert EA.ass_text_to_vtt(r"{\i0}plain", italic)[0] == "plain"


def test_inline_bold_toggle_and_style_switch_reset():
    bold = {"bold": True}
    assert EA.ass_text_to_vtt(r"bold{\b0}plain", bold)[0] == \
        "<b>bold</b>plain"
    # \r resets to the row's own style, undoing an inline override
    assert EA.ass_text_to_vtt(r"a{\i0}b{\r}c", {"italic": True})[0] == \
        "<i>a</i>b<i>c</i>"
    # \rName switches to that style's flags
    styles = {"Plain": {"italic": False, "bold": False},
              "Shout": {"italic": False, "bold": True}}
    assert EA.ass_text_to_vtt(r"a{\rShout}b", {"italic": True}, styles)[0] == \
        "<i>a</i><b>b</b>"
    assert EA.ass_text_to_vtt(r"a{\rPlain}b", {"bold": True}, styles)[0] == \
        "<b>a</b>b"


def test_ass_to_vtt_converts_and_sorts_chronologically():
    vtt = EA.ass_to_vtt(ass(
        'Dialogue: 0,0:00:10.00,0:00:14.00,SongBottom,,0,0,0,,{\\fad(100,100)}Second\n'
        'Dialogue: 0,0:00:02.00,0:00:06.00,SongBottom,,0,0,0,,{\\fad(100,100)}First\n'
    ))
    got = cues(vtt)
    assert [c[0] for c in got] == ["00:00:02.000", "00:00:10.000"]
    assert got[0][2] == ["<i>First</i>"]
    assert got[1][2] == ["<i>Second</i>"]
    # bottom cues carry no line override and stay centred
    assert got[0][1] == "align:center"


def test_ass_to_vtt_applies_style_level_italics_and_bold():
    vtt = EA.ass_to_vtt(ass(
        'Dialogue: 0,0:00:01.00,0:00:04.00,Narrative,,0,0,0,,Narration body\n'
        'Dialogue: 0,0:00:05.00,0:00:08.00,Profile,,0,0,0,,{\\an7\\pos(640,130)}Profile body\n'
        'Dialogue: 0,0:00:09.00,0:00:12.00,Spoken,,0,0,0,,Unstyled size\n'
    ))
    bodies = body_lines(vtt)
    assert bodies[0] == "<i>Narration body</i>"
    assert bodies[1] == "<b>Profile body</b>"
    # unknown style -> no style-level tags
    assert bodies[2] == "Unstyled size"


def test_ass_to_vtt_top_positioning_uses_playres_y():
    vtt = EA.ass_to_vtt(ass(
        # SongTop style (alignment 8) with no \pos -> upper band
        'Dialogue: 0,0:00:01.00,0:00:04.00,SongTop,,0,0,0,,{\\fad(100,100)}Top song\n'
        # \an7 at y=130/720 = 18% -> upper band, off-centre x -> column
        'Dialogue: 0,0:00:05.00,0:00:08.00,Profile,,0,0,0,,{\\an7\\pos(122,130)}Profile\n'
        # \an8 at y=410/720 = 57% -> BOTTOM despite the top alignment
        'Dialogue: 0,0:00:09.00,0:00:12.00,Narrative,,0,0,0,,{\\an8\\pos(640,410)}Narr\n'
        # \an7 at y=562/720 = 78% -> bottom (credits roll low)
        'Dialogue: 0,0:00:13.00,0:00:16.00,Credit,,0,0,0,,{\\an7\\pos(90,562)}Credit\n'
        # plain SongBottom -> bottom
        'Dialogue: 0,0:00:17.00,0:00:20.00,SongBottom,,0,0,0,,{\\fad(100,100)}Bottom\n'
    ))
    got = {c[2][0]: c[1] for c in cues(vtt)}
    assert "line:8%" in got["<i>Top song</i>"]
    assert "line:8%" in got["<b>Profile</b>"]
    assert "line:" not in got["<i>Narr</i>"]
    assert "line:" not in got["<b>Credit</b>"]
    assert "line:" not in got["<i>Bottom</i>"]


def test_ass_to_vtt_centered_cues_keep_align_center():
    vtt = EA.ass_to_vtt(ass(
        'Dialogue: 0,0:00:01.00,0:00:04.00,Narrative,,0,0,0,,{\\an8\\pos(640,410)}Centred\n'
    ))
    assert cues(vtt)[0][1] == "align:center"


def test_ass_to_vtt_offcenter_pos_becomes_a_column():
    # 704x480 profile track: left column x=67, right column x=387
    head = ASS_HEAD.replace("PlayResX: 1280", "PlayResX: 704").replace(
        "PlayResY: 720", "PlayResY: 480")
    vtt = EA.ass_to_vtt(head + (
        'Dialogue: 1,0:00:27.50,0:00:38.50,Profile,,0,0,0,,{\\an7\\pos(67,134)}Left\n'
        'Dialogue: 1,0:00:41.50,0:00:54.00,Profile,,0,0,0,,{\\an7\\pos(387,134)}Right\n'
        'Dialogue: 1,0:01:11.50,0:01:20.50,Profile,,0,0,0,,{\\an7\\pos(340,240)}Centred\n'
    ) + "\n")
    got = {c[2][0]: c[1] for c in cues(vtt)}
    assert "position:10%" in got["<b>Left</b>"]
    assert "position:55%" in got["<b>Right</b>"]
    # a near-centre anchor stays centred (no position: setting)
    assert "position:" not in got["<b>Centred</b>"]
    assert "align:center" in got["<b>Centred</b>"]


def test_ass_to_vtt_skips_empty_and_drawing_rows():
    vtt = EA.ass_to_vtt(ass(
        'Dialogue: 0,0:00:01.00,0:00:04.00,SongBottom,,0,0,0,,{\\fad(100,100)}\n'
        'Dialogue: 0,0:00:05.00,0:00:08.00,SongBottom,,0,0,0,,{\\p1}m 0 0 l 9 9\n'
        'Dialogue: 0,0:00:09.00,0:00:12.00,SongBottom,,0,0,0,,{\\fad(100,100)}Kept\n'
    ))
    assert [c[2] for c in cues(vtt)] == [["<i>Kept</i>"]]


def test_ass_to_vtt_keeps_commas_in_text_and_multiline():
    vtt = EA.ass_to_vtt(ass(
        'Dialogue: 0,0:00:01.00,0:00:04.00,SongBottom,,0,0,0,,Well, yes, indeed\\Nand more\n'
    ))
    got = cues(vtt)
    assert got[0][2] == ["<i>Well, yes, indeed", "and more</i>"]


def test_ass_to_vtt_empty_document():
    assert EA.ass_to_vtt("").strip() == "WEBVTT"


def test_convert_subtitles_writes_vtt_and_manifest(tmp_path):
    ass_dir = tmp_path / "ass"
    ass_dir.mkdir()
    (ass_dir / "mv010.ass").write_text(ass(
        'Dialogue: 0,0:00:01.00,0:00:04.00,SongBottom,,0,0,0,,{\\fad(100,100)}Hi\n'
    ), encoding="utf-8")
    (ass_dir / "notes.txt").write_text("ignored", encoding="utf-8")
    out = tmp_path / "out"
    out.mkdir()
    manifest: dict = {"version": 1, "movies": {"mv010": "movie/mv010.mp4"}}
    missing: list = []
    n = EA.convert_subtitles(str(ass_dir), str(out), manifest, missing)
    assert n == 1 and missing == []
    assert manifest["subtitles"] == {"mv010": "subs/mv010.vtt"}
    text = (out / "subs" / "mv010.vtt").read_text(encoding="utf-8")
    assert text.startswith("WEBVTT") and "Hi" in text
    # movie mapping untouched
    assert manifest["movies"] == {"mv010": "movie/mv010.mp4"}


def test_convert_subtitles_prunes_stale_tracks(tmp_path):
    ass_dir = tmp_path / "ass"
    ass_dir.mkdir()
    (ass_dir / "mv010.ass").write_text(ass(
        'Dialogue: 0,0:00:01.00,0:00:04.00,SongBottom,,0,0,0,,Hi\n'
    ), encoding="utf-8")
    out = tmp_path / "out"
    (out / "subs").mkdir(parents=True)
    (out / "subs" / "mv099.vtt").write_text("WEBVTT\n", encoding="utf-8")
    (out / "subs" / "keep.txt").write_text("x", encoding="utf-8")
    manifest: dict = {"subtitles": {"mv099": "subs/mv099.vtt"}}
    missing: list = []
    EA.convert_subtitles(str(ass_dir), str(out), manifest, missing)
    assert manifest["subtitles"] == {"mv010": "subs/mv010.vtt"}
    assert not (out / "subs" / "mv099.vtt").exists()  # orphaned track gone
    assert (out / "subs" / "keep.txt").exists()  # non-vtt files untouched


def test_convert_subtitles_reports_missing_dir(tmp_path):
    missing: list = []
    manifest: dict = {"subtitles": {"mv010": "subs/mv010.vtt"}}
    assert EA.convert_subtitles(str(tmp_path / "nope"), str(tmp_path),
                                manifest, missing) == 0
    assert missing
    # a failed ass_dir must NOT prune: the old mapping still points at a
    # perfectly good file (the directory is just not mounted right now).
    assert manifest["subtitles"] == {"mv010": "subs/mv010.vtt"}


def test_subs_only_requires_existing_manifest(tmp_path, monkeypatch):
    out = tmp_path / "out"
    out.mkdir()
    ass_dir = tmp_path / "ass"
    ass_dir.mkdir()
    (ass_dir / "mv010.ass").write_text(ass(
        'Dialogue: 0,0:00:01.00,0:00:04.00,SongBottom,,0,0,0,,Hi\n'
    ), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", [
        "extract_assets.py", str(out), "--subs-only",
        "--ass-dir", str(ass_dir),
    ])
    import pytest
    with pytest.raises(SystemExit):
        EA.main()
    # nothing was written: an empty-images manifest must never appear
    assert not (out / "manifest.json").exists()
    assert not (out / "subs").exists()


def test_subs_only_updates_an_existing_manifest(tmp_path, monkeypatch):
    out = tmp_path / "out"
    out.mkdir()
    existing = {"version": 1, "images": {"b1.tga": "bg/b1.webp"},
                "bgm": {}, "sfx": {}, "voice": {}, "movies": {},
                "subtitles": {}}
    (out / "manifest.json").write_text(json.dumps(existing), encoding="utf-8")
    ass_dir = tmp_path / "ass"
    ass_dir.mkdir()
    (ass_dir / "mv010.ass").write_text(ass(
        'Dialogue: 0,0:00:01.00,0:00:04.00,SongBottom,,0,0,0,,Hi\n'
    ), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", [
        "extract_assets.py", str(out), "--subs-only",
        "--ass-dir", str(ass_dir),
    ])
    EA.main()
    after = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert after["subtitles"] == {"mv010": "subs/mv010.vtt"}
    assert after["images"] == {"b1.tga": "bg/b1.webp"}  # preserved, not reset
    assert (out / "subs" / "mv010.vtt").is_file()


def test_discover_ass_dir_walks_up_from_en_pak(tmp_path):
    release = tmp_path / "release" / "Main Game"
    (release / "Windows" / "game files").mkdir(parents=True)
    pak = release / "Windows" / "game files" / "en.pak"
    pak.write_bytes(b"x")
    found = EA.discover_ass_dir([str(pak)])
    assert found is None  # nothing on disk yet
    ass = release / "Movie Patcher" / "assets" / "ass"
    ass.mkdir(parents=True)
    assert EA.discover_ass_dir([str(pak)]) == str(ass)


def test_manifest_declares_subtitle_table():
    """A fresh extract must always carry the `subtitles` table."""
    src = open(EA.__file__, encoding="utf-8").read()
    assert '"movies": {}, "subtitles": {}' in src


def test_movie_ffmpeg_args_use_faststart():
    src = open(EA.__file__, encoding="utf-8").read()
    assert '"-movflags", "+faststart"' in src
