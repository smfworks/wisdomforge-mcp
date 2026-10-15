import type { BandId, CatalogItem, LearningStyle, SubjectId } from "./types.js";
import { tokenize } from "./search.js";

/**
 * Deterministic learner ranking. No model calls.
 *
 * Points:
 * - same age band: +50 (other bands are excluded)
 * - requested subject match: +30 (a different subject is excluded)
 * - each interest hit: +15, capped at +45
 * - auditory: audio item +40, any mp3 +22
 * - reading: book or booklet +28, lesson +14, pdf or epub +10
 * - visual: image +24, art subject +18, demo +8
 * - kinesthetic: lesson +26, demo +10
 * - lesson +6, book +4, booklet +3
 * - earlier lesson number: up to +4
 * Index documents are search hits, not recommendations.
 */

export function bandForAge(age: number): BandId {
  if (age <= 10) return "little";
  if (age <= 14) return "young";
  if (age <= 18) return "emerging";
  return "adult";
}

export interface ScoredItem {
  item: CatalogItem;
  score: number;
  rationale: string;
}

function interestHits(item: CatalogItem, interests: string[]): string[] {
  const hay = [
    item.title,
    item.summary,
    item.figure ?? "",
    (item.figures ?? []).join(" "),
    item.subject ?? "",
    item.unit ?? "",
    item.excerpt,
  ]
    .join(" ")
    .toLowerCase();
  const hayTokens = new Set(tokenize(hay));
  const matched: string[] = [];
  for (const interest of interests) {
    const needle = interest.trim().toLowerCase();
    if (!needle) continue;
    if (needle.length >= 3 && hay.includes(needle)) {
      matched.push(interest.trim());
      continue;
    }
    const tokens = tokenize(needle);
    if (tokens.length > 0 && tokens.every((token) => hayTokens.has(token) || hay.includes(token))) {
      matched.push(interest.trim());
    }
  }
  return matched;
}

export function scoreForLearner(
  item: CatalogItem,
  input: {
    band: BandId;
    learningStyle: LearningStyle;
    interests: string[];
    subjects?: SubjectId[];
  },
): ScoredItem | null {
  if (item.type === "index_doc") return null;
  if (item.band !== input.band) return null;
  if (input.subjects && input.subjects.length > 0) {
    if (!item.subject || !input.subjects.includes(item.subject)) return null;
  }

  let score = 50;
  const reasons = [`Matches the ${input.band} band.`];

  if (input.subjects && input.subjects.length > 0 && item.subject) {
    score += 30;
    reasons.push(`Subject is ${item.subject}.`);
  }

  const hits = interestHits(item, input.interests);
  if (hits.length > 0) {
    score += Math.min(45, hits.length * 15);
    reasons.push(`Interest overlap: ${hits.join(", ")}.`);
  }
  const title = item.title.toLowerCase();
  const titleHits = input.interests
    .map((interest) => interest.trim())
    .filter((interest) => interest.length >= 3 && title.includes(interest.toLowerCase()));
  if (titleHits.length > 0) {
    score += Math.min(24, titleHits.length * 12);
    reasons.push(`Title matches ${titleHits.join(", ")}.`);
  }

  const hasAudio = item.type === "audio" || item.media.some((media) => media.kind === "mp3");
  const hasPrint = item.media.some((media) => media.kind === "pdf" || media.kind === "epub");
  const hasImage = item.media.some((media) => media.kind === "image");

  switch (input.learningStyle) {
    case "auditory":
      if (item.type === "audio") {
        score += 40;
        reasons.push("Audio track for an auditory learner.");
      } else if (hasAudio) {
        score += 22;
        reasons.push("Has chapter audio for an auditory learner.");
      }
      break;
    case "reading":
      if (item.type === "book" || item.type === "booklet") {
        score += 28;
        reasons.push("Print text for a reading learner.");
      } else if (item.type === "lesson") {
        score += 14;
        reasons.push("Lesson reading for a reading learner.");
      }
      if (hasPrint) {
        score += 10;
        reasons.push("A PDF or EPUB is available.");
      }
      break;
    case "visual":
      if (hasImage) {
        score += 24;
        reasons.push("Has an image.");
      }
      if (item.subject === "art") {
        score += 18;
        reasons.push("Art subject for a visual learner.");
      }
      if (item.type === "demo") {
        score += 8;
        reasons.push("Worked example to look through.");
      }
      break;
    case "kinesthetic":
      if (item.type === "lesson") {
        score += 26;
        reasons.push("Lesson with a hands-on Try This.");
      }
      if (item.type === "demo") {
        score += 10;
        reasons.push("Practice transcript.");
      }
      break;
    default:
      break;
  }

  if (item.type === "lesson") score += 6;
  else if (item.type === "book") score += 4;
  else if (item.type === "booklet") score += 3;

  if (item.type === "lesson" && item.number !== undefined) {
    score += Math.max(0, 5 - item.number);
  }

  return {
    item,
    score: Math.round(score * 1000) / 1000,
    rationale: reasons.join(" "),
  };
}
