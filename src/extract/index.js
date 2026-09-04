import { extractJava } from './java.js';
import { extractRuby } from './ruby.js';
import { extractTypeScript } from './typescript.js';

/**
 * Language -> extractor. A language with no entry here is discovered and
 * counted, but not parsed; `provenlens status` reports it as pending so the
 * gap is visible rather than silent.
 */
const EXTRACTORS = {
  java: extractJava,
  ruby: extractRuby,
  typescript: extractTypeScript,
  tsx: extractTypeScript,
  javascript: extractTypeScript,
};

export function extractorFor(lang) {
  return EXTRACTORS[lang] ?? null;
}

export const IMPLEMENTED_LANGUAGES = Object.keys(EXTRACTORS);
