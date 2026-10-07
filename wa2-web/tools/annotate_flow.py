"""Join walkthrough research onto the engine choice skeleton -> data/flow.json.

Sources (see docs/FLOW_GRAPH.md): Scribd "White Album 2 Full Walkthrough"
(EN option wording), gameline.jp + seiya-saiga.com charts (routes/flags),
MAL/andlaou/playgame flag analyses. Every annotation carries status:
  EXPERT_SOURCED  consensus across >=2 walkthroughs, option text matches engine
  NEEDS_PLAYTEST  source conflict, date drift, or engine/walkthrough mismatch
Nothing here claims in-game verification yet (see docs/QA.md).

Usage: python3 annotate_flow.py SKELETON_JSON OUT_JSON
"""

from __future__ import annotations

import json
import sys

# (script, option-1 text, option-2 text|None) -> annotation. Option texts
# are matched by prefix (40 chars) against the skeleton, so event-index
# shifts from parser improvements never break the join. Effects use the
# flag model from docs/FLOW_GRAPH.md:
# CC: aff.setsuna/koharu/mari/chiaki (ints), flags chiaki/mari/koharu route,
#     chiaki_true (unlock). Coda: aff.s (etsuna)/k (azusa), uwaki, s_flag.
A: dict = {
    # ---------------- Closing Chapter ----------------
    ('2003', "I can't handle her.", 'I feel strangely at ease with her.'): {"walk": "cc-c01", "date": "12/1",
        "effects": {1: {"flag": "chiaki_true_path"},
                    2: {"aff": {"chiaki": 1}}},
        "gated": {1: "LOCKED until cc-chiaki-normal cleared once"},
        "note": "12/1 first decision. JP: 苦手だ / なんとなく心地良い.",
        "status": "EXPERT_SOURCED"},
    ('2003', 'Call her.', 'Send an email.'): {"walk": "cc-c02", "date": "12/2",
        "effects": {1: {"aff": {"setsuna": 1}}, 2: {}},
        "note": "Contacting Setsuna: call vs text.",
        "status": "EXPERT_SOURCED"},
    ('2005', 'Walk her to the station', 'Let her leave'): {"walk": "cc-c04", "date": "12/5",
        "effects": {1: {"aff": {"koharu": 1}}, 2: {}},
        "note": "Koharu after work: accompany vs send off.",
        "status": "EXPERT_SOURCED"},
    ('2007', 'Put her to bed', 'Shake her awake'): {"walk": "cc-c05", "date": "12/8",
        "effects": {1: {"aff": {"chiaki": 1}}, 2: {}},
        "note": ("Chiaki asleep in Haruki's room. Present in v2.1.0; "
                 "absent from v1.3.6 engine data."),
        "status": "EXPERT_SOURCED"},
    ('2009', 'Walk her to the station', 'See her off'): {"walk": "cc-c06", "date": "12/11~12 (drifts by edition)",
        "effects": {1: {"aff": {"koharu": 1}}, 2: {"aff": {"setsuna": 1}}},
        "note": "Walking-home decision (2nd).",
        "status": "EXPERT_SOURCED"},
    ('2011', "It isn't that simple.", "It's over."): {"walk": "cc-c07", "date": "12/14",
        "effects": {1: {"aff": {"setsuna": 1}}, 2: {"aff": {"mari": 1}}},
        "note": "Answering Mari about the past. Opt2 is Mari-critical.",
        "status": "EXPERT_SOURCED"},
    ('2015', 'Do whatever you want.', "Of course I won't."): {"walk": "cc-c10", "date": "12/18~19? (drifts)",
        "effects": {1: {"aff": {"setsuna": 1, "koharu": 1}}, 2: {}},
        "note": "Koharu/shop-staff scene. Date mapping approximate.",
        "status": "EXPERT_SOURCED"},
    ('2016', 'Just come here.', "I'll come to you now."): {"walk": "cc-c11", "date": "12/20",
        "effects": {1: {"aff": {"setsuna": 1}, "clear": "chiaki"},
                    2: {"aff": {"chiaki": 1}}},
        "gated": {2: "unselectable if chiaki flag OFF"},
        "status": "EXPERT_SOURCED"},
    ('2017', "Then I'll take one more", "No~ I don't need any more"): {"walk": "cc-c12", "date": "12/21",
        "effects": {1: {"aff": {"setsuna": 1}},
                    2: {"aff_if_mari": {"mari": 1}}},
        "note": "Kazusa manuscript for Setsuna. Opt2 Mari-critical (4th).",
        "status": "EXPERT_SOURCED"},
    ('2018', 'Oh~ who cares?', 'Could she have…?'): {"walk": "cc-c13", "date": "12/22",
        "effects": {1: {}, 2: {"aff": {"koharu": 1}}},
        "gated": {2: "unselectable if koharu flag already OFF"},
        "status": "EXPERT_SOURCED"},
    ('2019', 'Call Chiaki', 'Stop by the editorial office'): {"walk": "cc-c14", "date": "12/24 ROUTER",
        "effects": {},
        "gated": {1: "needs chiaki aff>=3/flag ON",
                  2: "needs mari aff>=3/flag ON"},
        "note": ("THE branch. Engine gotos: opt2->2401 (Mari line), "
                 "opt3->2501 (common line), opt1 falls through toward the "
                 "work/stay follow-up (Chiaki line via 2301 on opt2 there; "
                 "Setsuna line via 2020 on opt1)."),
        "status": "EXPERT_SOURCED"},
    ('2019', 'Go to work', 'Stay alone'): {"walk": "cc-c15?", "date": "12/24 cont.?",
        "effects": {},
        "play": {2: "2301"},
        "note": ("'Go to work / Stay alone' sits in 2019 AFTER the router, "
                 "so it executes on the opt1 fall-through path. The ONLY "
                 "choice in the game directly followed by a CATCH jump: "
                 "CATCH2 2301 resolves opt2 'Stay alone' -> 2301 (Chiaki "
                 "line; 2301 and 2020 open with parallel Dec-25-morning "
                 "scenes). Opt1 falls through toward 2020 (Setsuna line). "
                 "Confirm the flag/affection framing in game."),
        "status": "NEEDS_PLAYTEST"},
    ('2024', 'Go to the concert', 'Go on the midnight shrine visit'): {"walk": "cc-c16", "date": "12/31",
        "effects": {},
        "note": ("Setsuna-line New Year's Eve (inside 2020->2033): concert "
                 "is the unselectable dummy, shrine visit confirms Setsuna. "
                 "The Mari-line 12/31 is the separate 2503-126 choice. No "
                 "further choices after."),
        "status": "EXPERT_SOURCED"},
    # ---------------- Coda ----------------
    ('3005', 'Never see Kazusa again', 'I met Kazusa'): {"walk": "coda-c02", "date": "12/28~31? (drifts)",
        "effects": {1: {"flag": "ne_path"}, 2: {"aff": {"s": 1}}},
        "note": ("'Never see Kazusa again / I met Kazusa'. Opt1 SKIPS the "
                 "next two choices. Preceded by the 12/24 prologue router "
                 "in 3003 (coda-c01)."),
        "status": "EXPERT_SOURCED"},
    ('3005', 'That was all', 'I had reunited with Kazusa on Christmas Eve.'): {"walk": "coda-c03", "date": "12/31 cont.",
        "effects": {1: {}, 2: {"aff": {"s": 1}}},
        "status": "EXPERT_SOURCED"},
    ('3005', 'Not worth mentioning', 'Something I wanted no one to know'): {"walk": "coda-c04", "date": "12/31 cont.",
        "effects": {1: {"uwaki": 1}, 2: {"aff": {"k": 1}}},
        "status": "EXPERT_SOURCED"},
    ('3009', "I want to hear Setsuna's voice.", "I promised I wouldn't contact her first."): {"walk": "coda-c05", "date": "1/13",
        "effects": {1: {"aff": {"s": 1}, "uwaki": 1}, 2: {}},
        "note": "Opt1 SKIPS the next choice.",
        "status": "EXPERT_SOURCED"},
    ('3009', "I'm doing it for Kazusa.", "There's nothing to worry about."): {"walk": "coda-c06", "date": "1/13 cont.",
        "effects": {1: {"aff": {"k": 1}}, 2: {"aff": {"s": 1}}},
        "status": "EXPERT_SOURCED"},
    ('3012', "I won't go", "I can't go"): {"walk": "coda-c07", "date": "1/18",
        "effects": {1: {"aff": {"s": 1}}, 2: {"uwaki": 1}},
        "status": "EXPERT_SOURCED"},
    ('3012', 'Hold her.', 'Let her lean against my chest.'): {"walk": "coda-c08", "date": "1/19",
        "effects": {1: {"aff": {"k": 1}, "uwaki": 1}, 2: {"aff": {"s": 1}}},
        "status": "EXPERT_SOURCED"},
    ('3013', 'Go home', 'Keep watching her sleep'): {"walk": "coda-c09", "date": "1/21",
        "effects": {1: {"aff": {"s": 1}}, 2: {}},
        "note": "Opt1 SKIPS the next choice.",
        "status": "EXPERT_SOURCED"},
    ('3013', 'Keep this forever', 'Want to hold her'): {"walk": "coda-c10", "date": "1/21 cont.",
        "effects": {1: {"aff": {"k": 1}}, 2: {"uwaki": 1}},
        "note": ("Sources disagree on mapping (Scribd vs gameline); "
                 "held as gameline. Verify in game."),
        "status": "NEEDS_PLAYTEST"},
    ('3013', 'Look away', 'Meet her eyes'): {"walk": "coda-c11", "date": "1/25",
        "effects": {1: {"aff": {"s": 1}}, 2: {"aff": {"k": 1}}},
        "note": "Present in v2.1.0; absent from v1.3.6 engine data.",
        "status": "EXPERT_SOURCED"},
    ('3014', 'I just wanted to see you', 'Tell her the truth about Kazusa'): {"walk": "coda-c12", "date": "1/27 DECIDER",
        "effects": {1: {"aff": {"k": 1}}, 2: {"flag": "s_honest"}},
        "note": "Opt2 required for Setsuna True.",
        "status": "EXPERT_SOURCED"},
    ('3016', 'Let go of her hands', 'Turn my face away'): {"walk": "coda-c13", "date": "1/29 FINAL ROUTER",
        "effects": {},
        "gated": {1: "selectable only if s_flag OFF"},
        "note": ("Engine goto: opt2->3901 (Kazusa side files). "
                 "Opt1 skips the final choice -> cheating end."),
        "status": "EXPERT_SOURCED"},
    ('3016', 'I love Setsuna', "I can't lie to Kazusa"): {"walk": "coda-c14", "date": "1/29 FINAL",
        "effects": {},
        "note": ("'I love Setsuna' with s_flag ON -> Setsuna True; with "
                 "s_flag OFF -> Normal. 'I can't lie to Kazusa' needs "
                 "kazusa aff=6 -> Kazusa True."),
        "status": "EXPERT_SOURCED"},
    ("3904","Remove her glasses.","Kiss her with her glasses on."): {"walk": "coda-c15", "date": "2/14 (cheating only)",
        "effects": {},
        "note": ("CG-only choice; both options converge. Save + take both. "
                 "JP spine 3904 (old EN toolchain split 3904_2)."),
        "status": "EXPERT_SOURCED"},
    # ---- recovered from mega-tokens by the resplit parser (2004/2013/
    # 2014/2503/3003); these close the walkthrough-vs-engine gaps ----
    ("2004", "Decline.", "Accept."): {"walk": "cc-c03", "date": "12/3",
        "effects": {1: {}, 2: {"aff": {"mari": 1}}},
        "note": ("Freelance assignment. Recovered from a mega-token; "
                 "both picks converge (he declines, then takes it back). "
                 "Opt2 is Mari-critical (1 of 4)."),
        "status": "EXPERT_SOURCED"},
    ("2013", "All right. Let's do it today", "Sorry~ but make it tomorrow"): {"walk": "cc-c08", "date": "12/17 (1st)",
        "effects": {1: {"flag_off": "mari"}, 2: {}},
        "note": ("Mari's invitation timing. Recovered from a mega-token. "
                 "Opt1 kills the Mari route; opt2 keeps it (needs mari "
                 "aff>=2)."),
        "status": "EXPERT_SOURCED"},
    ("2014", "Talk a little longer", "Let's call it a night"): {"walk": "cc-c09", "date": "12/17 (2nd)",
        "effects": {1: {"aff": {"chiaki": 1}}, 2: {"aff": {"setsuna": 1}, "clear": "chiaki"}},
        "note": ("Evening talk. Recovered from a mega-token. Opt2 kills "
                 "the Chiaki route."),
        "status": "EXPERT_SOURCED"},
    ("2503", "Go to the concert", "Stay here"): {"walk": "cc-c16m", "date": "12/31 (Mari line)",
        "effects": {},
        "note": ("Mari-line New Year's Eve. Recovered from a mega-token; "
                 "concert is the unselectable dummy, stay confirms Mari."),
        "status": "EXPERT_SOURCED"},
    ("3003", "I mean to propose soon.", "We have been together for two years."): {"walk": "coda-c01", "date": "12/24 prologue",
        "effects": {1: {"aff": {"s": 1}}, 2: {}},
        "note": ("Coda's opening router (SAVE here). Recovered from a "
                 "mega-token. Opt1 -> Setsuna-True/Normal side; opt2 -> "
                 "Kazusa-True/Cheating side."),
        "status": "EXPERT_SOURCED"},
}


