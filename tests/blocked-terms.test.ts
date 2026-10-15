import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyBlockedTermsToData,
  filterSearchIndex,
  loadBlockedTerms,
  stripBlockedTerms,
} from "../scripts/blocked-terms.js";
import { findBlockedHits } from "../scripts/check-blocked-terms.js";
import type { SearchIndexFile } from "../src/types.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wf-terms-"));
  roots.push(root);
  mkdirSync(join(root, "config"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "config", "blocked-terms.json"), `${JSON.stringify(["nvidia"])}\n`);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("blocked terms", () => {
  it("loads nvidia and no other default term", () => {
    expect(loadBlockedTerms()).toEqual(["nvidia"]);
    expect(loadBlockedTerms().some((term) => term === "microsoft")).toBe(false);
  });

  it("drops the blocked word and keeps the rest of the text", () => {
    expect(stripBlockedTerms("The NVIDIA chip is fast", ["nvidia"])).toBe("The chip is fast");
    expect(stripBlockedTerms("See NVIDIA.", ["NVIDIA"])).toBe("See.");
    expect(stripBlockedTerms("the nvidia' model", ["nvidia"])).toBe("the model");
    expect(stripBlockedTerms("Epictetus on control", ["nvidia"])).toBe("Epictetus on control");
  });

  it("removes a blocked search token and shortens that document", () => {
    const index: SearchIndexFile = {
      version: 1,
      built: "2020-01-01T00:00:00.000Z",
      docCount: 1,
      documents: [
        {
          id: 0,
          path: "ai-intellectual-history/2.4-deep-learning-revolution.md",
          figure: "ai-intellectual-history",
          file: "2.4-deep-learning-revolution",
          title: "NVIDIA notes",
          len: 4,
        },
      ],
      index: [
        { t: "nvidia'", p: [0, 1], idf: 7.1 },
        { t: "note", p: [0, 3], idf: 1.2 },
      ],
    };
    const filtered = filterSearchIndex(index, ["nvidia"]);
    expect(filtered.index.map((entry) => entry.t)).toEqual(["note"]);
    expect(filtered.documents[0]?.len).toBe(3);
    expect(filtered.documents[0]?.title).toBe("notes");
    expect(filtered.documents[0]?.path).toContain("2.4-deep-learning-revolution");
    expect(JSON.stringify(filtered).toLowerCase()).not.toContain("nvidia");
  });

  it("filters data files and the checker fails until they are clean", () => {
    const root = tempRoot();
    const index: SearchIndexFile = {
      version: 1,
      built: "2020-01-01T00:00:00.000Z",
      docCount: 1,
      documents: [
        { id: 0, path: "a.md", figure: "a", file: "a", title: "From AlexNet to GPT", len: 10 },
      ],
      index: [{ t: "nvidia'", p: [0, 1], idf: 3 }],
    };
    writeFileSync(join(root, "data", "search-index.json"), JSON.stringify(index));
    writeFileSync(
      join(root, "data", "catalog.json"),
      `${JSON.stringify({ title: "The NVIDIA chip", excerpt: "keep this", text: "Epictetus" })}\n`,
    );

    expect(findBlockedHits(root).length).toBeGreaterThan(0);
    const checker = join(process.cwd(), "node_modules", ".bin", "tsx");
    const script = join(process.cwd(), "scripts", "check-blocked-terms.ts");
    const failed = spawnSync(checker, [script], { cwd: root, encoding: "utf8" });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr.toLowerCase()).toContain("nvidia");

    const changed = applyBlockedTermsToData(root);
    expect(changed.length).toBe(2);
    expect(findBlockedHits(root)).toEqual([]);
    const cleaned = spawnSync(checker, [script], { cwd: root, encoding: "utf8" });
    expect(cleaned.status).toBe(0);
  });
});
