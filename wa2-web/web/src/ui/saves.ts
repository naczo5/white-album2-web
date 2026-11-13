// Save/Load screen: localStorage slots + progress-as-a-file export/import.

import {
  clearProfile,
  deserialize,
  download,
  readAutosave,
  readProfile,
  readQuicksave,
  readSlotChecked,
  saveFilename,
  serialize,
  storageKey,
  writeAutosave,
  writeProfile,
  writeQuicksave,
  writeSlot,
} from "../engine/save";
import { chapterOfScript, type Router } from "../engine/router";
import { findNativeCandidates, nativeToSave, parseNativeFile, type NativePosition, type NativeSave, NATIVE_SYS_SIZE } from "../engine/native-save";
import {
  SYS_SIZE,
  buildSysProfile,
  countGalleryRows,
  mergeSysProfile,
  parseSysSave,
} from "../engine/sys-save";
import { ingestReadKeys } from "./reader";
import type { FlowData, SaveData, SysProfile, SysSlotsTable } from "../engine/types";

export interface SaveHooks {
  /** Used to resolve native save script ids and line text. */
  router: Router;
  save: SaveData;
  onLoad(s: SaveData): void;
  onBack(): void;
  notify(msg: string): void;
  /** `Sys.sav` slot map (absent = system saves are recognized but skipped). */
  sysSlots?: SysSlotsTable;
  /** Flow nodes: needed to map choice bitmasks onto node ids. */
  flow?: FlowData;
  /** Global profile currently stored (read lines, endings, unlocks). */
  profile?: SysProfile | null;
  /** Called after an import/removal so callers can repaint and re-sync. */
  onProfileChange?(p: SysProfile | null): void;
}

export type SysImportResult =
  | {
    ok: false;
    reason: "truncated" | "unreadable";
    size: number;
    /** How many slots the table says a full `Sys.sav` occupies. */
    expected: number;
  }
  | {
    ok: true;
    profile: SysProfile;
    readKeys: string[];
    /** The run save after the monotonic visited/endings union. */
    save: SaveData;
    /** Read lines this import added to the browser read set. */
    addedReadKeys: number;
    /** The global profile reached `localStorage` (false = quota/denied). */
    profileSaved: boolean;
    /** The imported read lines reached `localStorage`. */
    readKeysPersisted: boolean;
    gainedVisited: number;
    gainedEndings: number;
    /** The run gained visited/endings entries (autosave refreshed). */
    gained: boolean;
  };

/** In-place union of global progress into the active run. Only the two
 * global arrays grow: position, backlog, flags and picks keep describing
 * *where the player is*, which a `Sys.sav` says nothing about. */
export function applyProfileToRun(save: SaveData, profile: SysProfile | null): boolean {
  if (!profile) return false;
  let gained = false;
  for (const s of profile.visited) {
    if (save.visited.includes(s)) continue;
    save.visited.push(s);
    gained = true;
  }
  for (const e of profile.endings) {
    if (save.endings.includes(e)) continue;
    save.endings.push(e);
    gained = true;
  }
  return gained;
}

/** Parse + merge one `Sys.sav` buffer and persist the global profile.
 *
 * `Sys.sav` carries no reading position at all: this only ever adds read
 * lines, visited scripts, high-confidence endings, seen choices and the
 * gallery/music/movie bands to the stored profile and to the read set. */
