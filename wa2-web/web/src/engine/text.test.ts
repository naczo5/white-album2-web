import { describe, expect, it } from "vitest";
import { displayDate, plainText, renderText, spanize } from "./text";

describe("text projection", () => {
  it("breaks literal \\n", () => {
    expect(renderText("a\\nb")).toBe("<span>a<br>b</span>");
  });

  it("marks angle F16 whispers", () => {
    const html = renderText('How should I know?\\n<F16…I only asked>');
    expect(html).toContain('class="whisper"');
    expect(html).not.toContain("&lt;F16");
  });

  it("marks bracket F16 whispers case-insensitively", () => {
    expect(renderText("[f16softly]").replace(/.*whisper.*/, "W")).toContain("W");
  });

  it("strips non-F16 wrappers, keeps text", () => {
    const html = renderText('<F14"Then why">');
    expect(html).toContain("Then why");
    expect(html).not.toContain("F14");
    expect(html).not.toContain("whisper");
  });

  it("keeps content of mid-string wrappers", () => {
    expect(plainText("a<F14b>c")).toBe("abc");
    expect(renderText("a<F14b>c")).toContain("abc");
    expect(renderText("a<F14b>c")).not.toContain("F14");
  });

  it("strips timing tags everywhere", () => {
    expect(plainText("a<W10>b[W3]c")).toBe("abc");
    expect(renderText("a<W10>b")).not.toContain("W10");
  });

  it("breaks \\k pages", () => {
    expect(renderText("a\\kb")).toContain("<br><br>");
    expect(plainText("a\\kb")).toBe("a\n\nb");
  });

  it("renders both ruby forms", () => {
    expect(renderText("[R空港^ここ]")).toContain("<ruby>空港<rt>ここ</rt></ruby>");
    expect(renderText("[R年下の男|おまえ]")).toContain("<ruby>年下の男<rt>おまえ</rt></ruby>");
  });

  it("escapes HTML in dialogue", () => {
    expect(renderText("<F16a&b>")).toContain("a&amp;b");
  });

  it("plainText strips markup for backlog", () => {
    expect(plainText('A\\n<F16B> [R空港^ここ]')).toBe("A\nB 空港");
  });

  it("spanize keeps whisper spans addressable", () => {
    const spans = spanize('x<F16y>z');
    expect(spans.map((s) => [s.text, !!s.whisper])).toEqual([
      ["x", false],
      ["y", true],
      ["z", false],
    ]);
  });
});

describe("date label projection (annotator placeholders are dev-only)", () => {
  it("hides ROUTER / FINAL ROUTER placeholders from players", () => {
    // A trailing annotator token is mechanics, not story: "12/24 ROUTER"
    // must read as the real date, not leak the flow keyword.
    expect(displayDate("12/24 ROUTER", false)).toBe("12/24");
    expect(displayDate("12/24 FINAL ROUTER", false)).toBe("12/24");
    expect(displayDate("12/24 router", false)).toBe("12/24");
    expect(displayDate("ROUTER", false)).toBeNull();
    expect(displayDate("Final Router", false)).toBeNull();
    expect(displayDate("router", false)).toBeNull();
  });

  it("strips every real flow.json annotation down to the date token", () => {
    // The exact `date` strings shipped in data/flow.json. The player must
    // read a clean calendar token: no parenthetical note, no "?", no
    // annotator keyword.
    const CASES: [string, string][] = [
      ["1/13", "1/13"],
      ["1/13 cont.", "1/13"],
      ["1/18", "1/18"],
      ["1/19", "1/19"],
      ["1/21", "1/21"],
      ["1/21 cont.", "1/21"],
      ["1/25", "1/25"],
      ["1/27 DECIDER", "1/27"],
      ["1/29 FINAL", "1/29"],
      ["1/29 FINAL ROUTER", "1/29"],
      ["2/14 (cheating only)", "2/14"],
      ["12/1", "12/1"],
      ["12/2", "12/2"],
      ["12/3", "12/3"],
      ["12/5", "12/5"],
      ["12/8", "12/8"],
      ["12/11~12 (drifts by edition)", "12/11~12"],
      ["12/14", "12/14"],
      ["12/17 (1st)", "12/17"],
      ["12/17 (2nd)", "12/17"],
      ["12/18~19? (drifts)", "12/18~19"],
      ["12/20", "12/20"],
      ["12/21", "12/21"],
      ["12/22", "12/22"],
      ["12/24 cont.?", "12/24"],
      ["12/24 prologue", "12/24"],
      ["12/24 ROUTER", "12/24"],
      ["12/28~31? (drifts)", "12/28~31"],
      ["12/31", "12/31"],
      ["12/31 cont.", "12/31"],
      ["12/31 (Mari line)", "12/31"],
    ];
    for (const [raw, clean] of CASES) {
      expect(displayDate(raw, false), raw).toBe(clean);
    }
  });

  it("never leaks a parenthetical note or a keyword in player mode", () => {
    // Belt and braces over the same corpus: whatever the label was, the
    // player-facing projection carries only digits, "/" and "~".
    const RAW = [
      "1/27 DECIDER", "1/29 FINAL", "1/29 FINAL ROUTER", "12/24 ROUTER",
      "12/24 cont.?", "12/24 prologue", "12/17 (1st)",
      "12/18~19? (drifts)", "12/31 (Mari line)",
      "2/14 (cheating only)", "12/11~12 (drifts by edition)",
    ];
    for (const raw of RAW) {
      expect(displayDate(raw, false), raw).toMatch(/^\d{1,2}\/\d{1,2}(?:~\d{1,2})?$/);
    }
  });

  it("returns null for standalone mechanical tokens", () => {
    for (const t of ["ROUTER", "FINAL ROUTER", "DECIDER", "cont.", "prologue"]) {
      expect(displayDate(t, false), t).toBeNull();
    }
  });

  it("shows every label in dev mode", () => {
    expect(displayDate("ROUTER", true)).toBe("ROUTER");
    expect(displayDate("FINAL ROUTER", true)).toBe("FINAL ROUTER");
    expect(displayDate("12/24 ROUTER", true)).toBe("12/24 ROUTER");
    expect(displayDate("12/18~19? (drifts)", true)).toBe("12/18~19? (drifts)");
    expect(displayDate("2/14 (cheating only)", true)).toBe("2/14 (cheating only)");
    expect(displayDate("1/29 FINAL ROUTER", true)).toBe("1/29 FINAL ROUTER");
  });

  it("hides bare script ids offered as a date", () => {
    expect(displayDate("2012_020", false)).toBeNull();
    expect(displayDate("2012", false)).toBeNull();
    expect(displayDate("2012_020", true)).toBe("2012_020");
  });

  it("passes real dates through and handles null", () => {
    expect(displayDate("12/24", false)).toBe("12/24");
    expect(displayDate("February 14", false)).toBe("February 14");
    expect(displayDate(null, false)).toBeNull();
    expect(displayDate(undefined, true)).toBeNull();
  });
});
