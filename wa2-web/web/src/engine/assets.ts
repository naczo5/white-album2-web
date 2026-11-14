// Asset manifest: maps engine file ids (b105300.tga, sepia.AMP, mv01, voice)
// to real URLs under /assets (BYOA-supplied by tools/extract_assets.py).
// Missing assets resolve to `null` and the UI renders tasteful placeholders,
// so the game is fully playable text-first with zero assets installed.

export interface AssetManifest {
  version: 1;
  images: Record<string, string>;
  bgm: Record<string, string>;
  sfx: Record<string, string>;
  voice: Record<string, string>;
  movies: Record<string, string>;
  /** Optional WebVTT tracks, keyed like movies (mv01, mv010, ...). BYOA
   * supplied: the repo ships none. */
  subtitles?: Record<string, string>;
}

let manifest: AssetManifest | null = null;
// Indexed voice lookup: "{script}_{line}" -> urls (main + ic/ variants).
// Built on load; per-line lookup is O(1) instead of scanning 46k keys.
let voiceIdx: Map<string, string[]> | null = null;

export async function loadManifest(url: string): Promise<AssetManifest | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    manifest = (await res.json()) as AssetManifest;
    // Manifest values are paths relative to the manifest's own directory
    // (e.g. "ic/cg/X.png" inside assets/manifest.json). Rebase them to
    // page-relative URLs once, here, so every lookup below returns a
    // fetchable URL in both dev (public/) and build (dist/) layouts.
    const base = url.slice(0, url.lastIndexOf("/") + 1);
    for (const table of [manifest.images, manifest.bgm, manifest.sfx,
      manifest.voice, manifest.movies, manifest.subtitles]) {
      if (!table) continue;
      for (const [k, v] of Object.entries(table)) {
        if (!/^(https?:|data:|blob:|\/)/.test(v)) table[k] = base + v;
      }
    }
    voiceIdx = new Map();
    for (const [key, val] of Object.entries(manifest.voice ?? {})) {
      // Keys are already archive line keys ("1008_0199",
      // "1008_020_0199", "ic/1002_0000"); keep the whole key. The old
      // `(\d+_\d+)` capture collapsed a variant script suffix into the line
      // key and made those clips unreachable from voiceUrl().
      if (!/^(ic\/)?[0-9]/.test(key)) continue;
      const arr = voiceIdx.get(key) ?? [];
      arr.push(val);
      voiceIdx.set(key, arr);
    }
    return manifest;
  } catch {
    return null;
  }
}

function lookup(table: Record<string, string> | undefined, key: string): string | null {
  if (!table) return null;
  const direct = table[key];
  if (direct) return direct;
  const lower = table[key.toLowerCase()];
  return lower ?? null;
}

export function imageUrl(file: string, chapter?: string): string | null {
  if (chapter === "intro") {
    const ic = lookup(manifest?.images, `ic/${file}`) ??
      lookup(manifest?.images, `ic/${file.toLowerCase()}`);
    if (ic) return ic;
  }
  return lookup(manifest?.images, file);
}

export function bgmUrl(file: string, chapter?: string): string | null {
  // Legacy .AMP-stem cue path (pre-.bnr era): kept for IR compat; the live
  // BGM timeline comes from data/bgm.json via bgmTrackUrl().
  const stem = file.replace(/\.[^.]+$/, "");
  const cands = chapter === "intro"
    ? [`ic-${file}`, `ic-${stem}.ogg`, `ic-${stem}.mp3`]
    : [];
  for (const c of cands) {
    const hit = lookup(manifest?.bgm, c);
    if (hit) return hit;
  }
  return (
    lookup(manifest?.bgm, file) ??
    lookup(manifest?.bgm, `${stem}.ogg`) ??
    lookup(manifest?.bgm, `${stem}.mp3`) ??
    null
  );
}

