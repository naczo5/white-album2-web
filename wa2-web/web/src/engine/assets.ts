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
      manifest.voice, manifest.movies]) {
      for (const [k, v] of Object.entries(table ?? {})) {
        if (!/^(https?:|data:|blob:|\/)/.test(v)) table[k] = base + v;
      }
    }
    voiceIdx = new Map();
    for (const [key, val] of Object.entries(manifest.voice ?? {})) {
      const m = /^(ic\/)?(\d+_\d+)/.exec(key);
      if (!m) continue;
      const id = `${m[1] ?? ""}${m[2]}`;
      const arr = voiceIdx.get(id) ?? [];
      arr.push(val);
      voiceIdx.set(id, arr);
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
 * BGM track file for a .bnr cue. Engine plays BGM_%03d: a loop pair
 * (_A intro + _B body) or a solo file. Prefers the loop body when both
 * exist; intro chapter checks ic/-namespaced keys first.
 */
export function bgmTrackUrl(track: number, chapter?: string): string | null {
  const id = `BGM_${String(track).padStart(3, "0")}`;
  const cands = chapter === "intro" ? [`ic/${id}_B.OGG`, `ic/${id}_A.OGG`, `ic/${id}.OGG`] : [];
  cands.push(`${id}_B.OGG`, `${id}_A.OGG`, `${id}.OGG`);
  for (const c of cands) {
    const hit = lookup(manifest?.bgm, c);
    if (hit) return hit;
  }
  return null;
}

/** Sound-effect file by engine id (SE_%04d). Chapter-namespaced like BGM. */
export function seUrl(id: number | string, chapter?: string): string | null {
  const base = typeof id === "number" ? `SE_${String(id).padStart(4, "0")}` : id;
  const cands = chapter === "intro" ? [`ic/${base}.WAV`, `ic/${base}.wav`] : [];
  cands.push(`${base}.WAV`, `${base}.wav`, `${base}.ogg`, `${base}.OGG`);
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

/**
 * Voice clip for a scenario line. Engine files are named
 * `{script}_{token:04d}_{take}.OGG` (names XOR-0xFF obfuscated in the
 * archive); the token is the raw comma-token index, recorded on every
 * say/narrate event as `tok`. Intro lines live under `ic/`.
 */
export function voiceUrl(script: string, tok: number | undefined, chapter?: string): string | null {
  if (tok === undefined || !voiceIdx) return null;
  const line = String(tok).padStart(4, "0");
  if (chapter === "intro") {
    const ic = voiceIdx.get(`ic/${script}_${line}`);
    if (ic?.length) return ic[0];
  }
  const main = voiceIdx.get(`${script}_${line}`);
  return main?.length ? main[0] : null;
}

export function hasAssets(): boolean {
  return manifest !== null;
}
