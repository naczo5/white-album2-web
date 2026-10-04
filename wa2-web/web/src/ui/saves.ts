// Save/Load screen: localStorage slots + progress-as-a-file export/import.

import {
  deserialize,
  download,
  readSlotChecked,
  saveFilename,
  serialize,
  writeSlot,
} from "../engine/save";
import type { SaveData } from "../engine/types";

export interface SaveHooks {
  save: SaveData;
  onLoad(s: SaveData): void;
  onBack(): void;
  notify(msg: string): void;
}

export function renderSaves(el: HTMLElement, h: SaveHooks): void {
  let html = `<div class="screen-head"><h2>Save / Load</h2>
    <div class="dim">Progress lives in a file you own: export to keep it, import to restore.
    Slots are a convenience copy in this browser.</div></div>
    <div class="save-row">
      <button data-exp="cur">⬇ Export current as file</button>
      <label class="import">⬆ Import file <input type="file" data-imp accept="application/json,.json" hidden></label>
    </div>
    <h3>Slots</h3><ol class="slots">`;
  for (let i = 0; i < 8; i++) {
    const r = readSlotChecked(localStorage, i);
    if (r.ok) {
      const s = r.save;
      html += `<li>Slot ${i + 1}: <b>${escapeHtml(s.name)}</b>
        <span class="dim">${escapeHtml(s.position.script)}:${s.position.event} · ${escapeHtml(s.updatedAt.slice(0, 10))}</span>
        <button data-load="${i}">Load</button> <button data-exp="${i}">File</button>`;
    } else if (r.corrupt) {
      html += `<li>Slot ${i + 1}: <span class="lock">corrupt data (not empty)</span>`;
    } else {
      html += `<li>Slot ${i + 1}: <span class="dim">empty</span>`;
    }
    html += ` <button data-save="${i}">Save here</button></li>`;
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
      writeSlot(localStorage, Number((b as HTMLElement).dataset.save), h.save);
      h.notify("Saved to slot.");
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
  const imp = el.querySelector("[data-imp]") as HTMLInputElement | null;
  imp?.addEventListener("change", () => {
    const f = imp.files?.[0];
    imp.value = "";
    if (!f) return;
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
  el.querySelector("[data-back]")?.addEventListener("click", h.onBack);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