/**
 * BGM part URLs for a .bnr cue. Engine strings (tools/proto_bgm_report.md):
 * `BGM_%03d_a.ogg` = loop intro, `_b` = loop body, bare = solo. The extractor
 * namespaces IC nested-LAC audio as `ic-<file>` (images/voice use `ic/`), so
 * both forms are probed.
 */
function bgmPartUrl(track: number, suffix: "" | "_A" | "_B", chapter?: string): string | null {
  const id = `BGM_${String(track).padStart(3, "0")}${suffix}`;
  const cands = chapter === "intro"
    ? [`ic/${id}.OGG`, `ic/${id}.ogg`, `ic/${id}.g`,
       `ic-${id}.OGG`, `ic-${id}.ogg`, `ic-${id}.g`]
    : [];
  cands.push(`${id}.OGG`, `${id}.ogg`, `${id}.g`);
  for (const c of cands) {
    const hit = lookup(manifest?.bgm, c);
    if (hit) return hit;
  }
  return null;
}

/** Loop intro part (`_A`), if shipped. */
export function bgmIntroUrl(track: number, chapter?: string): string | null {
  return bgmPartUrl(track, "_A", chapter);
}

/** Loop body (`_B`), if shipped. */
export function bgmLoopUrl(track: number, chapter?: string): string | null {
  return bgmPartUrl(track, "_B", chapter);
}

/** Single-file track (no loop pair). */
export function bgmSoloUrl(track: number, chapter?: string): string | null {
  return bgmPartUrl(track, "", chapter);
}

/** Convenience: the track's loop body, then intro, then solo. */
export function bgmTrackUrl(track: number, chapter?: string): string | null {
  return bgmLoopUrl(track, chapter) ?? bgmIntroUrl(track, chapter) ??
    bgmSoloUrl(track, chapter);
}

/** Sound-effect file by engine id (SE_%04d). Chapter-namespaced like BGM. */
export function seUrl(id: number | string, chapter?: string): string | null {
  const base = typeof id === "number" ? `SE_${String(id).padStart(4, "0")}` : id;
  const cands = chapter === "intro"
    ? [`ic/${base}.WAV`, `ic/${base}.wav`, `ic/${base}.w`, `ic/${base}.W`,
       `ic-${base}.WAV`, `ic-${base}.wav`, `ic-${base}.w`, `ic-${base}.W`]
    : [];
  cands.push(`${base}.WAV`, `${base}.wav`, `${base}.w`, `${base}.W`,
             `${base}.ogg`, `${base}.OGG`, `${base}.g`);
  for (const c of cands) {
    const hit = lookup(manifest?.sfx, c);
    if (hit) return hit;
  }
  return null;
}

export function resolveMovieUrl(
  table: Record<string, string> | undefined,
  id: string,
): string | null {
  // Engine cues are mvNN; files are mvNN0 (high) / mvNN1 (low) pairs.
  const key = id.toLowerCase();
  return lookup(table, key) ??
    lookup(table, `${key}0`) ??
    lookup(table, `${key}1`) ??
    lookup(table, `${key}.mp4`);
}

export function movieUrl(id: string): string | null {
  return resolveMovieUrl(manifest?.movies, id);
}

/** WebVTT track for a movie cue, if the pack ships one.
 * Same key chain as the movie file (mv01 -> mv010 / mv011), and the
 * `.mp4`-stripped form so `mv010.mp4.vtt`-style manifests also resolve. */
export function subtitleUrl(id: string): string | null {
  const key = id.toLowerCase();
  return lookup(manifest?.subtitles, key) ??
    lookup(manifest?.subtitles, `${key}0`) ??
    lookup(manifest?.subtitles, `${key}1`) ??
    lookup(manifest?.subtitles, `${key}.mp4`);
}

/**
 * Voice clip for a scenario line. Engine files are named
 * `{script}_{token:04d}_{take}.OGG` (names XOR-0xFF obfuscated in the
 * archive); the token is the raw comma-token index, recorded on every
 * say/narrate event as `tok`. Intro lines live under `ic/`.
 */