export function importSysSave(
  buffer: ArrayBuffer,
  fileName: string,
  table: SysSlotsTable,
  router: Router,
  flow: FlowData,
  save: SaveData,
  storage: Storage = localStorage,
): SysImportResult {
  if (buffer.byteLength < SYS_SIZE) {
    // A short file is a truncated copy, not a different save: say so with
    // the two sizes so the caller's message can be exact.
    return { ok: false, reason: "truncated", size: buffer.byteLength, expected: SYS_SIZE };
  }
  const sys = parseSysSave(buffer, table);
  if (!sys) {
    return { ok: false, reason: "unreadable", size: buffer.byteLength, expected: SYS_SIZE };
  }
  const built = buildSysProfile(sys, table, router, flow, fileName);
  const existing = readProfile(storage);
  const profile = mergeSysProfile(existing, built.profile);
  // Both writes can fail independently (quota): report each one instead of
  // claiming a durable import that a reload will not see.
  const profileSaved = writeProfile(storage, profile);
  // Seed from the *merged* profile: if the browser read set was cleared but
  // the profile survived, re-importing Sys.sav restores those lines too.
  const readRes = ingestReadKeys(profile.readKeys);
  const addedReadKeys = readRes.added;
  const beforeVisited = save.visited.length;
  const beforeEndings = save.endings.length;
  // The live run object keeps its identity; only the two global arrays grow.
  applyProfileToRun(save, profile);
  const gainedVisited = save.visited.length - beforeVisited;
  const gainedEndings = save.endings.length - beforeEndings;
  const gained = gainedVisited > 0 || gainedEndings > 0;
  // The active run gained global entries; refresh the autosave copy so a
  // reload keeps the wider visited/endings sets. Position and backlog are
  // untouched by construction (applyProfileToRun only pushes into arrays).
  if (gained) writeAutosave(storage, save);
  return {
    ok: true,
    profile,
    readKeys: built.readKeys,
    save,
    addedReadKeys,
    profileSaved,
    readKeysPersisted: readRes.persisted,
    gainedVisited,
    gainedEndings,
    gained,
  };
}

const NATIVE_IMPORTS_KEY = "native.imports";

function readNativeImports(): SaveData[] {
  try {
    const raw = localStorage.getItem(storageKey(NATIVE_IMPORTS_KEY));
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .map((x) => {
        try {
          return deserialize(JSON.stringify(x));
        } catch {
          return null;
        }
      })
      .filter((x): x is SaveData => x !== null);
  } catch {
    return [];
  }
}

function writeNativeImports(list: SaveData[]): boolean {
  try {
    localStorage.setItem(storageKey(NATIVE_IMPORTS_KEY), JSON.stringify(list.slice(0, 100)));
    return true;
  } catch {
    /* quota: imports are a convenience; the native files remain on disk */
    return false;
  }
}

/** Prefer a route/variant script when the native save names one; fall back
 * to the base script. Returns every ambiguous line candidate so the user
 * can choose instead of silently landing in the wrong scene. */
export function nativeCandidates(router: Router, native: NativeSave) {
  const base = native.script;
  const route = native.route.replace(/^0+/, "");
  const variants: string[] = [];
  if (route) {
    for (const id of router.scripts.keys()) {
      if (id !== base && id.startsWith(`${base}_`) &&
        (id.startsWith(`${base}_${native.route}`) || id.startsWith(`${base}_${route}`))) {
        variants.push(id);
      }
    }
  }
  // A route variant wins only on an exact line match; a fuzzy/choice match
  // in a variant is not enough to move the user into another file. Collect
  // exact candidates from every matching variant instead of silently
  // choosing the first one.
  const exact: NativePosition[] = [];
  const seen = new Set<string>();
  for (const id of variants) {
    const scenario = router.scripts.get(id);
    if (!scenario) continue;
    for (const p of findNativeCandidates(native, scenario)) {
      if (p.confidence !== "exact") continue;
      const key = `${p.script}:${p.event}`;
      if (seen.has(key)) continue;
      seen.add(key);
      exact.push(p);
    }
  }
  if (exact.length > 0) return exact;
  const scenario = router.scripts.get(base);
  return scenario ? findNativeCandidates(native, scenario) : [];
}

const CHAPTER_LABEL: Record<string, string> = {
  intro: "Introductory chapter",
  closing: "Closing chapter",
  coda: "Coda",
  special: "Special",
};

