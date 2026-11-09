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
