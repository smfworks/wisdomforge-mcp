/**
 * Drop configured words from catalog text and search-index tokens.
 * Ingest calls these helpers before it writes data/. Run this file directly
 * to apply the same filter to the files already in data/.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SearchIndexFile } from "../src/types.js";

export const DEFAULT_BLOCKED_TERMS = ["nvidia"];

export function blockedTermsPath(root = process.cwd()): string {
  return join(root, "config", "blocked-terms.json");
}

export function normalizeTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const term of terms) {
    const clean = term.trim().toLowerCase();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    normalized.push(clean);
  }
  return normalized;
}

export function loadBlockedTerms(root = process.cwd()): string[] {
  const path = blockedTermsPath(root);
  if (!existsSync(path)) return [...DEFAULT_BLOCKED_TERMS];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read ${path}: ${message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((term) => typeof term !== "string")) {
    throw new Error(`${path} must be a JSON array of strings`);
  }
  return normalizeTerms(parsed);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsTerm(text: string, terms: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

/** Drop each word that contains a blocked term. Other text stays. */
export function stripBlockedTerms(text: string, terms: readonly string[]): string {
  const normalized = normalizeTerms(terms);
  if (!text || normalized.length === 0 || !containsTerm(text, normalized)) return text;
  const word = new RegExp(
    `[A-Za-z0-9'’_-]*(?:${normalized.map(escapeRegex).join("|")})[A-Za-z0-9'’_-]*`,
    "gi",
  );
  let next = text.replace(word, "");
  for (const term of normalized) {
    if (next.toLowerCase().includes(term)) {
      next = next.replace(new RegExp(escapeRegex(term), "gi"), "");
    }
  }
  next = next.replace(/[ \t]{2,}/g, " ");
  next = next.replace(/[ \t]+([.,;:!?])/g, "$1");
  next = next.replace(/^[ \t]+|[ \t]+$/g, "");
  return next;
}

function tokenBlocked(token: string, terms: readonly string[]): boolean {
  const lower = token.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

/**
 * Remove blocked tokens from the inverted index and from document strings.
 * Document length loses the term frequency of each removed posting.
 */
export function filterSearchIndex(index: SearchIndexFile, terms: readonly string[]): SearchIndexFile {
  const normalized = normalizeTerms(terms);
  const documents = index.documents.map((doc) => ({
    ...doc,
    path: stripBlockedTerms(doc.path, normalized),
    figure: stripBlockedTerms(doc.figure, normalized),
    file: stripBlockedTerms(doc.file, normalized),
    title: stripBlockedTerms(doc.title, normalized),
  }));
  const deltas = new Map<number, number>();
  const entries: SearchIndexFile["index"] = [];
  for (const entry of index.index) {
    if (!tokenBlocked(entry.t, normalized)) {
      entries.push(entry);
      continue;
    }
    for (let i = 0; i + 1 < entry.p.length; i += 2) {
      const docId = entry.p[i];
      const tf = entry.p[i + 1];
      if (docId === undefined || tf === undefined) continue;
      deltas.set(docId, (deltas.get(docId) ?? 0) + tf);
    }
  }
  for (const [docId, delta] of deltas) {
    const doc = documents[docId] ?? documents.find((candidate) => candidate.id === docId);
    if (!doc) continue;
    doc.len = Math.max(0, doc.len - delta);
  }
  return {
    version: index.version,
    built: index.built,
    docCount: index.docCount,
    documents,
    index: entries,
  };
}

export function filterJsonStrings<T>(value: T, terms: readonly string[]): T {
  const normalized = normalizeTerms(terms);
  return walk(value, normalized) as T;
}

function walk(value: unknown, terms: readonly string[]): unknown {
  if (typeof value === "string") return stripBlockedTerms(value, terms);
  if (Array.isArray(value)) return value.map((entry) => walk(entry, terms));
  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) next[key] = walk(entry, terms);
    return next;
  }
  return value;
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) files.push(...walkFiles(path));
    else if (info.isFile()) files.push(path);
  }
  return files;
}

/** Rewrite data/ in place. Returns the files that changed. */
export function applyBlockedTermsToData(root = process.cwd()): string[] {
  const terms = loadBlockedTerms(root);
  const changed: string[] = [];
  for (const file of walkFiles(join(root, "data"))) {
    const original = readFileSync(file, "utf8");
    if (!file.endsWith(".json")) {
      const filtered = stripBlockedTerms(original, terms);
      if (filtered === original) continue;
      writeFileSync(file, filtered);
      changed.push(file);
      continue;
    }
    const parsed = JSON.parse(original) as unknown;
    const filtered = basename(file) === "search-index.json"
      ? filterSearchIndex(parsed as SearchIndexFile, terms)
      : filterJsonStrings(parsed, terms);
    if (JSON.stringify(parsed) === JSON.stringify(filtered)) continue;
    const suffix = original.endsWith("\n") ? "\n" : "";
    writeFileSync(file, `${JSON.stringify(filtered)}${suffix}`);
    changed.push(file);
  }
  return changed;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun()) {
  try {
    const changed = applyBlockedTermsToData();
    process.stdout.write(
      changed.length === 0
        ? "blocked terms: data already clean\n"
        : `blocked terms: updated ${changed.join(", ")}\n`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
