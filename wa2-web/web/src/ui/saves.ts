// Save/Load screen: localStorage slots + progress-as-a-file export/import.

import {
  deserialize,
  download,
  readAutosave,
  readQuicksave,
  readSlotChecked,
  saveFilename,
  serialize,
  storageKey,
  writeQuicksave,
  writeSlot,
} from "../engine/save";
import { chapterOfScript, type Router } from "../engine/router";
import { findNativeCandidates, nativeToSave, parseNativeFile, type NativePosition, type NativeSave, NATIVE_SYS_SIZE } from "../engine/native-save";
import type { SaveData } from "../engine/types";

export interface SaveHooks {
  /** Used to resolve native save script ids and line text. */
  router: Router;
  save: SaveData;
  onLoad(s: SaveData): void;
  onBack(): void;
  notify(msg: string): void;
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

export function renderSaves(el: HTMLElement, h: SaveHooks): void {
  const nativeImports = readNativeImports();
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
    <h3>Imported game saves</h3>
    <p class="screen-sub native-note">Native <code>save_XX.sav</code> / <code>save_Q.sav</code>
    files from the English-patched PC build. Position and scene text are imported;
    duplicate lines become separate options. The global <code>Sys.sav</code>
    read/choice flags are not imported yet.</p>
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
    let skipped = 0;
    let japanese = 0;
    for (const file of files) {
      try {
        if (file.size > NATIVE_SYS_SIZE) {
          skipped++;
          continue;
        }
        const parsed = parseNativeFile(await file.arrayBuffer(), file.name);
        if (parsed.kind === "system") {
          systems++;
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
    if (added > 0) {
      const persisted = writeNativeImports(imported);
      const extra = [
        !persisted ? "browser storage is full, so the list could not be persisted" : "",
        systems ? `${systems} Sys.sav recognized (global flags pending)` : "",
        japanese ? `${japanese} Japanese-language save(s) could not be matched to the English script` : "",
        skipped && !japanese ? `${skipped} file(s) skipped` : "",
      ].filter(Boolean).join("; ");
      h.notify(`Imported ${added} native save option${added === 1 ? "" : "s"}${extra ? `; ${extra}` : ""}.`);
    } else if (systems > 0) {
      h.notify("Sys.sav recognized. Global read/choice flags are not imported yet.");
    } else if (japanese > 0) {
      h.notify("Native saves were read, but their text is Japanese; this build matches English-patched saves only.");
    } else {
      h.notify(`No native saves matched this build (${skipped} skipped).`);
    }
    renderSaves(el, h);
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
