// Extras screen: CG gallery, music player and scene replay.
//
// Everything here is BYOA-driven: the gallery rows, scene slots and unlock
// bands come from the committed `Sys.sav` slot table / imported profile, never
// from game text. Locked entries deliberately carry no image URL, CG id or
// script id in the DOM so a menu screenshot cannot spoil a scene.

import { bgmTrackUrl, imageUrl } from "../engine/assets";
import type { SysProfile, SysSlotsTable } from "../engine/types";

export type SceneSlot = NonNullable<SysSlotsTable["sceneSlots"]>[number];

/** `SysProfile.music` stores the track id (`slot - 100`, 1..99); the Region C
 * flag band is 101..199. Accept both forms when matching an imported profile,
 * and label the row with the real `BGM_%03d` track number. */
export const MUSIC_BAND_FIRST = 101;
/** Documented unlock band (PARSING: ~101..174; 175..199 are not used by
 * the shipped BGM set). The menu labels the real BGM file number (1..74). */
export const MUSIC_BAND_LAST = 174;

export function musicBandIds(): number[] {
  const out: number[] = [];
  for (let band = MUSIC_BAND_FIRST; band <= MUSIC_BAND_LAST; band++) out.push(band);
  return out;
}

/** Actual BGM file number for a menu band slot (`BGM_%03d`). */
export function musicBandTrack(band: number): number {
  return band - 100;
}

export function musicUnlocked(music: Iterable<number>, band: number): boolean {
  const track = musicBandTrack(band);
  for (const id of music) {
    if (id === band || id === track) return true;
  }
  return false;
}

/** Normalize a gallery/Region B id to its CG number (`part * 1e6 + cgId`). */
export function normalizeCgId(id: number): number {
  return id % 1_000_000;
}

/** A CG id is unlocked when the profile contains it either as a raw Region B
 * index (`part * 1_000_000 + cgId`) or as the bare CG number. */
export function cgIdUnlocked(cgIds: Iterable<number>, id: number): boolean {
  if (!Number.isFinite(id) || id === 0) return false;
  const want = normalizeCgId(id);
  for (const value of cgIds) {
    if (!Number.isFinite(value) || value === 0) continue;
    if (value === id || normalizeCgId(value) === want) return true;
  }
  return false;
}

export function cgRowUnlocked(row: readonly number[], cgIds: Iterable<number>): boolean {
  return row.some((id) => id !== 0 && cgIdUnlocked(cgIds, id));
}

/** Row-level gallery count: a row is unlocked when any of its ten cells is. */
export function countCgRows(
  cgRows: readonly (readonly number[])[],
  cgIds: Iterable<number>,
): { unlocked: number; total: number } {
  const have = new Set<number>();
  for (const value of cgIds) {
    if (!Number.isFinite(value) || value === 0) continue;
    have.add(normalizeCgId(value));
  }
  let unlocked = 0;
  for (const row of cgRows) {
    if (row.some((id) => id !== 0 && (have.has(id) || have.has(normalizeCgId(id))))) unlocked++;
  }
  return { unlocked, total: cgRows.length };
}

/** Scene entry unlock: its CG is in the imported gallery, or its explicit
 * H-scene flag is set (either the `Region C - 300` ero band or the raw
 * GetGameFlag slot). */
export function sceneUnlocked(scene: SceneSlot, profile: SysProfile | null): boolean {
  if (!profile) return false;
  if (cgIdUnlocked(profile.cg ?? [], scene.cg)) return true;
  const ero = profile.ero ?? [];
  if (ero.includes(scene.flag - 300) || ero.includes(scene.flag)) return true;
  const gameFlag = profile.gameFlags?.[String(scene.flag)];
  return typeof gameFlag === "number" && gameFlag !== 0;
}

/** Chapter band for a CG id: intro assets live under `ic/`, closing and coda
 * ids follow the same 10/20/30 family prefixes as script ids. */
export function cgChapter(id: number): string {
  const n = normalizeCgId(id);
  const prefix = Math.floor(n / 10_000);
  if (prefix === 10) return "intro";
  if (prefix >= 20 && prefix <= 29) return "closing";
  if (prefix >= 30 && prefix <= 59) return "coda";
  return "special";
}

export interface CgImageCandidate {
  file: string;
  chapter: string;
}

