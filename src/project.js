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

/**
 * Every indexed repository at or just below `start`.
 *
 * A microservice workspace is usually one folder holding several service
 * checkouts, so a directory that is not itself indexed is scanned one level
 * down rather than reported as empty.
 */
export function discoverProjects(start = process.cwd()) {
  const dir = resolve(start);
  const own = findProjectRoot(dir);
  if (own) return [own];

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => join(dir, e.name))
    .filter((child) => existsSync(join(child, INDEX_DIR, DB_FILE)))
    .sort();
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

/**
 * A predicate matching what discovery skips: .gitignore plus the directories
 * that are never source. The watcher uses the same one, so a build or a
 * dependency install cannot trigger a reindex that discovery would ignore anyway.
 */
export function buildIgnoreFilter(root) {
  const ig = buildIgnore(root);
  return (relPath) => {
    if (!relPath) return true;
    const clean = relPath.split(sep).join('/');
    if (ig.ignores(clean)) return true;
    // ignore() only matches a directory rule against a trailing slash.
    return clean.includes('/') && ig.ignores(`${clean.split('/')[0]}/`);
  };
}

/**
 * Walks the tree once, honouring .gitignore, and returns the repo-relative
 * paths `accept` says yes to. Binding plugins use it for XML and SQL, which
 * have no grammar but still wire the system together.
 */
export function walkFiles(root, accept, { maxBytes = 2_000_000 } = {}) {
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
        if (!accept(rel)) continue;
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

/** Every source file with a grammar, as repo-relative paths. */
export function discoverFiles(root, opts) {
  return walkFiles(root, (rel) => Boolean(langForPath(rel)), opts);
}
