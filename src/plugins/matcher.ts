/**
 * Template matching: an open-source stand-in for nut.js' template-matcher / nl-matcher plugins.
 *
 * Score = 1 - (mean absolute RGB difference / 255) over the template's opaque pixels (transparent pixels are
 * ignored, like an alpha mask). The scan is exact but fast: pixels are visited samples-first and a position is
 * abandoned as soon as the running difference exceeds the budget implied by `confidence`. Because the running
 * sum over a subset can never exceed the sum over the whole template, this pruning never loses a real match.
 * Flat, featureless templates match everywhere and are slow: give it something with detail.
 */
export interface Bitmap {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

export interface Match {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  /** Scale of the template that matched (1 = as given). */
  scale?: number;
}

export interface MatchOptions {
  /** 0..1, default 0.95. */
  confidence?: number;
  maxResults?: number;
}

/**
 *
 * @param hay - Bitmap to search.
 * @param needle - Template bitmap.
 * @param confidence - Minimum match confidence from 0 to 1.
 * @returns Raw template matches.
 */
function scan(hay: Bitmap, needle: Bitmap, confidence: number): Match[] {
  const { width: hw, height: hh, data: h } = hay;
  const { width: nw, height: nh, data: nd } = needle;
  if (nw < 1 || nh < 1 || nw > hw || nh > hh) return [];

  const opaque: number[] = [];
  for (let i = 0; i < nw * nh; i++) if ((nd[i * 4 + 3] as number) >= 128) opaque.push(i);
  if (opaque.length === 0) return [];

  // samples first (evenly spread), then the rest: early rejection happens within the first few dozen reads
  const stride = Math.max(1, Math.floor(opaque.length / 48));
  const order = [...opaque.filter((_, k) => k % stride === 0), ...opaque.filter((_, k) => k % stride !== 0)];
  const nOff = new Int32Array(order.length);
  const hOff = new Int32Array(order.length);
  order.forEach((i, k) => {
    // eslint-disable-next-line security/detect-object-injection
    nOff[k] = i * 4;
    // eslint-disable-next-line security/detect-object-injection
    hOff[k] = (Math.floor(i / nw) * hw + (i % nw)) * 4;
  });
  const budget = (1 - confidence) * 255 * 3 * order.length;
  const total = 255 * 3 * order.length;

  const out: Match[] = [];
  for (let y = 0; y <= hh - nh; y++) {
    for (let x = 0; x <= hw - nw; x++) {
      const base = (y * hw + x) * 4;
      let diff = 0;
      let k = 0;
      for (; k < order.length; k++) {
        // eslint-disable-next-line security/detect-object-injection
        const hi = base + (hOff[k] as number);
        // eslint-disable-next-line security/detect-object-injection
        const ni = nOff[k] as number;
        // eslint-disable-next-line security/detect-object-injection
        diff += Math.abs((h[hi] as number) - (nd[ni] as number)) + Math.abs((h[hi + 1] as number) - (nd[ni + 1] as number)) + Math.abs((h[hi + 2] as number) - (nd[ni + 2] as number));
        if (diff > budget) break;
      }
      if (k === order.length) out.push({ x, y, width: nw, height: nh, confidence: 1 - diff / total });
    }
  }
  return out;
}

/**
 * Keep the best match of every cluster (matches whose centres are closer than half the template).
 * @param matches - Candidate matches.
 * @param limit - Maximum matches to return.
 * @returns The best match per cluster.
 */
function suppress(matches: Match[], limit: number): Match[] {
  const kept: Match[] = [];
  for (const m of [...matches].sort((a, b) => b.confidence - a.confidence)) {
    const near = kept.some((k) => Math.abs(k.x - m.x) < Math.max(k.width, m.width) / 2 && Math.abs(k.y - m.y) < Math.max(k.height, m.height) / 2);
    if (!near) kept.push(m);
    if (kept.length >= limit) break;
  }
  return kept;
}

/**
 * Find `needle` in `hay`. Best match first.
 * @param hay - Bitmap to search.
 * @param needle - Template bitmap.
 * @param opts - Options to use.
 * @returns Matches ordered by confidence.
 */
export function findTemplate(hay: Bitmap, needle: Bitmap, opts: MatchOptions = {}): Match[] {
  return suppress(scan(hay, needle, opts.confidence ?? 0.95), opts.maxResults ?? 1);
}

/**
 * Search several pre-scaled versions of a template and merge the results.
 * @param hay - Bitmap to search.
 * @param needles - Scaled template bitmaps.
 * @param opts - Options to use.
 * @returns Matches ordered by confidence.
 */
export function findTemplateScaled(hay: Bitmap, needles: { scale: number; bitmap: Bitmap }[], opts: MatchOptions = {}): Match[] {
  const all = needles.flatMap(({ scale, bitmap }) => scan(hay, bitmap, opts.confidence ?? 0.95).map((m) => ({ ...m, scale })));
  return suppress(all, opts.maxResults ?? 1);
}
