import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import ignore from 'ignore';
import { langForPath } from './lang.js';

export const INDEX_DIR = '.provenlens';
export const DB_FILE = 'index.db';

const ALWAYS_IGNORE = [
  '.git',
  '.provenlens',
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
  const ig = ignore();
  const gitignore = join(root, '.gitignore');
  if (existsSync(gitignore)) {
    try {
      ig.add(readFileSync(gitignore, 'utf8'));
    } catch {
      /* an unreadable .gitignore just means fewer exclusions */
    }
  }
  // Added LAST, so it wins over a negation in the repository's own .gitignore.
  // `!vendor/**/node_modules/**` tells git what to TRACK; it does not tell this
  // tool that a dependency tree is the project's own source. Applied the other way
  // round, such a repository indexed the same .d.ts twice -- once as project code,
  // then again as an external declaration -- and the second insert hit the
  // files.path UNIQUE constraint and aborted the entire index.
  ig.add(ALWAYS_IGNORE);
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

/**
 * One index run per project at a time.
 *
 * Two runs on the same database do not merely contend for the write lock --
 * SQLite handles that. They contend over the CONTENT: one deletes and rebuilds
 * the symbols the other is still resolving edges against, and the second run
 * dies on a foreign-key violation with the index half written. A busy timeout
 * cannot help, because nothing here is waiting: both are working, on different
 * versions of the truth.
 *
 * So the second run is refused rather than allowed to corrupt the first. The
 * lock names the process holding it, and a lock whose process is gone -- a
 * machine that lost power mid-index -- is taken over rather than blocking the
 * project forever.
 */
export function acquireIndexLock(root) {
  const lockDir = join(root, INDEX_DIR);
  // No index directory means the database lives somewhere else entirely --
  // a benchmark writing to a temp file, a test fixture. There is no shared
  // index to protect, and creating the directory to hold a lock would leave
  // a footprint in a tree that never asked for one.
  if (!existsSync(lockDir)) return () => {};

  const lockPath = join(lockDir, 'index.lock');
  const mine = String(process.pid);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, mine, { flag: 'wx' });
      return () => {
        try {
          if (readFileSync(lockPath, 'utf8') === mine) rmSync(lockPath, { force: true });
        } catch {
          /* already gone, which is the state we wanted */
        }
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      let holder = null;
      try {
        holder = readFileSync(lockPath, 'utf8').trim();
      } catch {
        continue; // vanished between the failed write and the read
      }
      // `kill(pid, 0)` asks whether the process exists without signalling it.
      let alive = false;
      try {
        process.kill(Number(holder), 0);
        alive = true;
      } catch (probe) {
        // EPERM means it exists and belongs to somebody else, so it is alive.
        alive = probe?.code === 'EPERM';
      }
      if (alive) {
        const error = new Error(
          `another provenlens index is running on this project (pid ${holder}). ` +
            `Wait for it, or remove ${lockPath} if that process is gone.`,
        );
        error.code = 'PROVENLENS_LOCKED';
        throw error;
      }
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error('could not take the index lock');
}
