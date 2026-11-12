import { stem, WEAK_LABEL_TERMS } from './text.js';

// Groups issues that describe the same underlying problem, across repositories.
//
// Pipeline (deterministic for a given corpus and options):
//   1. stem each issue's bag of words; remember the commonest real word per stem
//   2. drop per-repository boilerplate (issue-template headings that appear in >35% of a repo's issues)
//   3. TF-IDF with sublinear tf, L2-normalised
//   4. cosine similarity matrix built from an inverted index (only shared terms cost work)
//   5. average-linkage agglomerative clustering via the NN-chain algorithm, O(n^2)
//   6. cut the dendrogram at `threshold` similarity, keep groups of >= minSize
//   7. label with class-based TF-IDF, pick a medoid, score as a developer opportunity

export const DEFAULTS = Object.freeze({
  threshold: 0.24, // minimum average-linkage cosine similarity inside a cluster
  minSize: 3,
  maxDocs: 3000, // two dense n^2 float32 matrices: 3000 docs = 72 MB
  boilerplateShare: 0.35,
  recentDays: 180,
  weights: Object.freeze({ volume: 0.3, spread: 0.25, engagement: 0.2, unresolved: 0.15, momentum: 0.1 }),
});

/**
 * @param {{id:number, repository:string, state:string, comments:number, reactions:number,
 *          created_at:string, terms:Record<string,number>}[]} corpus
 * @param {Partial<typeof DEFAULTS> & {now?: string}} options
 */
export function clusterIssues(corpus, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const now = Date.parse(opt.now ?? new Date().toISOString());
  const docs = [...corpus].sort((a, b) => a.id - b.id);
  if (docs.length > opt.maxDocs) {
    throw new RangeError(`Corpus has ${docs.length} issues; the in-memory clusterer is capped at ${opt.maxDocs}.`);
  }
  const n = docs.length;
  const repoCount = new Set(docs.map((d) => d.repository)).size;
  if (n < opt.minSize) return { clusters: [], stats: { documents: n, vocabulary: 0 } };

  // 1. stem + surface forms
  const surfaces = new Map();
  const stemmed = docs.map((d) => {
    const m = new Map();
    for (const [word, w] of Object.entries(d.terms)) {
      if (!Number.isFinite(w) || w <= 0) continue; // defensive: corrupt or legacy rows
      const s = stem(word);
      m.set(s, (m.get(s) ?? 0) + w);
      const forms = surfaces.get(s) ?? new Map();
      forms.set(word, (forms.get(word) ?? 0) + w);
      surfaces.set(s, forms);
    }
    return m;
  });

  // 2. repository boilerplate
  const byRepo = new Map();
  docs.forEach((d, i) => byRepo.set(d.repository, [...(byRepo.get(d.repository) ?? []), i]));
  for (const idxs of byRepo.values()) {
    if (idxs.length < 20) continue;
    const df = new Map();
    for (const i of idxs) for (const s of stemmed[i].keys()) df.set(s, (df.get(s) ?? 0) + 1);
    const drop = [...df].filter(([, c]) => c / idxs.length > opt.boilerplateShare).map(([s]) => s);
    for (const i of idxs) for (const s of drop) stemmed[i].delete(s);
  }

  // 3. TF-IDF vocabulary
  const df = new Map();
  for (const m of stemmed) for (const s of m.keys()) df.set(s, (df.get(s) ?? 0) + 1);
  const vocab = new Map();
  for (const [s, c] of df) if (c >= 2 && c <= 0.4 * n) vocab.set(s, vocab.size);
  const idf = new Float64Array(vocab.size);
  for (const [s, j] of vocab) idf[j] = Math.log((n + 1) / (df.get(s) + 1)) + 1;

  const vectors = stemmed.map((m) => {
    const v = new Map();
    let norm = 0;
    for (const [s, tf] of m) {
      const j = vocab.get(s);
      if (j === undefined) continue;
      const w = (1 + Math.log(tf)) * idf[j];
      v.set(j, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [j, w] of v) v.set(j, w / norm);
    return v;
  });

  // 4. similarity via inverted index
  const postings = Array.from({ length: vocab.size }, () => []);
  vectors.forEach((v, i) => {
    for (const [j, w] of v) postings[j].push(i, w);
  });
  const S = new Float32Array(n * n);
  for (const p of postings) {
    for (let a = 0; a < p.length; a += 2) {
      const ia = p[a];
      const wa = p[a + 1];
      for (let b = a + 2; b < p.length; b += 2) S[ia * n + p[b]] += wa * p[b + 1];
    }
  }
  for (let i = 0; i < n; i++) {
    S[i * n + i] = 1;
    for (let j = i + 1; j < n; j++) S[j * n + i] = S[i * n + j];
  }

  // 5 + 6. NN-chain average linkage, then cut by replaying merges in distance order
  const merges = nnChain(n, S.slice()); // nnChain overwrites rows; keep S intact for medoids
  merges.sort((a, b) => a[2] - b[2]);
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const cut = 1 - opt.threshold;
  for (const [a, b, d] of merges) {
    if (d > cut) break;
    parent[find(b)] = find(a);
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  }
  const kept = [...groups.values()].filter((g) => g.length >= opt.minSize);

  // 7. labels (class-based TF-IDF across clusters)
  const clusterTermSums = kept.map((g) => {
    const sums = new Map();
    for (const i of g) for (const [j, w] of vectors[i]) sums.set(j, (sums.get(j) ?? 0) + w);
    return sums;
  });
  const clustersWithTerm = new Map();
  for (const sums of clusterTermSums) for (const j of sums.keys()) clustersWithTerm.set(j, (clustersWithTerm.get(j) ?? 0) + 1);
  const stemOf = [];
  for (const [s, j] of vocab) stemOf[j] = s;
  const display = (s) => [...surfaces.get(s)].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];

  const C = kept.length;
  const raw = kept.map((g, k) => {
    // medoid: the member most similar to all others
    let medoid = g[0];
    let best = -1;
    for (const i of g) {
      let sum = 0;
      for (const j of g) sum += S[i * n + j];
      if (sum > best) (best = sum), (medoid = i);
    }
    const members = g
      .map((i) => ({ issue_id: docs[i].id, similarity: round(S[i * n + medoid], 4) }))
      .sort((a, b) => b.similarity - a.similarity || a.issue_id - b.issue_id);
    const others = members.filter((m) => m.issue_id !== docs[medoid].id);
    const cohesion = others.reduce((s, m) => s + m.similarity, 0) / Math.max(1, others.length);

    const ranked = [...clusterTermSums[k]]
      .map(([j, w]) => [j, (w / g.length) * Math.log(1 + C / clustersWithTerm.get(j))])
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, 6)
      .map(([j]) => display(stemOf[j]));
    const terms = ranked.slice(0, 5);
    const lead = terms.findIndex((t) => !WEAK_LABEL_TERMS.has(stem(t)));
    const labelTerms = lead > 0 ? [terms[lead], ...terms.filter((_, i) => i !== lead)] : terms;

    const items = g.map((i) => docs[i]);
    const dates = items.map((d) => d.created_at).sort();
    const recentCutoff = now - opt.recentDays * 86_400_000;
    return {
      id: `cl_${docs[medoid].id.toString(36)}`,
      label: labelTerms.slice(0, 3).join(' · '),
      terms,
      size: g.length,
      repo_count: new Set(items.map((d) => d.repository)).size,
      open_count: items.filter((d) => d.state === 'open').length,
      engagement: items.reduce((s, d) => s + (d.comments ?? 0) + (d.reactions ?? 0), 0),
      recent_share: items.filter((d) => Date.parse(d.created_at) >= recentCutoff).length / g.length,
      cohesion: round(cohesion, 4),
      medoid_issue_id: docs[medoid].id,
      first_seen: dates[0],
      last_seen: dates[dates.length - 1],
      members,
    };
  });

  // Opportunity score: weighted, normalised components, all exposed so the number is explainable.
  const maxVol = Math.max(1, ...raw.map((c) => Math.log2(1 + c.size)));
  const maxEng = Math.max(1, ...raw.map((c) => Math.log1p(c.engagement)));
  const W = opt.weights;
  const clusters = raw
    .map(({ recent_share, ...c }) => {
      const components = {
        volume: round(Math.log2(1 + c.size) / maxVol, 4),
        spread: repoCount > 1 ? round((c.repo_count - 1) / (repoCount - 1), 4) : 0,
        engagement: round(Math.log1p(c.engagement) / maxEng, 4),
        unresolved: round(c.open_count / c.size, 4),
        momentum: round(recent_share, 4),
      };
      const score = Object.entries(W).reduce((s, [k, w]) => s + w * components[k], 0);
      return { ...c, score: round(score * 100, 1), score_components: components };
    })
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));

  return {
    clusters,
    stats: {
      documents: n,
      vocabulary: vocab.size,
      clustered_documents: clusters.reduce((s, c) => s + c.size, 0),
    },
  };
}

