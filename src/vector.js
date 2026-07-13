const stopWords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "with",
  "music", "borobeya", "release", "released"
]);

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !stopWords.has(token));
}

function documentText(item) {
  return [
    item.title,
    item.artist,
    item.type,
    item.isrc,
    item.status,
    item.notes,
    ...(item.tags || []),
    item.rights && item.rights.writer,
    item.rights && item.rights.publisher,
    item.rights && item.rights.ascapStatus,
    ...(item.media || []).map((m) => `${m.kind} ${m.label} ${m.url}`)
  ].filter(Boolean).join(" ");
}

function buildIndex(items) {
  const docs = items.map((item) => {
    const counts = new Map();
    for (const token of tokenize(documentText(item))) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
    return { item, counts };
  });

  const df = new Map();
  for (const doc of docs) {
    for (const token of doc.counts.keys()) df.set(token, (df.get(token) || 0) + 1);
  }

  const totalDocs = Math.max(docs.length, 1);
  const vectors = docs.map((doc) => {
    const weights = new Map();
    let norm = 0;
    for (const [token, count] of doc.counts) {
      const idf = Math.log(1 + totalDocs / (1 + (df.get(token) || 0)));
      const weight = (1 + Math.log(count)) * idf;
      weights.set(token, weight);
      norm += weight * weight;
    }
    return { item: doc.item, weights, norm: Math.sqrt(norm) || 1 };
  });

  return { vectors, df, totalDocs };
}

function search(index, query, options = {}) {
  const limit = options.limit || 12;
  const queryCounts = new Map();
  for (const token of tokenize(query)) queryCounts.set(token, (queryCounts.get(token) || 0) + 1);
  if (queryCounts.size === 0) return [];

  const queryWeights = new Map();
  let queryNorm = 0;
  for (const [token, count] of queryCounts) {
    const idf = Math.log(1 + index.totalDocs / (1 + (index.df.get(token) || 0)));
    const weight = (1 + Math.log(count)) * idf;
    queryWeights.set(token, weight);
    queryNorm += weight * weight;
  }
  queryNorm = Math.sqrt(queryNorm) || 1;

  return index.vectors
    .map(({ item, weights, norm }) => {
      let dot = 0;
      for (const [token, weight] of queryWeights) {
        dot += weight * (weights.get(token) || 0);
      }
      return { item, score: dot / (norm * queryNorm) };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

module.exports = { tokenize, documentText, buildIndex, search };