export function voiceUrl(script: string, tok: number | undefined, chapter?: string): string | null {
  if (tok === undefined || !voiceIdx) return null;
  const line = String(tok).padStart(4, "0");
  // Variant scripts share their family's voice pool (exe key chain:
  // 1008_020 -> 1008_0199). The exact-key voicemap normally handles this;
  // this chain keeps the legacy bare-NNN fallback working for variants too.
  const chain: string[] = [];
  let base = script;
  for (;;) {
    chain.push(base);
    if (!base.includes("_")) break;
    base = base.slice(0, base.lastIndexOf("_"));
  }
  if (chapter === "intro") {
    for (const b of chain) {
      const ic = voiceIdx.get(`ic/${b}_${line}`);
      if (ic?.length) return ic[0];
    }
  }
  for (const b of chain) {
    const main = voiceIdx.get(`${b}_${line}`);
    if (main?.length) return main[0];
  }
  return null;
}

/**
 * Voice clip by exact archive line key ("1008_0199" or "ic/1002_0000"),
 * as resolved by tools/build_voice.py (family-base chain for variant
 * scripts). Preferred path: the key IS the manifest key.
 */
export function voiceUrlByKey(key: string): string | null {
  return lookup(manifest?.voice, key);
}

export function hasAssets(): boolean {
  return manifest !== null;
}

const VPK_CACHE_MAX = 8;
const BLOB_CACHE_MAX = 128;
const BLOB_CACHE_BYTES = 32 * 1024 * 1024;
const vpkPromises = new Map<string, Promise<ArrayBuffer | null>>();
const vpkBuffers = new Map<string, ArrayBuffer>();
const blobUrls = new Map<string, string>();
const blobBytes = new Map<string, number>();
let blobTotalBytes = 0;
// Audio resolution in flight, keyed by manifest URL (including the range).
// Callers that preload and callers that play share one request.
const audioPromises = new Map<string, Promise<string | null>>();

function lruGet<K, V>(map: Map<K, V>, key: K): V | undefined {
  const v = map.get(key);
  if (v !== undefined) {
    map.delete(key);
    map.set(key, v);
  }
  return v;
}

async function fetchVpk(packUrl: string): Promise<ArrayBuffer | null> {
  const cached = lruGet(vpkBuffers, packUrl);
  if (cached) return cached;
  const inflight = vpkPromises.get(packUrl);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const res = await fetch(packUrl);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      vpkBuffers.set(packUrl, buf);
      while (vpkBuffers.size > VPK_CACHE_MAX) {
        const oldest = vpkBuffers.keys().next().value;
        if (oldest === undefined) break;
        vpkBuffers.delete(oldest);
      }
      return buf;
    } catch {
      return null;
    } finally {
      vpkPromises.delete(packUrl);
    }
  })();
  vpkPromises.set(packUrl, p);
  return p;
}

const VPK_REF_RE = /^(.+)#(\d+)-(\d+)(?::([a-z0-9]+))?$/i;

/**
 * Resolve an audio manifest URL into a playable src. Plain URLs return as-is;
 * packed `.vpk#<start>-<end>` refs are fetched with an HTTP Range request so a
 * 24 KB voice line does not download the whole 1.5 MB script chunk. Servers
 * that ignore `Range` still work: a 200 response is sliced locally, and a
 * failed range request falls back to one cached full-chunk fetch.
 */