/** Human-readable story gates from a `Sys.sav` profile.
 *
 * Region C's gate slots are the engine's own unlock switches (see
 * `gateSlots` in `data/sys-slots.json`): a nonzero value means the gate was
 * passed at some point in that save.
 *  - `replay`      = a second playthrough was started -> New Game+ exists.
 *  - `codaEntered` = the third part was entered -> Coda is open.
 *  - `setsunaCc`   = the CC Setsuna ending cleared, which also opens Coda.
 *  - `chiakiNormal`= the CC Chiaki normal end cleared, which unlocks her
 *                    true-end option.
 * Returns an empty list when no gate is set, so the caller can omit the
 * whole line instead of printing a row of zeros. */
export function profileGateLabels(gates: Record<string, number> | null | undefined): string[] {
  if (!gates) return [];
  const out: string[] = [];
  if ((gates.replay ?? 0) > 0) out.push("New Game+");
  if ((gates.codaEntered ?? 0) > 0 || (gates.setsunaCc ?? 0) > 0) out.push("Coda unlocked");
  if ((gates.chiakiNormal ?? 0) > 0) out.push("Chiaki True route unlocked");
  return out;
}

export function profileCard(p: SysProfile, cgRows?: number[][]): string {
  const gallery = cgRows && cgRows.length > 0 ? countGalleryRows(new Set(p.cg), cgRows) : null;
  const imported = p.importedAt ? p.importedAt.slice(0, 16).replace("T", " ") : "unknown";
  const films = p.movies.filter((id) => id !== 0);
  // Gate flags are easy to lose in a stat strip; give them their own line
  // so a cleared Coda / Chiaki True route is actually visible.
  const gates = profileGateLabels(p.gates);
  const stats = [
    `${p.readKeys.length.toLocaleString("en-US")} read lines`,
    `${p.visited.length} visited scripts`,
    `${p.endings.length} ending${p.endings.length === 1 ? "" : "s"}`,
    gallery ? `gallery ${gallery.unlocked}/${gallery.total} CGs` : `gallery ${p.cg.length} CGs`,
    `${p.music.length} music track${p.music.length === 1 ? "" : "s"}`,
    // Movie id 0 is the "all movies unlocked" sentinel, not a film.
    p.movies.includes(0)
      ? `all movies${films.length > 0 ? ` (${films.length} flagged)` : ""}`
      : `${films.length} movie${films.length === 1 ? "" : "s"}`,
  ];
  return `<ol class="slots profile-card" id="profile-card"><li>
      <span class="slot-no">PRO</span>
      <span class="slot-main"><b>Global profile</b>
      <span>${escapeHtml(p.fileName ?? "Sys.sav")} · imported ${escapeHtml(imported)}</span>
      <span>${escapeHtml(stats.join(" · "))}</span>
      ${gates.length > 0
        ? `<span class="profile-gates">${gates.map((g) => `<span class="badge ok">${escapeHtml(g)}</span>`).join(" ")}</span>`
        : ""}</span>
      <span class="slot-actions"><button data-profile-remove>Remove</button></span></li></ol>`;
}

export interface SysSkipCounts {
  /** Files whose size rules out a `Sys.sav` (too big, or a `Sys.sav` name
   * at a size that is not the format's). */
  wrongSize: number[];
  /** `Sys.sav` names/copies that stopped short of the full size. */
  truncated: number[];
  unreadable: number;
  unsupported: number;
}

/** Wording for skipped `Sys.sav` candidates. A wrong-size file, a truncated
 * copy and a build that cannot decode the table are three different
 * mistakes; one generic "file(s) skipped" sentence told the player nothing. */
export function sysSkipNote(c: SysSkipCounts, expected: number = NATIVE_SYS_SIZE): string {
  const bytes = expected.toLocaleString("en-US");
  return [
    c.wrongSize.length
      ? `${c.wrongSize.length} file(s) not a ${bytes}-byte Sys.sav (wrong size); skipped`
      : "",
    c.truncated.length
      ? `${c.truncated.length} Sys.sav copy truncated (shorter than ${bytes} bytes); nothing imported from it`
      : "",
    c.unreadable ? `${c.unreadable} Sys.sav file(s) could not be decoded` : "",
    c.unsupported ? `${c.unsupported} Sys.sav skipped (no slot table in this build)` : "",
  ].filter(Boolean).join("; ");
}

