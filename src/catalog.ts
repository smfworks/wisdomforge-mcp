import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BandId,
  CatalogFile,
  CatalogItem,
  Course,
  ItemType,
  SearchIndexFile,
  SubjectId,
} from "./types.js";

let catalogCache: CatalogFile | null = null;
let indexCache: SearchIndexFile | null = null;
let itemCache: Map<string, CatalogItem> | null = null;
let pathCache: Map<string, CatalogItem> | null = null;
let courseCache: Course[] | null = null;

export function dataDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "data"),
    join(here, "..", "data"),
    join(here, "..", "..", "data"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "catalog.json"))) return candidate;
  }
  throw new Error(
    "data/catalog.json not found. Run npm run ingest from the wisdomforge-mcp repo.",
  );
}

export function loadCatalog(): CatalogFile {
  if (!catalogCache) {
    const raw = readFileSync(join(dataDir(), "catalog.json"), "utf8");
    catalogCache = JSON.parse(raw) as CatalogFile;
  }
  return catalogCache;
}

export function loadSearchIndex(): SearchIndexFile {
  if (!indexCache) {
    const raw = readFileSync(join(dataDir(), "search-index.json"), "utf8");
    indexCache = JSON.parse(raw) as SearchIndexFile;
  }
  return indexCache;
}

export function contentVersion() {
  return loadCatalog().contentVersion;
}

export function items(): CatalogItem[] {
  return loadCatalog().items;
}

export function itemById(id: string): CatalogItem | undefined {
  if (!itemCache) {
    itemCache = new Map(items().map((item) => [item.id, item]));
  }
  return itemCache.get(id);
}

export function itemByIndexPath(path: string): CatalogItem | undefined {
  if (!pathCache) {
    pathCache = new Map();
    for (const item of items()) {
      if (item.indexPath) pathCache.set(item.indexPath, item);
    }
  }
  return pathCache.get(path);
}

export function itemsByType(type: ItemType): CatalogItem[] {
  return items().filter((item) => item.type === type);
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function courses(): Course[] {
  if (courseCache) return courseCache;
  const catalog = loadCatalog();
  const built: Course[] = [];
  const unitByTitle = new Map(catalog.units.map((unit) => [unit.title, unit]));
  const groups = new Map<string, CatalogItem[]>();

  for (const item of catalog.items) {
    if (item.type !== "lesson" || !item.band || !item.unit) continue;
    const key = `${item.band}\0${item.subject ?? ""}\0${item.unit}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  for (const lessons of groups.values()) {
    lessons.sort(
      (a, b) =>
        (a.number ?? 0) - (b.number ?? 0) || a.id.localeCompare(b.id),
    );
    const first = lessons[0];
    if (!first?.band || !first.unit) continue;
    const unit = unitByTitle.get(first.unit);
    const subject = (first.subject ?? unit?.subject ?? null) as SubjectId | null;
    const id = unit
      ? `course:unit:${unit.id}:${first.band}`
      : `course:track:${first.band}:${subject ?? "general"}:${slugify(first.unit)}`;
    built.push({
      id,
      kind: "track",
      title: first.unit,
      band: first.band,
      subject,
      summary: unit?.blurb ?? first.summary,
      weeks: unit?.weeks,
      status: unit?.status,
      itemId: first.id,
      url: first.url,
      entries: lessons.map((lesson, index) => ({
        order: lesson.number ?? index + 1,
        title: lesson.title,
        itemId: lesson.id,
      })),
    });
  }

  for (const item of catalog.items) {
    if (item.type !== "book") continue;
    const slug = item.id.startsWith("book:") ? item.id.slice("book:".length) : item.id;
    built.push({
      id: `course:book:${slug}`,
      kind: "book",
      title: item.title,
      band: item.band,
      subject: item.subject,
      summary: item.summary,
      itemId: item.id,
      url: item.url,
      entries: item.chapters.map((chapter) => ({
        order: chapter.number,
        title: chapter.title,
        itemId: item.id,
        chapterNumber: chapter.number,
      })),
    });
  }

  built.sort(
    (a, b) =>
      a.title.localeCompare(b.title) ||
      (a.band ?? "").localeCompare(b.band ?? "") ||
      a.id.localeCompare(b.id),
  );
  courseCache = built;
  return built;
}

export function courseById(id: string): Course | undefined {
  return courses().find((course) => course.id === id);
}

export function matchesBand(item: CatalogItem, band: BandId): boolean {
  if (item.band === band) return true;
  return item.bands.includes(band);
}

const TYPE_RANK: Record<ItemType, number> = {
  lesson: 0,
  book: 1,
  booklet: 2,
  audio: 3,
  demo: 4,
  index_doc: 5,
};

export function compareItems(a: CatalogItem, b: CatalogItem): number {
  const byType = TYPE_RANK[a.type] - TYPE_RANK[b.type];
  if (byType !== 0) return byType;
  const byNumber = (a.number ?? 0) - (b.number ?? 0);
  if (a.type === "lesson" && b.type === "lesson" && byNumber !== 0) return byNumber;
  const byTitle = a.title.localeCompare(b.title);
  if (byTitle !== 0) return byTitle;
  return a.id.localeCompare(b.id);
}
