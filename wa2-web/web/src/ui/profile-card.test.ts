// Global profile card: story gates from `Sys.sav` must be visible, not just
// decoded. Region C carries the engine's own unlock switches (New Game+,
// Coda, Chiaki's true route); a profile that decodes them into `gates` but
// never shows them leaves the player guessing why a route is (not) open.

import { describe, expect, it } from "vitest";
import { profileCard, profileGateLabels } from "./saves";
import type { SysProfile } from "../engine/types";

function profile(gates: Record<string, number>): SysProfile {
  return {
    version: 1,
    fileName: "Sys.sav",
    importedAt: "2026-11-13T18:31:00.000Z",
    readKeys: ["1002:0", "1002:1"],
    visited: ["1002"],
    endings: ["cc-setsuna"],
    seenPicks: {},
    cg: [100100],
    music: [1],
    movies: [0],
    ero: [],
    gates,
  };
}

describe("profileGateLabels", () => {
  it("names every cleared story gate", () => {
    expect(profileGateLabels({ replay: 1, codaEntered: 1, chiakiNormal: 1, setsunaCc: 1 }))
      .toEqual(["New Game+", "Coda unlocked", "Chiaki True route unlocked"]);
  });

  it("treats cc-setsuna as the Coda unlock it implies", () => {
    // `setsunaCc` is the CC Setsuna clear, the flag the engine gates Coda on:
    // reporting "no Coda" for that save would be a lie.
    expect(profileGateLabels({ setsunaCc: 1 })).toEqual(["Coda unlocked"]);
    expect(profileGateLabels({ codaEntered: 1 })).toEqual(["Coda unlocked"]);
    // Both set: one line, not a duplicate.
    expect(profileGateLabels({ codaEntered: 1, setsunaCc: 1 })).toEqual(["Coda unlocked"]);
  });

  it("is silent when no gate is set or the profile has none", () => {
    expect(profileGateLabels({})).toEqual([]);
    expect(profileGateLabels({ replay: 0, codaEntered: 0, chiakiNormal: 0, setsunaCc: 0 })).toEqual([]);
    expect(profileGateLabels(null)).toEqual([]);
    expect(profileGateLabels(undefined)).toEqual([]);
  });
});

describe("profile card", () => {
  it("renders the gate line for an imported profile", () => {
    const html = profileCard(profile({ replay: 1, codaEntered: 1, chiakiNormal: 0 }));
    expect(html).toContain("Global profile");
    expect(html).toContain("profile-gates");
    expect(html).toContain("New Game+");
    expect(html).toContain("Coda unlocked");
    expect(html).not.toContain("Chiaki True route unlocked");
    // The stat strip still carries the imported counters.
    expect(html).toContain("2 read lines");
    expect(html).toContain("1 ending");
    expect(html).toContain("all movies");
  });

  it("omits the gate row instead of printing zeros", () => {
    const html = profileCard(profile({ replay: 0, codaEntered: 0 }));
    expect(html).not.toContain("profile-gates");
    expect(html).not.toContain("New Game+");
    expect(html).not.toContain("Coda unlocked");
  });
});
