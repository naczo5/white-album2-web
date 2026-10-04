import { describe, expect, it } from "vitest";
import { plainText, renderText, spanize } from "./text";

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