/** Image candidates for one CG: `v%06d.tga` then `h%06d.tga` (the two engine
 * CG forms), then the same pair under `ic/` for intro assets. */
export function cgImageCandidates(id: number): CgImageCandidate[] {
  const num = String(normalizeCgId(id)).padStart(6, "0");
  const chapter = cgChapter(id);
  const chapters = chapter === "intro" ? ["intro"] : [chapter, "intro"];
  const out: CgImageCandidate[] = [];
  for (const ch of chapters) {
    out.push({ file: `v${num}.tga`, chapter: ch });
    out.push({ file: `h${num}.tga`, chapter: ch });
    // The PC release also ships 124 `tv%06d.tga` CGs (no current gallery row
    // is tv-only, but a BYOA pack may provide one).
    out.push({ file: `tv${num}.tga`, chapter: ch });
  }
  return out;
}

export function resolveCgImage(
  id: number,
  resolve: (file: string, chapter?: string) => string | null = imageUrl,
): string | null {
  for (const candidate of cgImageCandidates(id)) {
    const url = resolve(candidate.file, candidate.chapter);
    if (url) return url;
  }
  return null;
}

// ---- Shared menu preview audio ------------------------------------------
// One element for the extras music player and the backlog voice replay:
// opening a second preview always stops the first one. The caller owns the
// visible button state through the optional `onStop` hook (fired on stop and
// when a non-looping clip reaches its end).

let previewEl: HTMLAudioElement | null = null;
let previewUrl: string | null = null;
let previewStop: (() => void) | null = null;

export function previewPlayingUrl(): string | null {
  return previewUrl;
}

export interface PreviewOptions {
  loop?: boolean;
  /** Called when playback stops, changes or ends. */
  onStop?: () => void;
}

export function playPreviewAudio(url: string, volume: number, opts: PreviewOptions = {}): void {
  stopPreviewAudio();
  if (typeof Audio === "undefined") return;
  if (!previewEl) {
    previewEl = new Audio();
    previewEl.preload = "auto";
    previewEl.addEventListener("ended", () => {
      if (!previewEl || previewEl.loop) return;
      const hook = previewStop;
      previewUrl = null;
      previewStop = null;
      hook?.();
    });
  }
  previewUrl = url;
  previewStop = opts.onStop ?? null;
  previewEl.loop = opts.loop === true;
  previewEl.src = url;
  previewEl.volume = Math.max(0, Math.min(1, volume));
  previewEl.play().catch(() => stopPreviewAudio());
}

export function stopPreviewAudio(): void {
  const el = previewEl;
  const hook = previewStop;
  previewUrl = null;
  previewStop = null;
  if (el) {
    el.pause();
    el.removeAttribute("src");
    el.load();
  }
  hook?.();
}

// ---- Extras screen ------------------------------------------------------

export type ExtraTab = "cg" | "music" | "scenes";

let activeTab: ExtraTab = "cg";

export interface ExtrasHooks {
  profile: SysProfile | null;
  cgRows: readonly (readonly number[])[];
  /** Optional H-scene replay table; absent hides the Scenes tab. */
  sceneSlots?: readonly SceneSlot[];
  settings: { dev: boolean; bgmVol: number };
  onReplay(scene: SceneSlot): void;
}

