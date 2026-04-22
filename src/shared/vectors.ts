// Shared vector helpers for similarity scoring and recency weighting.
export function cosineSimilarity(a: number[] | undefined, b: number[] | undefined): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    const ai = +(a[i] ?? 0) || 0;
    const bi = +(b[i] ?? 0) || 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function recencyWeight(timestamp: number | undefined): number {
  const WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days decay
  const ts = Number.isFinite(timestamp) ? (timestamp as number) : Date.now();
  const age = Math.max(0, Date.now() - ts);
  return Math.exp(-age / WINDOW_MS);
}

export function computeCentroid(vectors: Array<{ embedding?: number[] }> | undefined): number[] | null {
  if (!vectors || vectors.length === 0) return null;
  const first = vectors.find((v) => Array.isArray(v?.embedding)) as { embedding?: number[] } | undefined;
  const dim = first?.embedding?.length || 0;
  if (!dim) return null;
  const acc = new Array(dim).fill(0);
  let count = 0;
  for (const item of vectors) {
    const emb = Array.isArray(item?.embedding) ? (item.embedding as number[]) : null;
    if (!emb || emb.length !== dim) continue;
    const safeEmb = emb as number[];
    for (let i = 0; i < dim; i += 1) {
      acc[i] += +(safeEmb[i] ?? 0) || 0;
    }
    count += 1;
  }
  if (count === 0) return null;
  for (let i = 0; i < dim; i += 1) acc[i] /= count;
  return acc;
}