def key_of(node: dict) -> tuple:
    opts = node["options"]
    o1 = opts[0]["text"][:40] if len(opts) > 0 else ""
    o2 = opts[1]["text"][:40] if len(opts) > 1 else None
    return (node["engine"]["script"], o1, o2)


def main() -> None:
    skel_path, out_path = sys.argv[1], sys.argv[2]
    with open(skel_path, encoding="utf-8") as f:
        skel = json.load(f)
    # index annotations by (script, opt1-prefix, opt2-prefix)
    table = {}
    for k, a in A.items():
        s, o1, o2 = k
        table[(s, o1[:40], (o2[:40] if o2 else None))] = a
    nodes = []
    for n in skel["nodes"]:
        a = table.get(key_of(n))
        if a is None:
            nodes.append(n)
            continue
        n = dict(n)
        play = a.get("play", {})
        if play:
            n["options"] = [dict(o, play=play.get(o["n"]))
                            if o["n"] in play else o
                            for o in n["options"]]
        n.update({k: v for k, v in a.items() if k != "play"})
        nodes.append(n)
    review = sum(1 for n in nodes if n["status"] == "NEEDS_REVIEW")
    playtest = sum(1 for n in nodes if n["status"] == "NEEDS_PLAYTEST")
    expert = sum(1 for n in nodes if n["status"] == "EXPERT_SOURCED")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "counts": {"expert": expert,
                                           "playtest": playtest,
                                           "review": review},
                   "nodes": nodes}, f, ensure_ascii=False, indent=1)
    print(f"{len(nodes)} nodes (expert={expert} playtest={playtest} "
          f"unannotated={review}) -> {out_path}")


if __name__ == "__main__":
    main()
