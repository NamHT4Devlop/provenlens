import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import ignore from 'ignore';
import { langForPath } from './lang.js';

export const INDEX_DIR = '.codelens';
export const DB_FILE = 'index.db';

const ALWAYS_IGNORE = [
  '.git',
  '.codelens',
  'node_modules',
  'vendor/bundle',
  'target',
  'build',
  'dist',
  'out',
  'coverage',
  'tmp',
  '.next',
  '.gradle',
  '.idea',
  '__pycache__',
];

/** Walks up from `start` looking for a directory that has been `init`-ed. */
export function findProjectRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, INDEX_DIR, DB_FILE))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

export function dbPathFor(root) {
  return join(root, INDEX_DIR, DB_FILE);
}

function buildIgnore(root) {
  const ig = ignore().add(ALWAYS_IGNORE);
  const gitignore = join(root, '.gitignore');
  if (existsSync(gitignore)) {
    try {
      ig.add(readFileSync(gitignore, 'utf8'));
    } catch {
      /* an unreadable .gitignore just means fewer exclusions */
    }
  }
  return ig;
}

/** Yields every indexable source file under `root`, as repo-relative paths. */
export function discoverFiles(root, { maxBytes = 2_000_000 } = {}) {
  const ig = buildIgnore(root);
  const found = [];

  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (!rel || ig.ignores(entry.isDirectory() ? `${rel}/` : rel)) continue;

      if (entry.isDirectory()) {
        visit(abs);
      } else if (entry.isFile()) {
        if (!langForPath(rel)) continue;
        try {
          if (statSync(abs).size > maxBytes) continue;
        } catch {
          continue;
        }
        found.push(rel);
      }
    }
  };

  visit(root);
  return found.sort();
}
