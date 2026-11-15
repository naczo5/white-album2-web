import { describe, expect, it } from "vitest";
import { seCaptionCues, textAt, voiceCaptionCues } from "./captions";

// Placeholder cue text only: no game/subtitle content lives in the repo.
const CUES = [
  { begin: 0, end: 1000, text: "first line" },
  { begin: 1000, end: 2000, text: "second line" },
];

describe("caption cue lookup", () => {
  it("uses half-open begin <= t < end boundaries", () => {
    expect(textAt(CUES, -1)).toBe("");
    expect(textAt(CUES, 0)).toBe("first line");
    expect(textAt(CUES, 999)).toBe("first line");
    expect(textAt(CUES, 999.9)).toBe("first line");
    // The boundary belongs to the next cue, never both.
    expect(textAt(CUES, 1000)).toBe("second line");
    expect(textAt(CUES, 1999)).toBe("second line");
    expect(textAt(CUES, 2000)).toBe("");
  });

  it("joins overlapping active cues with a newline", () => {
    const overlapping = [
      { begin: 0, end: 100, text: "alpha" },
      { begin: 50, end: 150, text: "beta" },
      { begin: 80, end: 200, text: "gamma" },
    ];
    expect(textAt(overlapping, 0)).toBe("alpha");
    expect(textAt(overlapping, 50)).toBe("alpha\nbeta");
    expect(textAt(overlapping, 80)).toBe("alpha\nbeta\ngamma");
    expect(textAt(overlapping, 100)).toBe("beta\ngamma");
    expect(textAt(overlapping, 150)).toBe("gamma");
    expect(textAt(overlapping, 200)).toBe("");
  });

  it("returns an empty string for empty/missing/malformed input", () => {
    expect(textAt([], 0)).toBe("");
    expect(textAt(null, 0)).toBe("");
    expect(textAt(undefined, 0)).toBe("");
    expect(textAt(CUES, Number.NaN)).toBe("");
    expect(textAt([{ begin: Number.NaN, end: 10, text: "bad" }], 1)).toBe("");
    expect(textAt([{ begin: 0, end: 10, text: "" }], 1)).toBe("");
  });

  it("selects voice cues by manifest key and SE cues by numeric id", () => {
    const data = {
      version: 1,
      voice: { "1008_0199": [{ begin: 0, end: 500, text: "voice" }] },
      se: { "31": [{ begin: 100, end: 300, text: "se" }] },
    };
    expect(voiceCaptionCues(data, "1008_0199")?.[0]?.text).toBe("voice");
    expect(voiceCaptionCues(data, "missing")).toBeNull();
    expect(voiceCaptionCues(data, null)).toBeNull();
    expect(seCaptionCues(data, 31)?.[0]?.text).toBe("se");
    expect(seCaptionCues(data, 32)).toBeNull();
    expect(voiceCaptionCues(null, "1008_0199")).toBeNull();
  });
});