export function renderExtras(el: HTMLElement, h: ExtrasHooks): void {
  closeGalleryOverlay();
  stopPreviewAudio();
  const scenes = h.sceneSlots ?? [];
  const hasScenes = scenes.length > 0;
  if (activeTab === "scenes" && !hasScenes) activeTab = "cg";

  const counts = countCgRows(h.cgRows, h.profile?.cg ?? []);
  const music = h.profile?.music ?? [];
  let musicCount = 0;
  for (const band of musicBandIds()) if (musicUnlocked(music, band)) musicCount++;
  let sceneCount = 0;
  for (const scene of scenes) if (sceneUnlocked(scene, h.profile)) sceneCount++;

  el.innerHTML = `<div class="extras-tabs" role="tablist" aria-label="Extras">
    <button type="button" class="extras-tab" role="tab" data-tab="cg" aria-controls="extras-panel"
      aria-selected="${activeTab === "cg"}">CG gallery<span class="extras-tab-count">${counts.unlocked}/${counts.total}</span></button>
    <button type="button" class="extras-tab" role="tab" data-tab="music" aria-controls="extras-panel"
      aria-selected="${activeTab === "music"}">Music<span class="extras-tab-count">${musicCount}/${MUSIC_BAND_LAST - MUSIC_BAND_FIRST + 1}</span></button>
    ${hasScenes ? `<button type="button" class="extras-tab" role="tab" data-tab="scenes" aria-controls="extras-panel"
      aria-selected="${activeTab === "scenes"}">Scenes<span class="extras-tab-count">${sceneCount}/${scenes.length}</span></button>` : ""}
  </div>
  <div class="extras-panel" id="extras-panel" role="tabpanel"></div>`;

  const panel = el.querySelector("#extras-panel") as HTMLElement;
  const tabs = [...el.querySelectorAll<HTMLButtonElement>("[data-tab]")];

  const select = (tab: ExtraTab): void => {
    if (tab === activeTab) return;
    stopPreviewAudio();
    activeTab = tab;
    syncTabs();
    renderPanel();
  };
  const syncTabs = (): void => {
    for (const btn of tabs) {
      const on = btn.dataset.tab === activeTab;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", String(on));
      btn.tabIndex = on ? 0 : -1;
    }
  };

  const play = (url: string, opts: PreviewOptions = {}): void => {
    playPreviewAudio(url, h.settings.bgmVol, {
      ...opts,
      onStop: () => {
        opts.onStop?.();
        syncMusicButtons();
      },
    });
  };

  const syncMusicButtons = (): void => {
    panel.querySelectorAll<HTMLButtonElement>("[data-track]").forEach((btn) => {
      const on = previewPlayingUrl() === btn.dataset.url;
      btn.textContent = on ? "Stop" : "Play";
      btn.setAttribute("aria-pressed", String(on));
      btn.closest(".music-row")?.classList.toggle("playing", on);
    });
  };

  const renderPanel = (): void => {
    if (activeTab === "cg") renderCg();
    else if (activeTab === "music") renderMusic();
    else renderScenes();
  };

  const renderCg = (): void => {
    const cgIds = h.profile?.cg ?? [];
    const cells = h.cgRows.map((row, i) => {
      if (!cgRowUnlocked(row, cgIds)) {
        return `<div class="cg-cell locked" data-row="${i}" aria-hidden="true"></div>`;
      }
      const unlockedIds = row.filter((v) => v !== 0 && cgIdUnlocked(cgIds, v));
      let id = unlockedIds[0];
      let url: string | null = null;
      for (const cid of unlockedIds) {
        const candidate = resolveCgImage(cid);
        if (!candidate) continue;
        id = cid;
        url = candidate;
        break;
      }
      if (id === undefined || url === null) {
        return `<div class="cg-cell missing" data-row="${i}" title="Asset not installed">
          <span aria-hidden="true">—</span></div>`;
      }
      return `<button type="button" class="cg-cell" data-row="${i}" data-cg="${id}"
        data-full="${escapeAttr(url)}" aria-label="CG ${String(i + 1).padStart(3, "0")}">
        <img src="${escapeAttr(url)}" alt="" loading="lazy" decoding="async">
      </button>`;
    }).join("");
    panel.innerHTML = `<p class="extras-count">${counts.unlocked} / ${counts.total} rows unlocked</p>
      <p class="extras-note">Gallery unlocks come from the imported system profile. Locked rows stay hidden until the CG is seen.</p>
      ${h.cgRows.length > 0
        ? `<div class="cg-grid">${cells}</div>`
        : `<p class="dim">This build has no gallery table.</p>`}`;
    panel.querySelectorAll<HTMLButtonElement>(".cg-cell[data-full]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const url = btn.dataset.full;
        if (!url) return;
        openGalleryOverlay(url, btn.dataset.cg ?? "", btn);
      });
    });
  };

  const renderMusic = (): void => {
    const rows = musicBandIds().map((band) => {
      const track = musicBandTrack(band);
      const no = String(track).padStart(3, "0");
      const label = `Track ${no}`;
      if (!musicUnlocked(h.profile?.music ?? [], band)) {
        return `<li class="music-row locked"><span class="music-no">${no}</span>
          <span class="music-name">${label}</span><span class="dim">Locked</span></li>`;
      }
      const url = bgmTrackUrl(track);
      if (!url) {
        return `<li class="music-row"><span class="music-no">${no}</span>
          <span class="music-name">${label}</span><span class="dim">Asset not installed</span></li>`;
      }
      return `<li class="music-row"><span class="music-no">${no}</span>
        <span class="music-name">${label}</span>
        <button type="button" class="track-play" data-track="${track}"
          data-url="${escapeAttr(url)}" aria-pressed="false">Play</button></li>`;
    }).join("");
    panel.innerHTML = `<p class="extras-count">${musicCount} / ${MUSIC_BAND_LAST - MUSIC_BAND_FIRST + 1} tracks unlocked</p>
      <p class="extras-note">One shared preview player; switching tracks stops the previous one.</p>
      <ol class="music-list">${rows}</ol>`;
    panel.querySelectorAll<HTMLButtonElement>("[data-track]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const url = btn.dataset.url;
        if (!url) return;
        if (previewPlayingUrl() === url) stopPreviewAudio();
        else play(url, { loop: true });
        syncMusicButtons();
      });
    });
    syncMusicButtons();
  };

  const renderScenes = (): void => {
    const rows = scenes.map((scene, i) => {
      const n = String(i + 1).padStart(2, "0");
      if (!sceneUnlocked(scene, h.profile)) {
        return `<li class="scene-row locked"><span class="scene-no">${n}</span>
          <span class="scene-name">Locked</span></li>`;
      }
      const dev = h.settings.dev ? ` · <code>${escapeHtml(scene.script)}</code>` : "";
      return `<li class="scene-row"><span class="scene-no">${n}</span>
        <button type="button" class="scene-play" data-scene="${i}">Play scene ${n}</button>
        <span class="scene-meta">CG ${scene.cg} · Chapter ${scene.chapter + 1}${dev}</span></li>`;
    }).join("");
    panel.innerHTML = `<p class="extras-warning">Story progress from a replay is discarded; unlocks still count.</p>
      <p class="extras-note">Scene replays start from the beginning of the scene.</p>
      <ol class="scene-list">${rows}</ol>`;
    panel.querySelectorAll<HTMLButtonElement>("[data-scene]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const scene = scenes[Number(btn.dataset.scene)];
        if (!scene || !sceneUnlocked(scene, h.profile)) return;
        stopPreviewAudio();
        h.onReplay(scene);
      });
    });
  };

  for (const btn of tabs) {
    btn.addEventListener("click", () => select(btn.dataset.tab as ExtraTab));
    btn.addEventListener("keydown", (e) => {
      // Arrow-key tab switching mirrors the native tablist convention.
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const i = tabs.indexOf(btn);
      const next = tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
      if (next) {
        next.focus();
        select(next.dataset.tab as ExtraTab);
      }
    });
  }
  syncTabs();
  renderPanel();
}

