import { extractJava } from './java.js';

/**
 * Language -> extractor. A language with no entry here is discovered and
 * counted, but not parsed; `codelens status` reports it as pending so the
 * gap is visible rather than silent.
 */
const EXTRACTORS = {
  java: extractJava,
};

export function extractorFor(lang) {
  return EXTRACTORS[lang] ?? null;
}

export const IMPLEMENTED_LANGUAGES = Object.keys(EXTRACTORS);