/** Storage can reject the profile and/or the read set while the parse itself
 * succeeded: never report a durable import that was not written. */
export function sysStorageNote(profileSaved: boolean, readKeysPersisted: boolean): string {
  const lost = [
    !profileSaved ? "the profile" : "",
    !readKeysPersisted ? "the imported read lines" : "",
  ].filter(Boolean);
  if (lost.length === 0) return "";
  return `browser storage is full, so ${lost.join(" and ")} could not be stored; ` +
    "the import holds for this session only. Free space, then re-import Sys.sav";
}

export function renderSaves(el: HTMLElement, h: SaveHooks): void {
  const nativeImports = readNativeImports();
  let profile = h.profile ?? readProfile(localStorage);
  const quick = readQuicksave(localStorage);
  const auto = readAutosave(localStorage);
  const storedRow = (
    code: string,
    label: string,
    s: SaveData | null,
    saveAttr: string,
    loadAttr: string,
    expAttr: string,
  ): string => {
    if (!s) {
      return `<li class="empty"><span class="slot-no">${code}</span>
        <span class="slot-main"><b>${label}</b><span>No save yet</span></span>
        <span class="slot-actions">${saveAttr ? `<button ${saveAttr}>Save now</button>` : ""}</span></li>`;
    }
    return `<li><span class="slot-no">${code}</span>
      <span class="slot-main"><b>${label}</b>
      <span>${escapeHtml(s.position.script)}:${s.position.event} · ${escapeHtml(s.updatedAt.slice(0, 16).replace("T", " "))}</span></span>
      <span class="slot-actions"><button ${loadAttr}>Load</button> <button ${expAttr}>File</button>${saveAttr ? ` <button ${saveAttr}>Save now</button>` : ""}</span></li>`;
  };
  let html = `<header class="screen-head"><div><h2>Save / Load</h2>
    <p class="screen-sub">Progress lives in a file you own: export it to keep it,
    import it to restore. Slots are a convenience copy in this browser.</p></div></header>
    <div class="save-row">
      <button data-exp="cur">Export current as file</button>
      <button data-imp-trigger>Import JSON</button>
      <input type="file" data-imp accept="application/json,.json" hidden>
      <button data-native-trigger>Import game saves</button>
      <input type="file" data-native-imp accept=".sav" multiple hidden>
    </div>
    <h3>Quick save &amp; autosave</h3>
    <ol class="slots">
      ${storedRow("Q", "Quick save", quick, "data-quick-save", "data-quick-load", "data-quick-exp")}
      ${storedRow("A", "Autosave", auto, "", "data-auto-load", "data-auto-exp")}
    </ol>
    <h3>Slots</h3><ol class="slots">`;
  for (let i = 0; i < 8; i++) {
    const r = readSlotChecked(localStorage, i);
    if (r.ok) {
      const s = r.save;
      const chapter = s.position.script.startsWith("demo")
        ? "Demo"
        : CHAPTER_LABEL[chapterOfScript(s.position.script)] ?? "Special";
      html += `<li>
        <span class="slot-no">${String(i + 1).padStart(2, "0")}</span>
        <span class="slot-main"><b>${escapeHtml(s.name)}</b>
        <span>${chapter} · ${escapeHtml(s.position.script)}:${s.position.event} · ${escapeHtml(s.updatedAt.slice(0, 10))}</span></span>
        <span class="slot-actions"><button data-load="${i}">Load</button> <button data-exp="${i}">File</button> <button data-save="${i}">Save here</button></span>`;
    } else if (r.corrupt) {
      html += `<li class="corrupt">
        <span class="slot-no">${String(i + 1).padStart(2, "0")}</span>
        <span class="slot-main"><b>Corrupt data</b><span>The slot is not empty, but it cannot be read.</span></span>
        <span class="slot-actions"><button data-save="${i}">Save here</button></span>`;
    } else {
      html += `<li class="empty">
        <span class="slot-no">${String(i + 1).padStart(2, "0")}</span>
        <span class="slot-main"><b>No data</b><span>Empty slot</span></span>
        <span class="slot-actions"><button data-save="${i}">Save here</button></span>`;
    }
    html += `</li>`;
  }
  html += `</ol>
    <h3>Global profile</h3>
    <p class="screen-sub native-note">Import <code>Sys.sav</code> with “Import game saves”.
    It stores read lines (skip-read), visited scripts, high-confidence clear flags,
    seen choices, and gallery, music and movie unlocks in this browser. It never
    changes where you are reading.</p>
    ${profile ? profileCard(profile, h.sysSlots?.cgRows) : `<ol class="slots profile-card" id="profile-card">
      <li class="empty"><span class="slot-no">PRO</span>
      <span class="slot-main"><b>No global profile</b><span>Nothing imported yet.</span></span></li></ol>`}
    <h3>Imported game saves</h3>
    <p class="screen-sub native-note">Native <code>save_XX.sav</code> / <code>save_Q.sav</code>
    files from the English-patched PC build. Position and scene text are imported;
    duplicate lines become separate options. Add <code>Sys.sav</code> for the global
    read lines, visited scripts, ending clears, seen choices, and gallery/music/movie
    unlocks — the reading position is left alone.</p>
    <ol class="slots" id="native-list">`;
  if (nativeImports.length === 0) {
    html += `<li class="empty"><span class="slot-no">--</span>
      <span class="slot-main"><b>No imported saves</b><span>Use “Import game saves” above.</span></span></li>`;
  } else {
    nativeImports.forEach((s, i) => {
      const n = s.native;
      if (!n) return;
      const line = n.preview || n.speaker || "Imported save";
      const meta = [
        `${n.script}:${s.position.event}`,
        n.speaker,
        n.timestamp || s.updatedAt.slice(0, 10),
        n.file,
        n.confidence && n.confidence !== "exact" ? `${n.confidence} match` : "",
        n.candidateCount && n.candidateCount > 1 ? `option ${n.candidate}/${n.candidateCount}` : "",
      ].filter(Boolean).map((x) => escapeHtml(String(x))).join(" · ");
      html += `<li>
        <span class="slot-no">N${String(i + 1).padStart(2, "0")}</span>
        <span class="slot-main"><b>${escapeHtml(line)}</b>
        <span>${meta}</span></span>
        <span class="slot-actions"><button data-native-load="${i}">Load</button> <button data-native-remove="${i}">Remove</button></span>
      </li>`;
    });
  }
  html += `</ol><button class="back" data-back>← Back</button>`;
  el.innerHTML = html;

  el.querySelector('[data-exp="cur"]')?.addEventListener("click", () => {
    download(saveFilename(h.save), serialize(h.save));
  });
  el.querySelectorAll("[data-exp]:not([data-exp='cur'])").forEach((b) =>
    b.addEventListener("click", () => {
      const r = readSlotChecked(localStorage, Number((b as HTMLElement).dataset.exp));
      if (r.ok) download(saveFilename(r.save), serialize(r.save));
      else h.notify("That slot has nothing exportable.");
    }),
  );
  el.querySelectorAll("[data-save]").forEach((b) =>
    b.addEventListener("click", () => {
      const ok = writeSlot(localStorage, Number((b as HTMLElement).dataset.save), h.save);
      h.notify(ok ? "Saved to slot." : "Browser storage is full or unavailable; slot was not saved.");
      renderSaves(el, h);
    }),
  );
  el.querySelectorAll("[data-load]").forEach((b) =>
    b.addEventListener("click", () => {
      const r = readSlotChecked(localStorage, Number((b as HTMLElement).dataset.load));
      if (r.ok) h.onLoad(r.save);
      else h.notify("That slot cannot be loaded.");
    }),
  );

  el.querySelector("[data-quick-save]")?.addEventListener("click", () => {
    const ok = writeQuicksave(localStorage, h.save);
    h.notify(ok ? "Quick saved." : "Browser storage is full or unavailable; quick save failed.");
    renderSaves(el, h);
  });
  el.querySelector("[data-quick-load]")?.addEventListener("click", () => {
    const q = readQuicksave(localStorage);
    if (q) h.onLoad(q);
    else h.notify("No quick save yet.");
  });
  el.querySelector("[data-quick-exp]")?.addEventListener("click", () => {
    const q = readQuicksave(localStorage);
    if (q) download(saveFilename(q), serialize(q));
    else h.notify("No quick save to export.");
  });
  el.querySelector("[data-auto-load]")?.addEventListener("click", () => {
    const a = readAutosave(localStorage);
    if (a) h.onLoad(a);
    else h.notify("No autosave yet.");
  });
  el.querySelector("[data-auto-exp]")?.addEventListener("click", () => {
    const a = readAutosave(localStorage);
    if (a) download(saveFilename(a), serialize(a));
    else h.notify("No autosave to export.");
  });

  const imp = el.querySelector("[data-imp]") as HTMLInputElement | null;
  el.querySelector("[data-imp-trigger]")?.addEventListener("click", () => imp?.click());
  imp?.addEventListener("change", () => {
    const f = imp.files?.[0];
    imp.value = "";
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) {
      h.notify("That JSON file is too large to be a save.");
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      try {
        h.onLoad(deserialize(String(r.result)));
      } catch (e) {
        h.notify(`Import failed: ${(e as Error).message}`);
      }
    };
    r.readAsText(f);
  });

  const nativeImp = el.querySelector("[data-native-imp]") as HTMLInputElement | null;
  el.querySelector("[data-native-trigger]")?.addEventListener("click", () => nativeImp?.click());
  nativeImp?.addEventListener("change", async () => {
    const files = [...(nativeImp.files ?? [])];
    nativeImp.value = "";
    if (files.length === 0) return;
    const imported = readNativeImports();
    let added = 0;
    let systems = 0;
    let sysImported: SysImportResult | null = null;
    /** Files that are clearly a `Sys.sav` but not the full expected size. */
    const sysWrongSize: number[] = [];
    /** Cuts of a `Sys.sav` that stopped half-way (a real but partial file). */
    const sysTruncated: number[] = [];
    let sysUnreadable = 0;
    let sysUnsupported = 0;
    let skipped = 0;
    let japanese = 0;
    let runSave = h.save;
    for (const file of files) {
      try {
        const looksSystem = /^sys\.sav$/i.test(file.name) || file.size === NATIVE_SYS_SIZE;
        if (file.size > NATIVE_SYS_SIZE) {
          // Only a `Sys.sav` name can be a wrong-size system save; any other
          // oversized upload is just not a save this build reads.
          if (looksSystem) sysWrongSize.push(file.size);
          else skipped++;
          continue;
        }
        const buffer = await file.arrayBuffer();
        const parsed = parseNativeFile(buffer, file.name);
        if (parsed.kind === "system") {
          systems++;
          if (!h.sysSlots || !h.flow) {
            sysUnsupported++;
            continue;
          }
          const result = importSysSave(
            buffer, file.name, h.sysSlots, h.router, h.flow, runSave, localStorage,
          );
          if (!result.ok) {
            if (result.reason === "truncated") sysTruncated.push(result.size);
            else sysUnreadable++;
            continue;
          }
          sysImported = result;
          runSave = result.save;
          profile = result.profile;
          h.onProfileChange?.(result.profile);
          continue;
        }
        if (parsed.kind !== "slot") {
          skipped++;
          continue;
        }
        const positions = nativeCandidates(h.router, parsed.save);
        if (positions.length === 0) {
          if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(parsed.save.text)) japanese++;
          skipped++;
          continue;
        }
        positions.forEach((pos, i) => {
          imported.unshift(nativeToSave(
            parsed.save, pos, file.name, i + 1, positions.length,
          ));
          added++;
        });
      } catch {
        skipped++;
      }
    }
    const sysNote = sysImported
      ? `Sys.sav imported: ${sysImported.readKeys.length.toLocaleString("en-US")} read lines ` +
        `(${sysImported.addedReadKeys.toLocaleString("en-US")} new), ` +
        `${sysImported.profile.visited.length} visited scripts, ` +
        `${sysImported.profile.endings.length} endings, ` +
        `${sysImported.profile.cg.length} gallery CGs, ` +
        `${sysImported.profile.music.length} music tracks, ` +
        `${sysImported.profile.movies.includes(0) ? "all movies" : `${sysImported.profile.movies.length} movies`}; ` +
        `reading position unchanged`
      : "";
    // Storage can reject the profile and/or the read set while the parse
    // itself succeeded: never report a durable import we did not write.
    const storageNote = sysImported
      ? sysStorageNote(sysImported.profileSaved, sysImported.readKeysPersisted)
      : "";
    /** Wrong-size and truncated reads are different mistakes: a file that is
     * not `Sys.sav` at all, versus a copy that stopped mid-write. */
    const sysSizeNotes = sysSkipNote({
      wrongSize: sysWrongSize,
      truncated: sysTruncated,
      unreadable: sysUnreadable,
      unsupported: sysUnsupported,
    });
    if (added > 0) {
      const persisted = writeNativeImports(imported);
      const extra = [
        !persisted ? "browser storage is full, so the list could not be persisted" : "",
        storageNote,
        sysNote,
        sysSizeNotes,
        japanese ? `${japanese} Japanese-language save(s) could not be matched to the English script` : "",
        skipped && !japanese ? `${skipped} file(s) skipped` : "",
      ].filter(Boolean).join("; ");
      h.notify(`Imported ${added} native save option${added === 1 ? "" : "s"}${extra ? `; ${extra}` : ""}.`);
    } else if (sysNote) {
      const trailer = [
        storageNote,
        sysSizeNotes,
        skipped && !japanese ? `${skipped} other file(s) skipped` : "",
      ].filter(Boolean).join("; ");
      h.notify(`${sysNote}${trailer ? `; ${trailer}` : ""}.`);
    } else if (sysWrongSize.length > 0) {
      h.notify(
        `That file is ${sysWrongSize[0]!.toLocaleString("en-US")} bytes; a Sys.sav is exactly ` +
        `${NATIVE_SYS_SIZE.toLocaleString("en-US")} bytes, so it was not imported.`,
      );
    } else if (sysTruncated.length > 0) {
      h.notify(
        `Sys.sav is shorter than the expected ${NATIVE_SYS_SIZE.toLocaleString("en-US")} bytes; ` +
        "the copy is truncated, so nothing was imported.",
      );
    } else if (sysUnreadable > 0) {
      h.notify("Sys.sav could not be decoded; nothing was imported.");
    } else if (systems > 0) {
      h.notify("Sys.sav was recognized, but this build has no slot table to decode it with.");
    } else if (japanese > 0) {
      h.notify("Native saves were read, but their text is Japanese; this build matches English-patched saves only.");
    } else {
      h.notify(`No native saves matched this build (${skipped} skipped).`);
    }
    renderSaves(el, { ...h, profile });
  });

  el.querySelector("[data-profile-remove]")?.addEventListener("click", () => {
    clearProfile(localStorage);
    profile = null;
    h.onProfileChange?.(null);
    h.notify("Global profile removed. Read lines already stored in this browser are kept.");
    renderSaves(el, { ...h, profile });
  });

  el.querySelectorAll("[data-native-load]").forEach((b) =>
    b.addEventListener("click", () => {
      const s = readNativeImports()[Number((b as HTMLElement).dataset.nativeLoad)];
      if (s) h.onLoad(s);
      else h.notify("That imported save is no longer available.");
    }),
  );
  el.querySelectorAll("[data-native-remove]").forEach((b) =>
    b.addEventListener("click", () => {
      const list = readNativeImports();
      list.splice(Number((b as HTMLElement).dataset.nativeRemove), 1);
      if (!writeNativeImports(list)) {
        h.notify("Browser storage is full; the imported save could not be removed.");
      }
      renderSaves(el, h);
    }),
  );
  el.querySelector("[data-back]")?.addEventListener("click", h.onBack);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