export async function resolveAudioUrl(url: string | null): Promise<string | null> {
  if (!url) return null;
  const m = VPK_REF_RE.exec(url);
  if (!m) return url;
  const existing = lruGet(blobUrls, url);
  if (existing) return existing;
  const inflight = audioPromises.get(url);
  if (inflight) return inflight;
  const [, packUrl, startStr, endStr, ext] = m;
  const start = Number(startStr);
  const end = Number(endStr);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const p = (async (): Promise<string | null> => {
    let slice: ArrayBuffer | null = null;
    try {
      const res = await fetch(packUrl, {
        headers: { Range: `bytes=${start}-${end - 1}` },
        cache: "force-cache",
      });
      if (res.status === 206) {
        const body = await res.arrayBuffer();
        // A proxy that returns the wrong range would decode as garbage:
        // reject it and fall back to the full chunk instead of guessing.
        if (body.byteLength === end - start) slice = body;
      } else if (res.ok) {
        const whole = await res.arrayBuffer();
        if (end <= whole.byteLength) slice = whole.slice(start, end);
      }
    } catch {
      /* Range blocked/unsupported: full-chunk fallback below. */
    }
    if (!slice) {
      const whole = await fetchVpk(packUrl);
      if (!whole || end > whole.byteLength) return null;
      slice = whole.slice(start, end);
    }
    if (!slice || slice.byteLength === 0) return null;
    const mime = ext?.toLowerCase() === "wav" ? "audio/wav" : "audio/ogg";
    const blob = new Blob([slice], { type: mime });
    const objUrl = URL.createObjectURL(blob);
    blobUrls.set(url, objUrl);
    blobBytes.set(url, blob.size);
    blobTotalBytes += blob.size;
    while (blobUrls.size > BLOB_CACHE_MAX ||
      (blobTotalBytes > BLOB_CACHE_BYTES && blobUrls.size > 1)) {
      const oldest = blobUrls.keys().next().value;
      if (oldest === undefined) break;
      const oldUrl = blobUrls.get(oldest);
      const oldSize = blobBytes.get(oldest) ?? 0;
      blobUrls.delete(oldest);
      blobBytes.delete(oldest);
      blobTotalBytes = Math.max(0, blobTotalBytes - oldSize);
      if (oldUrl) URL.revokeObjectURL(oldUrl);
    }
    return objUrl;
  })();
  audioPromises.set(url, p);
  try {
    return await p;
  } finally {
    audioPromises.delete(url);
  }
}

/** Is a packed audio ref already resolved, in flight, or untouched? */
export function audioPreloadStatus(url: string | null): "ready" | "pending" | "none" {
  if (!url) return "none";
  if (!VPK_REF_RE.test(url)) return "ready";
  if (lruGet(blobUrls, url) !== undefined) return "ready";
  return audioPromises.has(url) ? "pending" : "none";
}

/** Start (or join) the fetch for an audio ref. Safe to call for plain URLs. */
export function preloadAudio(url: string | null): Promise<string | null> {
  return resolveAudioUrl(url);
}

// Bounded image preload cache. The browser owns the actual image cache; this
// only remembers which URLs have finished so the reader can gate on them
// without constructing a second Image for every render.
const IMAGE_CACHE_MAX = 256;
const imageState = new Map<string, "pending" | "ready" | "error">();
const imagePending = new Map<string, Promise<boolean>>();

/** Warm an image and resolve true once it can be painted. Never throws. */
export function preloadImage(url: string | null): Promise<boolean> {
  if (!url) return Promise.resolve(false);
  const state = imageState.get(url);
  if (state === "ready") return Promise.resolve(true);
  if (state === "error") return Promise.resolve(false);
  const inflight = imagePending.get(url);
  if (inflight) return inflight;
  if (typeof Image === "undefined") return Promise.resolve(false);
  const p = new Promise<boolean>((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  }).then((ok) => {
    imageState.set(url, ok ? "ready" : "error");
    imagePending.delete(url);
    while (imageState.size > IMAGE_CACHE_MAX) {
      const oldest = imageState.keys().next().value;
      if (oldest === undefined) break;
      imageState.delete(oldest);
    }
    return ok;
  });
  imagePending.set(url, p);
  return p;
}

export function clearAudioPackCache(): void {
  vpkPromises.clear();
  vpkBuffers.clear();
  audioPromises.clear();
  for (const u of blobUrls.values()) URL.revokeObjectURL(u);
  blobUrls.clear();
  blobBytes.clear();
  blobTotalBytes = 0;
}

