/**
 * Declaration files from dependencies, read so a chain can be typed *through*
 * a library instead of stopping at one.
 *
 * `client.get(...)` returning `Promise<Response>` is where most remaining
 * misses live: the receiver's type is declared in `node_modules`, so without
 * reading it the next hop has nothing to go on. TypeScript ships those
 * declarations as plain `.d.ts` text, which the existing extractor already
 * understands.
 *
 * What is read here is emphatically **not this project's code**. The files are
 * marked `external`, their symbols are never resolution targets, and their call
 * sites are dropped entirely -- a call landing on one is a library call, proven
 * by the declaration rather than assumed from a name. Coverage is unaffected
 * except by resolving more of the project's own calls.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

/** Enough to type a chain; past this a package is more noise than answer. */
const MAX_FILES_PER_PACKAGE = 120;
const MAX_BYTES = 1_500_000;

/** How deep a workspace package may sit before it stops being worth finding. */
const MAX_WORKSPACE_DEPTH = 3;

/**
 * Every `node_modules` this project installs into, nearest first.
 *
 * A single root directory is the exception in anything larger than a demo. A
 * pnpm or yarn workspace installs each package's dependencies beside that
 * package -- agenta keeps `zod` in `oss/node_modules`, not at the top -- so
 * looking only at the root found 8 packages out of several hundred, and every
 * chain through the other several hundred stopped dead.
 *
 * pnpm's own flat store is included last: it holds every version of everything
 * the workspace resolved, which is the right answer when nothing nearer has it.
 */
export function nodeModulesRoots(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > MAX_WORKSPACE_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      // A dotfile directory is tooling, not source, and descending into one
      // node_modules to find another is somebody else's dependency tree.
      if (e.name === 'node_modules') {
        found.push(join(dir, e.name));
      } else if (!e.name.startsWith('.')) {
        walk(join(dir, e.name), depth + 1);
      }
    }
  };
  walk(root, 0);
  const store = join(root, 'node_modules', '.pnpm', 'node_modules');
  if (existsSync(store)) found.push(store);
  return found;
}

/** `@scope/name/sub/path` -> `@scope/name`; `pkg/sub` -> `pkg`. */
export function packageOf(specifier) {
  if (!specifier || specifier.startsWith('.')) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * The declaration files for one package: its declared entry point, plus the
 * `.d.ts` files beside it. Following every `/// <reference` chain would drag
 * in the whole standard library for one `Promise`, so the neighbourhood is
 * where this stops.
 */
function declarationsFor(roots, pkg) {
  const typesName = join('@types', pkg.replace('@', '').replace('/', '__'));
  let home = null;
  for (const nm of roots) {
    const base = join(nm, pkg);
    const typesBase = join(nm, typesName);
    if (existsSync(base)) {
      home = base;
      break;
    }
    if (!home && existsSync(typesBase)) home = typesBase;
  }
  if (!home) return [];

  let entry = null;
  try {
    const meta = JSON.parse(readFileSync(join(home, 'package.json'), 'utf8'));
    const declared = meta.types ?? meta.typings;
    if (declared) entry = join(home, declared);
  } catch {
    /* no manifest, or an unreadable one: fall back to the conventional name */
  }
  if (!entry || !existsSync(entry)) entry = join(home, 'index.d.ts');
  if (!existsSync(entry)) return [];

  const out = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    if (out.length >= MAX_FILES_PER_PACKAGE || depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES_PER_PACKAGE) return;
      const full = join(dir, e.name);
      // A package's own node_modules is somebody else's dependency tree.
      if (e.isDirectory() && e.name !== 'node_modules') walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith('.d.ts') && !seen.has(full)) {
        try {
          if (statSync(full).size > MAX_BYTES) continue;
        } catch {
          continue;
        }
        seen.add(full);
        out.push(full);
      }
    }
  };
  walk(dirname(entry), 0);
  if (!seen.has(entry)) out.unshift(entry);
  return out;
}

/**
 * Which packages this project actually imports, taken from the index rather
 * than from package.json: a dependency nothing imports has no bearing on
 * anything, and reading it would be pure cost.
 */
