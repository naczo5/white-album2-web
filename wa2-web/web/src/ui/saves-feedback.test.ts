// Import feedback wording: a wrong-size file, a truncated `Sys.sav` and a
// build without a slot table are three different mistakes, and a storage
// quota error must never read as "imported". The strings are the only thing
// the player sees, so they are pinned here.

import { describe, expect, it } from "vitest";
import { sysSkipNote, sysStorageNote } from "./saves";
import { NATIVE_SYS_SIZE } from "../engine/native-save";

const NONE = { wrongSize: [], truncated: [], unreadable: 0, unsupported: 0 };

describe("sysSkipNote", () => {
  it("says nothing when nothing was skipped", () => {
    expect(sysSkipNote(NONE)).toBe("");
  });

  it("distinguishes a wrong-size file from a truncated copy", () => {
    const wrong = sysSkipNote({ ...NONE, wrongSize: [3_000_000] });
    const short = sysSkipNote({ ...NONE, truncated: [0x1000] });
    expect(wrong).toContain("wrong size");
    expect(wrong).not.toContain("truncated");
    expect(short).toContain("truncated");
    expect(short).not.toContain("wrong size");
    expect(wrong).not.toBe(short);
  });

  it("names the exact expected size in both cases", () => {
    const bytes = NATIVE_SYS_SIZE.toLocaleString("en-US");
    expect(sysSkipNote({ ...NONE, wrongSize: [1] })).toContain(bytes);
    expect(sysSkipNote({ ...NONE, truncated: [1] })).toContain(bytes);
  });

  it("keeps the undecodable and unsupported cases apart", () => {
    expect(sysSkipNote({ ...NONE, unsupported: 1 }))
      .toBe("1 Sys.sav skipped (no slot table in this build)");
    expect(sysSkipNote({ ...NONE, unreadable: 2 }))
      .toBe("2 Sys.sav file(s) could not be decoded");
  });

  it("joins several reasons without repeating one", () => {
    const note = sysSkipNote({ wrongSize: [1], truncated: [2], unreadable: 1, unsupported: 1 });
    expect(note).toContain("wrong size");
    expect(note).toContain("truncated");
    expect(note).toContain("could not be decoded");
    expect(note).toContain("no slot table");
    // Each reason appears exactly once.
    expect(note.match(/wrong size/g)).toHaveLength(1);
    expect(note.match(/truncated/g)).toHaveLength(1);
    expect(note.match(/no slot table/g)).toHaveLength(1);
  });
});

describe("sysStorageNote", () => {
  it("is silent when both writes succeeded", () => {
    expect(sysStorageNote(true, true)).toBe("");
  });

  it("blames browser storage, naming what was lost", () => {
    expect(sysStorageNote(false, true)).toContain("the profile could not be stored");
    expect(sysStorageNote(false, true)).not.toContain("imported read lines");
    expect(sysStorageNote(true, false)).toContain("the imported read lines could not be stored");
    expect(sysStorageNote(true, false)).not.toContain("the profile");
    const both = sysStorageNote(false, false);
    expect(both).toContain("full");
    expect(both).toContain("the profile and the imported read lines");
  });

  it("says the import only holds for this session, and how to fix it", () => {
    const note = sysStorageNote(false, false);
    expect(note).toContain("this session only");
    expect(note).toContain("re-import Sys.sav");
  });
});
