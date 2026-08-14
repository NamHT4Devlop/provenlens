import { Parser, Language } from 'web-tree-sitter';
import { createRequire } from 'node:module';
import { dirname, join, extname } from 'node:path';

const require = createRequire(import.meta.url);
const WASM_DIR = join(dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');

/**
 * The four languages this tool targets. Adding a fifth means: add an entry here,
 * an extractor in src/extract/, and a resolver in src/resolve/.
 */
export const LANGUAGES = {
  java: { wasm: 'tree-sitter-java.wasm', exts: ['.java'] },
  ruby: { wasm: 'tree-sitter-ruby.wasm', exts: ['.rb', '.rake'] },
  typescript: { wasm: 'tree-sitter-typescript.wasm', exts: ['.ts', '.mts', '.cts'] },
  tsx: { wasm: 'tree-sitter-tsx.wasm', exts: ['.tsx'] },
  javascript: { wasm: 'tree-sitter-javascript.wasm', exts: ['.js', '.mjs', '.cjs', '.jsx'] },
};

const EXT_TO_LANG = new Map();
for (const [lang, def] of Object.entries(LANGUAGES)) {
  for (const ext of def.exts) EXT_TO_LANG.set(ext, lang);
}

export function langForPath(path) {
  return EXT_TO_LANG.get(extname(path).toLowerCase()) ?? null;
}

let initialized = false;
const parserCache = new Map();

/** Loads a grammar once per process and hands back a ready parser. */
export async function getParser(lang) {
  if (parserCache.has(lang)) return parserCache.get(lang);

  const def = LANGUAGES[lang];
  if (!def) throw new Error(`Unsupported language: ${lang}`);

  if (!initialized) {
    await Parser.init();
    initialized = true;
  }

  const language = await Language.load(join(WASM_DIR, def.wasm));
  const parser = new Parser();
  parser.setLanguage(language);
  parserCache.set(lang, parser);
  return parser;
}