export function importedPackages(db) {
  const specs = db
    .prepare(
      `SELECT DISTINCT i.fqn FROM imports i JOIN files f ON f.id = i.file_id
        WHERE f.external = 0 AND i.fqn NOT LIKE '.%'`,
    )
    .all()
    .map((r) => packageOf(r.fqn))
    .filter(Boolean);
  return [...new Set(specs)].filter((p) => !p.startsWith('node:'));
}

/**
 * Reads the declaration files of every imported package into the index.
 * Returns what was read, for the caller to report.
 */
export function indexAmbient(db, root, { parsers, extractorFor, langForPath }) {
  const roots = nodeModulesRoots(root);
  if (!roots.length) return { packages: 0, files: 0, symbols: 0 };

  const insertFile = db.prepare(
    // DO NOTHING rather than REPLACE: if a path is somehow already in the index it
    // belongs to the project, and the project's own copy of a file outranks a
    // reading of it as somebody's dependency. Skipping one declaration file costs a
    // little type information; the plain INSERT used to cost the whole index.
    `INSERT INTO files (path, lang, hash, pkg, lines, indexed_at, external, owner)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(path) DO NOTHING`,
  );
  const insertSymbol = db.prepare(
    `INSERT INTO symbols
       (file_id, name, fqn, kind, container_fqn, type_name, type_args, signature, arity, params,
        start_line, end_line, start_byte, end_byte, modifiers, annotations)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertType = db.prepare(
    'INSERT OR REPLACE INTO types (fqn, symbol_id, kind, supertypes) VALUES (?, ?, ?, ?)',
  );
  const insertImport = db.prepare(
    `INSERT INTO imports (file_id, fqn, simple, is_wildcard, is_static, orig, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec("DELETE FROM files WHERE external = 1");

  const stats = { packages: 0, files: 0, symbols: 0 };

  for (const pkg of importedPackages(db)) {
    const files = declarationsFor(roots, pkg);
    if (!files.length) continue;
    stats.packages++;

    for (const abs of files) {
      const rel = relative(root, abs).replace(/\\/g, '/');
      let source;
      try {
        source = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }

      const lang = langForPath(rel) ?? 'typescript';
      const parser = parsers.get(lang);
      const extract = extractorFor(lang);
      if (!parser || !extract) continue;

      let result;
      try {
        result = extract(parser.parse(source), source, { path: rel });
      } catch {
        // A declaration file using syntax the grammar cannot take is skipped,
        // not fatal: the rest of the package is still worth reading.
        continue;
      }

      const inserted = insertFile.run(
        rel, lang, '', result.package ?? null, source.split('\n').length, Date.now(), pkg,
      );
      // The path was already taken by project code: leave that row alone.
      if (!inserted.changes) continue;
      const fileId = Number(inserted.lastInsertRowid);

      for (const imp of result.imports ?? []) {
        insertImport.run(
          fileId, imp.fqn, imp.simple, imp.is_wildcard ?? 0, imp.is_static ?? 0,
          imp.orig ?? null, imp.kind ?? 'import',
        );
      }

      for (const sym of result.symbols) {
        const id = Number(
          insertSymbol.run(
            fileId, sym.name, sym.fqn, sym.kind, sym.container_fqn, sym.type_name,
            sym.type_args ?? null, sym.signature, sym.arity,
            sym.params ? JSON.stringify(sym.params) : null,
            sym.start_line, sym.end_line, sym.start_byte, sym.end_byte,
            JSON.stringify(sym.modifiers ?? []), JSON.stringify(sym.annotations ?? []),
          ).lastInsertRowid,
        );
        if (['class', 'interface', 'enum', 'record', 'annotation', 'module'].includes(sym.kind)) {
          insertType.run(sym.fqn, id, sym.kind, JSON.stringify(sym.supertypes ?? []));
        }
        stats.symbols++;
      }
      // Call sites inside a dependency are none of this project's business,
      // and counting them would drown its own coverage.
      stats.files++;
    }
  }
  return stats;
}

