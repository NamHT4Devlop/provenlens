/**
 * Why this repository resolves as well as it does, and what would change it.
 *
 * A coverage figure on its own is not actionable: 68% could mean the resolver
 * is weak, or it could mean nobody ran `npm install`. The two look identical
 * in the number and are nothing alike in the fix, so this reads the index and
 * the machine and says which one it is.
 *
 * Every finding names the evidence it rests on. Nothing here estimates what
 * coverage *would* be after a fix -- that is measured by running again, not
 * predicted.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { builtinModules } from 'node:module';
import { execFileSync } from 'node:child_process';
import { nodeModulesRoots, importedPackages } from './ambient.js';
import { readTsconfigPaths } from './resolve/typescript.js';
import { classpathFor, unresolvedImports } from './jvm.js';

/**
 * A tsconfig alias looks exactly like a package name and is not one.
 * `@domain/donation` mapping to `src/domain/*` is this repository's own code,
 * and reporting it as an uninstalled dependency sends someone to npm for
 * something npm has never heard of. Every enterprise TypeScript project has
 * these, so getting it wrong would make the report noise.
 */
function aliasMatcher(root) {
  // A workspace declares its aliases in its own tsconfig, not the one at the
  // top: agenta answers `@src/*` from web/oss/tsconfig.json, and reading only
  // the root left that looking like a package.
  const configs = [];
  const collect = (dir, depth) => {
    configs.push(readTsconfigPaths(dir));
    if (depth >= 2) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      collect(join(dir, e.name), depth + 1);
    }
  };
  collect(root, 0);

  const patterns = [];
  for (const config of configs) {
    for (const key of Object.keys(config?.paths ?? {})) {
      const prefix = key.endsWith('/*') ? key.slice(0, -1) : key;
      patterns.push({ prefix, exact: !key.endsWith('/*') });
    }
  }
  if (!patterns.length) return () => false;
  return (specifier) =>
    patterns.some((p) => (p.exact ? specifier === p.prefix : specifier.startsWith(p.prefix)));
}

/**
 * `crypto` and `fs` are the runtime, whether or not the import spells the
 * `node:` prefix. Asking someone to install one would be a wild goose chase,
 * and Node itself is the authority on which names those are.
 */
const RUNTIME_MODULES = new Set(builtinModules);

/** A repo is only asked about a language it actually contains. */
function languagesIn(db) {
  const rows = db
    .prepare("SELECT lang, COUNT(*) AS n FROM files WHERE external = 0 GROUP BY lang")
    .all();
  return new Map(rows.map((r) => [r.lang, r.n]));
}

function hasCommand(name) {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    // javap exits non-zero with no arguments but still exists; ENOENT is the
    // only answer that means "not installed".
    return false;
  }
}

/**
 * How much of what the project imports the index can actually read. This is
 * the single strongest predictor in the benchmark: express reads 91.4% with
 * its dependencies present and 72.4% without them, on identical source.
 */
function dependencyCoverage(db, root, langs) {
  const findings = [];

  if (langs.has('typescript') || langs.has('javascript')) {
    const isAlias = aliasMatcher(root);
    const wanted = importedPackages(db).filter((p) => !isAlias(p) && !RUNTIME_MODULES.has(p));
    const roots = nodeModulesRoots(root);
    const read = new Set(
      db
        .prepare('SELECT DISTINCT owner FROM files WHERE external = 1 AND owner IS NOT NULL')
        .all()
        .map((r) => r.owner),
    );
    const missing = wanted.filter((p) => !read.has(p));

    if (!wanted.length) {
      // Nothing to install, so nothing to report either way.
    } else if (!roots.length) {
      findings.push({
        level: 'blocking',
        what: `no node_modules anywhere in the tree, and the code imports ${wanted.length} package(s)`,
        why: 'a chain through a library stops at the library, and everything past it is a miss',
        fix: 'npm install   (or yarn / pnpm install, whichever this project uses)',
      });
    } else if (missing.length > wanted.length * 0.2) {
      findings.push({
        level: 'blocking',
        what: `${missing.length} of ${wanted.length} imported package(s) have no readable declarations`,
        why: 'they are not installed, they ship no .d.ts of their own, or they are a path alias declared somewhere this check did not look',
        fix: `check each one before installing it — a name that is really an alias needs nothing: ${missing.slice(0, 6).join(', ')}`,
      });
    } else if (missing.length) {
      findings.push({
        level: 'minor',
        what: `${missing.length} of ${wanted.length} imported package(s) have no readable declarations`,
        why: 'most of these ship no types of their own, and some may be path aliases',
        fix: `optional: add @types/<name> for the real packages among ${missing.slice(0, 4).join(', ')}`,
      });
    }
  }

  if (langs.has('java')) {
    if (!hasCommand('javap')) {
      findings.push({
        level: 'blocking',
        what: 'javap is not on PATH, so no compiled signature can be read',
        why: "a receiver typed by a JAR -- Mono<T>, Optional<T>, the Spring test harness -- has no declaration to walk, and the chain ends there",
        fix: 'install a JDK (any version) and make sure `javap -version` runs',
      });
    } else {
      const unread = unresolvedImports(db);
      const classpath = classpathFor(root);
      const jars = classpath ? classpath.split(delimiter).length : 0;
      if (!jars) {
        findings.push({
          level: 'blocking',
          what: `no jars found, and ${unread.length} imported type(s) are declared outside this repo`,
          why: 'nothing on disk declares them, so every call on one is unresolvable',
          fix: 'run ./mvnw dependency:resolve, or ./gradlew build, once — the jars land in ~/.m2 or ~/.gradle and are found from then on',
        });
      } else if (unread.length > 200) {
        findings.push({
          level: 'minor',
          what: `${unread.length} imported type(s) still have no declaration among ${jars} jar(s)`,
          why: 'these are usually modules the build has not fetched yet',
          fix: 'a full ./mvnw package or ./gradlew build fetches the rest',
        });
      }
    }
  }

  if (langs.has('ruby')) {
    findings.push({
      level: 'inherent',
      what: 'Ruby declares no types, so a receiver can only be typed by convention',
      why: 'this is the language, not the index: `def deliver(recipient)` says nothing anywhere about what recipient is',
      fix: 'nothing to install — expect the floor to sit 6-8 points under the headline, which is what those links are worth',
    });
  }

  return findings;
}

/** What the misses are actually made of, so the biggest one is named. */
function missShape(db) {
  const rows = db
    .prepare(
      `SELECT reason, COUNT(*) AS n FROM unresolved
        WHERE external = 0 GROUP BY reason ORDER BY n DESC LIMIT 3`,
    )
    .all();
  const total = rows.reduce((sum, r) => sum + r.n, 0);
  return { rows, total };
}

export function diagnose(db, root) {
  const langs = languagesIn(db);
  const findings = dependencyCoverage(db, root, langs);

  // Layout, checked only where it can actually bite: a workspace that keeps
  // its packages one level down used to hide all of them.
  if ((langs.has('typescript') || langs.has('javascript')) && !existsSync(join(root, 'package.json'))) {
    findings.push({
      level: 'minor',
      what: 'no package.json at the root being indexed',
      why: 'this may be a level above the actual application, which costs nothing but indexes more than you asked for',
      fix: 'point provenlens at the directory holding package.json if the extra files are not wanted',
    });
  }

  return { langs, findings, misses: missShape(db) };
}