/**
 * Nearest-neighbour chain for average linkage on a similarity matrix.
 * Mutates S (rows of merged clusters are overwritten via Lance-Williams).
 * @returns {[number, number, number][]} merges as [a, b, distance]
 */
export function nnChain(n, S) {
  const active = new Uint8Array(n).fill(1);
  const size = new Uint32Array(n).fill(1);
  const merges = [];
  const chain = [];
  let remaining = n;
  let scan = 0;
  while (remaining > 1) {
    if (chain.length === 0) {
      while (!active[scan]) scan++;
      chain.push(scan);
    }
    const a = chain[chain.length - 1];
    const prev = chain.length > 1 ? chain[chain.length - 2] : -1;
    let b = -1;
    let bestSim = -Infinity;
    const row = a * n;
    for (let k = 0; k < n; k++) {
      if (k === a || !active[k]) continue;
      const s = S[row + k];
      if (s > bestSim || (s === bestSim && k === prev)) {
        bestSim = s;
        b = k;
      }
    }
    if (b === -1) throw new Error('nnChain: no active neighbour (non-finite similarity?)');
    if (b === prev) {
      chain.length -= 2;
      merges.push([a, b, 1 - bestSim]);
      const sa = size[a];
      const sb = size[b];
      for (let k = 0; k < n; k++) {
        if (!active[k] || k === a || k === b) continue;
        const v = (sa * S[a * n + k] + sb * S[b * n + k]) / (sa + sb);
        S[a * n + k] = v;
        S[k * n + a] = v;
      }
      active[b] = 0;
      size[a] = sa + sb;
      remaining--;
    } else {
      chain.push(b);
    }
  }
  return merges;
}

function round(x, d) {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