// ---- Full-size CG overlay ----------------------------------------------

let closeOverlay: (() => void) | null = null;

export function closeGalleryOverlay(): void {
  closeOverlay?.();
}

function openGalleryOverlay(url: string, cg: string, opener: HTMLElement): void {
  closeGalleryOverlay();
  const overlay = document.createElement("div");
  overlay.className = "cg-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", cg ? `CG ${cg}` : "CG preview");
  overlay.innerHTML = `<button type="button" class="cg-overlay-close" aria-label="Close">×</button>
    <img src="${escapeAttr(url)}" alt="">`;
  const closeBtn = overlay.querySelector(".cg-overlay-close") as HTMLButtonElement;
  const img = overlay.querySelector("img") as HTMLImageElement;

  const close = (): void => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    closeOverlay = null;
    if (opener.isConnected) opener.focus();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    // The close button is the only focusable node inside the modal; keep
    // Tab from walking into the page behind it.
    if (e.key === "Tab") {
      e.preventDefault();
      closeBtn.focus();
    }
  };
  // Anywhere outside the image closes (the backdrop is the overlay itself).
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  closeBtn.addEventListener("click", close);
  img.addEventListener("error", () => {
    img.replaceWith(Object.assign(document.createElement("p"), {
      className: "dim cg-overlay-missing",
      textContent: "This image is not in the installed asset pack.",
    }));
  });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);
  closeOverlay = close;
  closeBtn.focus();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
