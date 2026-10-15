/**
 * BM25 tokenizer and ranking ported from smfworks/wisdomforge
 * src/app/api/search/route.ts at commit 565aa88
 * (MIT, Copyright SMF Works).
 * https://github.com/smfworks/wisdomforge/blob/565aa88/src/app/api/search/route.ts
 *
 * Query tokens must stay identical or the shipped postings will not hit.
 * The site build script scripts/build-search-index.mjs uses the same tokenizer.
 */
import { loadSearchIndex } from "./catalog.js";
import type { CatalogItem, SearchIndexFile, SearchPostingEntry } from "./types.js";

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for",
  "from", "has", "have", "he", "her", "his", "i", "in", "is", "it",
  "its", "of", "on", "or", "she", "that", "the", "their", "they",
  "this", "to", "was", "were", "will", "with", "you", "your",
  "we", "our", "us", "them", "him", "me", "my", "who", "whom",
  "which", "what", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some", "such",
  "no", "nor", "not", "only", "own", "same", "so", "than", "too",
  "very", "can", "did", "do", "does", "had", "been", "being",
  "am", "if", "into", "through", "about", "before", "after",
  "again", "further", "then", "once", "here", "there", "up",
  "down", "out", "off", "over", "under", "also", "may", "might",
  "must", "should", "would", "could", "shall", "will", "just",
]);

export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length <= 3) return w;
  if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ies")) w = w.slice(0, -2);
  else if (w.endsWith("ss")) {
    /* keep */
  } else if (w.endsWith("s")) w = w.slice(0, -1);
  if (w.endsWith("eed")) {
    if (w.length > 4) w = w.slice(0, -1);
  } else if (w.endsWith("ed") && w.length > 4) {
    w = w.slice(0, -2);
  } else if (w.endsWith("ing") && w.length > 5) {
    w = w.slice(0, -3);
  }
  const suffixes2 = [
    "ational", "tional", "izer", "ization", "fulness", "ousness",
    "iveness", "biliti", "lessli", "entli", "ation", "alism",
    "aliti", "iviti", "ement", "ation",
  ];
  for (const suf of suffixes2) {
    if (w.endsWith(suf) && w.length > suf.length + 2) {
      w = w.slice(0, -suf.length);
      break;
    }
  }
  const suffixes3 = ["al", "ance", "ence", "er", "ic", "able", "ible",
    "ant", "ement", "ment", "ness", "ate", "iti", "ous"];
  for (const suf of suffixes3) {
    if (w.endsWith(suf) && w.length > suf.length + 3) {
      w = w.slice(0, -suf.length);
      break;
    }
  }
  return w;
}

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const matches = text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*[a-z0-9]|[a-z0-9]/g);
  if (!matches) return tokens;
  for (const raw of matches) {
    if (raw.length < 2) continue;
    if (STOP_WORDS.has(raw)) continue;
    if (/^\d+$/.test(raw) && raw.length < 3) continue;
    const s = stem(raw);
    if (s.length < 2) continue;
    if (STOP_WORDS.has(s)) continue;
    tokens.push(s);
  }
  return tokens;
}

export interface IndexHit {
  docId: number;
  path: string;
  figure: string;
  file: string;
  title: string;
  score: number;
}

interface PreparedIndex {
  file: SearchIndexFile;
  byToken: Map<string, SearchPostingEntry>;
  avgLen: number;
}

let prepared: PreparedIndex | null = null;

function prepareIndex(): PreparedIndex {
  if (prepared) return prepared;
  const file = loadSearchIndex();
  const byToken = new Map<string, SearchPostingEntry>();
  for (const entry of file.index) byToken.set(entry.t, entry);
  const avgLen =
    file.documents.reduce((sum, doc) => sum + doc.len, 0) /
    Math.max(1, file.docCount);
  prepared = { file, byToken, avgLen };
  return prepared;
}

/** BM25 over the shipped inverted index. Same formula as the site route. */
export function searchIndex(query: string, limit: number): IndexHit[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  const { file, byToken, avgLen } = prepareIndex();
  const scores = new Map<number, number>();
  const seen = new Set<string>();

  for (const token of queryTokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    const entry = byToken.get(token);
    if (!entry) continue;
    for (let i = 0; i < entry.p.length; i += 2) {
      const docId = entry.p[i];
      const tf = entry.p[i + 1];
      if (docId === undefined || tf === undefined) continue;
      const doc = file.documents[docId];
      if (!doc) continue;
      const k1 = 1.2;
      const b = 0.75;
      const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.len / avgLen)));
      const score = entry.idf * tfNorm;
      scores.set(docId, (scores.get(docId) ?? 0) + score);
    }
  }

  return [...scores.entries()]
    .map(([docId, score]) => {
      const doc = file.documents[docId];
      return {
        docId,
        path: doc?.path ?? "",
        figure: doc?.figure ?? "",
        file: doc?.file ?? "",
        title: doc?.title ?? "",
        score: Math.round(score * 1000) / 1000,
      };
    })
    .filter((hit) => hit.path.length > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

interface LexicalDoc {
  item: CatalogItem;
  titleTokens: Set<string>;
  bodyTokens: Set<string>;
}

let lexicalCache: LexicalDoc[] | null = null;

export function prepareLexical(items: CatalogItem[]): LexicalDoc[] {
  if (lexicalCache && lexicalCache.length === items.length) return lexicalCache;
  lexicalCache = items
    .filter((item) => item.type !== "index_doc")
    .map((item) => {
      const body = [
        item.summary,
        item.figure ?? "",
        (item.figures ?? []).join(" "),
        item.subject ?? "",
        item.unit ?? "",
        item.excerpt,
        item.chapters
          .map((chapter) => `${chapter.title} ${(chapter.text ?? "").slice(0, 500)}`)
          .join("\n"),
      ].join("\n");
      return {
        item,
        titleTokens: new Set(tokenize(item.title)),
        bodyTokens: new Set(tokenize(body)),
      };
    });
  return lexicalCache;
}

export function lexicalScore(doc: LexicalDoc, queryTokens: string[]): number {
  const unique = [...new Set(queryTokens)];
  if (unique.length === 0) return 0;
  let score = 0;
  let matched = 0;
  for (const token of unique) {
    let hit = false;
    if (doc.titleTokens.has(token)) {
      score += 8;
      hit = true;
    }
    if (doc.bodyTokens.has(token)) {
      score += 2;
      hit = true;
    }
    if (hit) matched += 1;
  }
  if (matched === 0) return 0;
  score *= 1 + matched / unique.length;
  return Math.round(score * 1000) / 1000;
}

export function snippetFor(item: CatalogItem, query: string): string {
  const hay = [item.title, item.summary, item.excerpt].filter(Boolean).join(" — ");
  const needle = query.trim().split(/\s+/).find((part) => part.length > 2) ?? query.trim();
  const idx = needle ? hay.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (idx < 0) return hay.slice(0, 220);
  const start = Math.max(0, idx - 70);
  const end = Math.min(hay.length, idx + 150);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < hay.length ? "…" : "";
  return `${prefix}${hay.slice(start, end).trim()}${suffix}`;
}
