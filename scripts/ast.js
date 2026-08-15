#!/usr/bin/env -S node --no-warnings
/**
 * Dump a file's AST. The tool every extractor gets written against:
 *   ./scripts/ast.js path/to/File.rb [maxDepth]
 */
import { readFileSync } from 'node:fs';
import { getParser, langForPath } from '../src/lang.js';

const [, , file, depthArg] = process.argv;
if (!file) {
  console.error('usage: ast.js <file> [maxDepth]');
  process.exit(1);
}

const maxDepth = Number(depthArg ?? 6);
const lang = langForPath(file);
if (!lang) {
  console.error(`no grammar for ${file}`);
  process.exit(1);
}

const src = readFileSync(file, 'utf8');
const parser = await getParser(lang);
const tree = parser.parse(src);

const short = (node) => {
  const text = src.slice(node.startIndex, node.endIndex).split('\n')[0];
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
};

const walk = (node, depth, fieldName) => {
  if (depth > maxDepth) return;
  const label = fieldName ? `${fieldName}: ` : '';
  console.log(
    `${'  '.repeat(depth)}${label}(${node.type})` +
      `${node.namedChildCount === 0 ? `  "${short(node)}"` : ''}`,
  );
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walk(child, depth + 1, node.fieldNameForNamedChild?.(i) ?? null);
  }
};

walk(tree.rootNode, 0, null);
