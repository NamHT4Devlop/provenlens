import { existsSync, readFileSync, readdirSync, statSync, lstatSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, relative, sep, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import ignore from 'ignore';
import { langForPath } from './lang.js';

export const INDEX_DIR = '.provenlens';
export const DB_FILE = 'index.db';

/**
 * Trees that are never this project's own code, even when git tracks them.
 *
 * A committed `node_modules` is a vendored install, not source, and git
 * tracking it says nothing either way. The one signal that does is the
 * repository's own `.gitignore` putting the tree back with a negation, which
 * node-red does for `packages/node_modules` -- and that is honoured below.
 */
const DEPENDENCY_TREES = [
  '.git',
  '.provenlens',
  'node_modules',
  'vendor/bundle',
  '.next',
  '.gradle',
  '.idea',
  '__pycache__',
];

/**
 * Build output, by name. Only an approximation of what git knows, so it is
 * consulted only when git cannot be: matched at any depth, it also swallowed
 * a Java package called `build` and a `src/build/` full of tracked source.
 */
const BUILD_OUTPUT = ['target', 'build', 'dist', 'out', 'coverage', 'tmp'];

const ALWAYS_IGNORE = [...DEPENDENCY_TREES, ...BUILD_OUTPUT];

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

function buildIgnore(root, { always = ALWAYS_IGNORE } = {}) {
  const own = ignore();
  let hasOwn = false;
  const gitignore = join(root, '.gitignore');
  if (existsSync(gitignore)) {
    try {
      own.add(readFileSync(gitignore, 'utf8'));
      hasOwn = true;
    } catch {
      /* an unreadable .gitignore just means fewer exclusions */
    }
  }
  const alwaysRules = ignore().add(always);

  /**
   * Whether the repository has said, in its own .gitignore, that this path is
   * source rather than an install.
   *
   * `node_modules` in ALWAYS_IGNORE means "a dependency tree", and for almost
   * every repository it is. node-red keeps its entire product in
   * `packages/node_modules` -- 308 of its 541 JavaScript files -- and says so:
   *
   *     node_modules
   *     !packages/node_modules
   *     packages/node_modules/@node-red/editor-client/public
   *
   * Those three lines answer every path correctly, including the sub-exclusion.
   * A blanket rule applied after them made 57% of the repository invisible.
   *
   * Only an EXPLICIT negation counts, and only on the path or one of its
   * parents: a repository that never mentions `build/` still has it skipped.
   * The authority is the right one -- git tracks what you wrote and does not
   * track what you installed.
   */
  const claimedAsSource = (path) => {
    if (!hasOwn || !path) return false;
    const parts = path.replace(/\/+$/, '').split('/');
    for (let i = 1; i <= parts.length; i++) {
      if (own.test(parts.slice(0, i).join('/')).unignored) return true;
    }
    return false;
  };

  // ALWAYS_IGNORE is consulted second and can be overruled, which it could not
  // be before. The reason it could not -- a dependency tree indexed once as
  // project code and again as an external declaration, whose second insert hit
  // the files.path UNIQUE constraint and aborted the whole index -- was fixed
  // where it belonged, at the insert: reading declarations now says
  // `ON CONFLICT(path) DO NOTHING`, and the project's own copy wins.
  return {
    ignores(path) {
      if (own.ignores(path)) return true;
      if (!alwaysRules.ignores(path)) return false;
      return !claimedAsSource(path);
    },
  };
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
 * What git says this tree's source is, or null when git cannot say.
 *
 * Tracked files, plus untracked ones git does not ignore -- a file an agent
 * wrote a moment ago is source before anyone runs `git add`. Minus the files
 * that are tracked only because somebody forced them past the ignore rules,
 * which is how a built `dist/` gets committed and is not how source arrives.
 *
 * This is the authority the ignore rules below were approximating. The
 * approximation matched a name at any depth, so a Java package called
 * `org.springframework.boot.build` -- 295 tracked files -- was skipped as if
 * it were compiler output, and every call into it was reported as proven to
 * leave the repository. A `.gitignore` in a subdirectory was never read at
 * all. git reads them all, and has the final say on both.
 *
 * Paths come back relative to `root` even when the root is a subdirectory of
 * the repository, with forward slashes on every platform. Nothing here runs
 * when the tree is not inside a repository, or git is not installed: then the
 * rules stand, exactly as before.
 */
function gitSourceFiles(root) {
  const run = (args) =>
    execFileSync('git', ['-C', root, 'ls-files', '-z', '--exclude-standard', ...args], {
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60_000,
    })
      .split('\0')
      .filter(Boolean);
  try {
    const source = new Set(run(['--cached', '--others']));
    for (const forced of run(['--cached', '--ignored'])) source.delete(forced);
    return source;
  } catch {
    return null;
  }
}

/**
 * Walks the tree once and returns the repo-relative paths `accept` says yes
 * to: git's view of the source when there is one, the ignore rules when there
 * is not. Binding plugins use it for XML and SQL, which have no grammar but
 * still wire the system together.
 *
 * A file over `maxBytes` is refused here, and reported through `oversized`
 * so the caller can count it: refused silently, it was missing from every
 * number the tool printed, and a call into it read as a call out of the repo.
 */
export function walkFiles(root, accept, { maxBytes = 2_000_000, oversized = null } = {}) {
  const found = [];
  const take = (rel, abs) => {
    if (!accept(rel)) return;
    let size;
    try {
      size = statSync(abs).size;
    } catch {
      return;
    }
    if (size > maxBytes) {
      oversized?.push(rel);
      return;
    }
    found.push(rel);
  };

  const fromGit = gitSourceFiles(root);
  if (fromGit) {
    // git has settled what is build output; a dependency tree is still a
    // dependency tree unless the repository's .gitignore says otherwise.
    const deps = buildIgnore(root, { always: DEPENDENCY_TREES });
    for (const rel of fromGit) {
      if (deps.ignores(rel)) continue;
      // A symlink is skipped whatever it points at: `x.js -> ~/.ssh/id_rsa`
      // in a repository cloned to read would otherwise be indexed and served
      // back as source.
      const abs = join(root, rel);
      let entry;
      try {
        entry = lstatSync(abs);
      } catch {
        continue; // tracked, but no longer on disk
      }
      if (!entry.isFile()) continue;
      take(rel, abs);
    }
    return found.sort();
  }

  const ig = buildIgnore(root);
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Dirent already answers false to both isFile() and isDirectory() for a
      // symlink; the line is here so the rule survives the day someone makes
      // the walk follow links for a monorepo.
      if (entry.isSymbolicLink()) continue;
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (!rel || ig.ignores(entry.isDirectory() ? `${rel}/` : rel)) continue;

      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile()) take(rel, abs);
    }
  };

  visit(root);
  return found.sort();
}

