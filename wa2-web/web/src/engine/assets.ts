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

export async function loadManifest(url: string): Promise<AssetManifest | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    manifest = (await res.json()) as AssetManifest;
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
  // Engine cues use .AMP names; extracted web audio keeps the stem.
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

export function movieUrl(id: string): string | null {
  return lookup(manifest?.movies, id) ?? lookup(manifest?.movies, `${id}.mp4`);
}

export function hasAssets(): boolean {
  return manifest !== null;
}
