/**
 * Fail if any term in config/blocked-terms.json appears under data/.
 * Match is case-insensitive. A missing config file uses the default list.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadBlockedTerms } from "./blocked-terms.js";

export interface TermHit {
  file: string;
  line: number;
  term: string;
}

function walkFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) files.push(...walkFiles(path));
    else if (info.isFile()) files.push(path);
  }
  return files;
}

export function findBlockedHits(root = process.cwd()): TermHit[] {
  const terms = loadBlockedTerms(root);
  const dataDir = join(root, "data");
  if (!existsSync(dataDir)) {
    throw new Error(`data directory not found: ${dataDir}`);
  }
  const hits: TermHit[] = [];
  for (const file of walkFiles(dataDir)) {
    const text = readFileSync(file).toString("utf8");
    const lower = text.toLowerCase();
    for (const term of terms) {
      let from = 0;
      while (from < lower.length) {
        const index = lower.indexOf(term, from);
        if (index < 0) break;
        const line = text.slice(0, index).split("\n").length;
        hits.push({ file: relative(root, file) || file, line, term });
        from = index + term.length;
      }
    }
  }
  return hits;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun()) {
  try {
    const hits = findBlockedHits();
    if (hits.length > 0) {
      for (const hit of hits) {
        process.stderr.write(`${hit.file}:${hit.line}: blocked term "${hit.term}"\n`);
      }
      process.stderr.write(`check:terms failed (${hits.length} hit${hits.length === 1 ? "" : "s"})\n`);
      process.exit(1);
    }
    const count = walkFiles(join(process.cwd(), "data")).length;
    process.stdout.write(`check:terms ok (${count} file${count === 1 ? "" : "s"})\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