/**
 * A path as the index spells it: relative to the root, forward slashes.
 *
 * Accepts what a user or a tool hands over -- absolute, or relative to the
 * working directory -- and returns null for anything outside the root. The
 * CLI and the MCP server both used to test `abs.startsWith(root + '/')`, which
 * on Windows is never true: the separator there is `\`, so every absolute path
 * fell through unchanged and matched nothing in the index.
 */
export function repoRelative(root, given) {
  const rel = relative(root, resolve(given));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * A changed file as the index spells it, from either way a caller writes one.
 *
 * `git diff --name-only` prints paths relative to the repository root, and
 * that output piped into `affected` is the documented use. A shell user types
 * a path relative to wherever they are. Resolving both against the working
 * directory -- which is what happened -- doubled the git one whenever the
 * command ran from a subdirectory: `com/acme/Donation.java` became
 * `com/acme/com/acme/Donation.java` and was reported as not in the index.
 *
 * So the repo-relative reading wins whenever it names something real: a path
 * the index knows, or one on disk under the root. Only then is the working
 * directory consulted. `known` lets the caller vouch for a file that git says
 * changed but that is no longer on disk -- a deletion is a change too.
 */
export function changedPath(root, given, { known = () => false } = {}) {
  const asWritten = String(given).split('\\').join('/').replace(/^\.\//, '');
  if (asWritten && (known(asWritten) || existsSync(join(root, asWritten)))) return asWritten;
  return repoRelative(root, given) ?? asWritten;
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
  // A PID is reused once its process exits, so "that process is alive" can be
  // true of a stranger. No index run takes anything like this long -- the
  // largest of 10,000 repositories finished inside the ten-minute budget --
  // so a lock this old held by a live PID is far likelier to be a recycled
  // number than a run still going, and is taken over rather than obeyed.
  const MAX_LOCK_AGE_MS = 3 * 60 * 60 * 1000;

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
        let ageMs = 0;
        try {
          ageMs = Date.now() - statSync(lockPath).mtimeMs;
        } catch {
          continue; // vanished; the write is retried
        }
        if (ageMs > MAX_LOCK_AGE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
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

/**
 * The lock, or null when another process holds it.
 *
 * For the callers that keep an index fresh in the background -- the MCP
 * server, `serve`, the watcher -- a held lock is not an error to die on: the
 * other run lands in the same file, and this one has only to wait its turn.
 * Two MCP servers started on one repository used to race their first sync
 * into a foreign-key failure; now the second sees the lock and stands aside.
 */
export function tryIndexLock(root) {
  try {
    return acquireIndexLock(root);
  } catch (err) {
    if (err?.code === 'PROVENLENS_LOCKED') return null;
    throw err;
  }
}
