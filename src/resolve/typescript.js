/**
 * TypeScript / JavaScript resolver.
 *
 * The work here is mostly module resolution: a call only becomes an edge once
 * `import { X } from '@domain/donation'` has been turned into a real file, and
 * barrel files mean that can take several hops.
 *
 *   1.0  direct           -- receiver typed by an annotation, `new`, or a field
 *   0.9  interface->impl  -- receiver was an interface; linked to implementations
 *   0.5  unique-name      -- no type info, exactly one match in the project
 */
import { readFileSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';

const TS_LANGS = ['typescript', 'tsx', 'javascript'];
const LANG_LIST = TS_LANGS.map((l) => `'${l}'`).join(', ');

const EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

/** Reads `compilerOptions.paths` so alias imports resolve like the compiler does. */
export function readTsconfigPaths(root) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    try {
      const raw = readFileSync(join(root, name), 'utf8');
      // Strip comments and trailing commas: tsconfig is JSONC in practice.
      const cleaned = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
        .replace(/,(\s*[}\]])/g, '$1');
      const config = JSON.parse(cleaned);
      const opts = config.compilerOptions ?? {};
      if (!opts.paths) continue;
      return { baseUrl: opts.baseUrl ?? '.', paths: opts.paths };
    } catch {
      /* missing or unparseable config just means no aliases */
    }
  }
  return { baseUrl: '.', paths: {} };
}

export function resolveTypeScript(db, root) {
  const { baseUrl, paths } = readTsconfigPaths(root);

  const files = db
    .prepare(`SELECT id, path, pkg FROM files WHERE lang IN (${LANG_LIST})`)
    .all();
  const moduleToFile = new Map(); // 'src/domain/donation' -> file row
  for (const f of files) moduleToFile.set(f.pkg, f);

  /** Probes the extensions and the `/index` form, like a bundler would. */
  function probe(candidate) {
    const clean = candidate.replace(/\\/g, '/').replace(/^\.\//, '');
    if (moduleToFile.has(clean)) return clean;
    for (const ext of EXTENSIONS) {
      const stripped = clean.endsWith(ext) ? clean.slice(0, -ext.length) : null;
      if (stripped && moduleToFile.has(stripped)) return stripped;
    }
    const asIndex = `${clean}/index`;
    if (moduleToFile.has(asIndex)) return asIndex;
    return null;
  }

  function resolveModule(fromModule, specifier) {
    if (!specifier) return null;

    if (specifier.startsWith('.')) {
      const joined = normalize(join(dirname(fromModule), specifier)).replace(/\\/g, '/');
      return probe(joined);
    }

    for (const [pattern, targets] of Object.entries(paths)) {
      const prefix = pattern.replace(/\*$/, '');
      if (!pattern.endsWith('*')) {
        if (specifier !== pattern) continue;
        for (const target of targets) {
          const hit = probe(normalize(join(baseUrl, target)).replace(/\\/g, '/'));
          if (hit) return hit;
        }
        continue;
      }
      if (!specifier.startsWith(prefix)) continue;
      const rest = specifier.slice(prefix.length);
      for (const target of targets) {
        const candidate = normalize(join(baseUrl, target.replace(/\*$/, rest))).replace(/\\/g, '/');
        const hit = probe(candidate);
        if (hit) return hit;
      }
    }

    return null; // bare specifier: node_modules, deliberately out of scope
  }

  const importsByFile = new Map();
  for (const row of db
    .prepare(
      `SELECT i.* FROM imports i JOIN files f ON f.id = i.file_id
        WHERE f.lang IN (${LANG_LIST})`,
    )
    .all()) {
    if (!importsByFile.has(row.file_id)) importsByFile.set(row.file_id, []);
    importsByFile.get(row.file_id).push(row);
  }

  const types = new Map(); // fqn -> { fqn, symbol_id, kind, supertypes, file_id, module }
  for (const row of db
    .prepare(
      `SELECT t.fqn, t.symbol_id, t.kind, t.supertypes, s.file_id, s.name, f.pkg AS module
         FROM types t
         JOIN symbols s ON s.id = t.symbol_id
         JOIN files f   ON f.id = s.file_id
        WHERE f.lang IN (${LANG_LIST})`,
    )
    .all()) {
    types.set(row.fqn, { ...row, supertypes: JSON.parse(row.supertypes || '[]') });
  }

  const symbolsByModule = new Map(); // module -> [top-level symbol rows]
  const membersByContainer = new Map();
  const allSymbols = db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.arity, s.fqn, s.container_fqn, s.type_name, s.modifiers,
              f.pkg AS module, s.file_id
         FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE f.lang IN (${LANG_LIST})`,
    )
    .all();

  for (const row of allSymbols) {
    if (['class', 'interface', 'function'].includes(row.kind) && row.container_fqn === row.module) {
      if (!symbolsByModule.has(row.module)) symbolsByModule.set(row.module, []);
      symbolsByModule.get(row.module).push(row);
    }
    if (['method', 'constructor', 'field'].includes(row.kind) && row.container_fqn) {
      if (!membersByContainer.has(row.container_fqn)) membersByContainer.set(row.container_fqn, []);
      membersByContainer.get(row.container_fqn).push(row);
    }
  }

  const callablesByName = new Map();
  for (const row of allSymbols) {
    if (!['method', 'function'].includes(row.kind)) continue;
    if (!callablesByName.has(row.name)) callablesByName.set(row.name, []);
    callablesByName.get(row.name).push(row);
  }

  /** Follows re-exports until it finds where a name is actually declared. */
  function resolveExport(module, name, seen = new Set()) {
    if (!module || seen.has(`${module}|${name}`)) return null;
    seen.add(`${module}|${name}`);

    const local = (symbolsByModule.get(module) ?? []).find((s) => s.name === name);
    if (local) return local;

    const file = moduleToFile.get(module);
    if (!file) return null;

    for (const imp of importsByFile.get(file.id) ?? []) {
      if (imp.kind === 'reexport' && imp.simple === name) {
        const target = resolveModule(module, imp.fqn);
        const hit = target && resolveExport(target, imp.orig ?? name, seen);
        if (hit) return hit;
      }
      if (imp.kind === 'reexport-all') {
        const target = resolveModule(module, imp.fqn);
        const hit = target && resolveExport(target, name, seen);
        if (hit) return hit;
      }
    }
    return null;
  }

  /**
   * A type name as written in a file -> the type symbol it denotes.
   * Returns `undefined` for an array type: the receiver is then an Array, whose
   * members live in the runtime, not in this project.
   */
  function resolveTypeName(name, fileId, module) {
    if (!name) return null;
    if (/\[\]$/.test(name)) return undefined;

    const local = (symbolsByModule.get(module) ?? []).find(
      (s) => s.name === name && ['class', 'interface'].includes(s.kind),
    );
    if (local) return types.get(local.fqn) ?? null;

    for (const imp of importsByFile.get(fileId) ?? []) {
      if (imp.kind !== 'import' || imp.simple !== name) continue;
      const target = resolveModule(module, imp.fqn);
      const hit = target && resolveExport(target, imp.orig ?? name);
      if (hit) return types.get(hit.fqn) ?? null;
    }

    const matches = [...types.values()].filter((t) => t.name === name);
    return matches.length === 1 ? matches[0] : null;
  }

  function typeChain(type, seen = new Set()) {
    if (!type || seen.has(type.fqn)) return [];
    seen.add(type.fqn);
    const chain = [type];
    for (const raw of type.supertypes) {
      const superType = resolveTypeName(raw, type.file_id, type.module);
      if (superType) chain.push(...typeChain(superType, seen));
    }
    return chain;
  }

  const subtypesOf = new Map();
  for (const t of types.values()) {
    for (const raw of t.supertypes) {
      const superType = resolveTypeName(raw, t.file_id, t.module);
      if (!superType) continue;
      if (!subtypesOf.has(superType.fqn)) subtypesOf.set(superType.fqn, []);
      subtypesOf.get(superType.fqn).push(t.fqn);
    }
  }

  function findMember(type, name) {
    for (const t of typeChain(type)) {
      const hit = (membersByContainer.get(t.fqn) ?? []).find((m) => m.name === name);
      if (hit) return hit;
    }
    return null;
  }

  const localsByScope = new Map();
  for (const row of db.prepare('SELECT scope_symbol_id, name, type_name FROM locals').all()) {
    if (row.scope_symbol_id == null) continue;
    if (!localsByScope.has(row.scope_symbol_id)) localsByScope.set(row.scope_symbol_id, new Map());
    localsByScope.get(row.scope_symbol_id).set(row.name, row.type_name);
  }

  const symbolById = new Map(allSymbols.map((s) => [s.id, s]));
  const fileById = new Map(files.map((f) => [f.id, f]));

  function receiverType(ref, fromSymbol) {
    const file = fileById.get(ref.file_id);
    const module = file?.pkg;
    const enclosingType = fromSymbol?.container_fqn ? types.get(fromSymbol.container_fqn) : null;
    const raw = ref.receiver;

    if (!raw || raw === 'this') return enclosingType;

    // `this.repository.save(...)` -- the dominant shape in class-based TS.
    const thisField = /^this\.([A-Za-z_$][\w$]*)$/.exec(raw);
    if (thisField) {
      const field = enclosingType ? findMember(enclosingType, thisField[1]) : null;
      return field?.type_name
        ? resolveTypeName(field.type_name, ref.file_id, module)
        : undefined;
    }

    if (!/^[A-Za-z_$][\w$]*$/.test(raw)) return undefined; // chained or complex

    const local = localsByScope.get(ref.from_symbol_id)?.get(raw);
    if (local) return resolveTypeName(local, ref.file_id, module);

    const field = enclosingType ? findMember(enclosingType, raw) : null;
    if (field?.type_name) return resolveTypeName(field.type_name, ref.file_id, module);

    // A bare capitalised receiver is usually an imported class used statically.
    if (/^[A-Z]/.test(raw)) return resolveTypeName(raw, ref.file_id, module) ?? undefined;

    return null;
  }

  // Return-type inference: `const donation = this.service.record(...)` carries
  // no annotation, but the callee declares what it returns. Runs before the
  // main pass so those locals can type their own receivers.
  const pendingLocals = db
    .prepare(
      `SELECT l.id, l.scope_symbol_id, l.name, l.line
         FROM locals l JOIN files f ON f.id = l.file_id
        WHERE f.lang IN (${LANG_LIST}) AND l.type_name IS NULL AND l.init_kind = 'call'`,
    )
    .all();
  const updateLocal = db.prepare('UPDATE locals SET type_name = ? WHERE id = ?');
  const refAt = db.prepare(
    `SELECT * FROM refs WHERE from_symbol_id = ? AND line = ? AND kind = 'call' LIMIT 1`,
  );

  for (const local of pendingLocals) {
    const ref = refAt.get(local.scope_symbol_id, local.line);
    if (!ref) continue;
    const type = receiverType(ref, symbolById.get(ref.from_symbol_id));
    if (!type) continue;
    const target = findMember(type, ref.name);
    if (!target?.type_name) continue;
    updateLocal.run(target.type_name, local.id);
    if (!localsByScope.has(local.scope_symbol_id)) {
      localsByScope.set(local.scope_symbol_id, new Map());
    }
    localsByScope.get(local.scope_symbol_id).set(local.name, target.type_name);
  }

  db.exec(`DELETE FROM edges WHERE from_symbol_id IN (
             SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id
              WHERE f.lang IN (${LANG_LIST}))`);
  db.exec(`DELETE FROM unresolved WHERE ref_id IN (
             SELECT r.id FROM refs r JOIN files f ON f.id = r.file_id
              WHERE f.lang IN (${LANG_LIST}))`);

  const insertEdge = db.prepare(
    `INSERT OR IGNORE INTO edges (from_symbol_id, to_symbol_id, kind, confidence, via, line)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertUnresolved = db.prepare(
    'INSERT OR IGNORE INTO unresolved (ref_id, reason) VALUES (?, ?)',
  );

  const stats = { direct: 0, viaImpl: 0, uniqueName: 0, unresolved: 0, inheritance: 0 };

  for (const t of types.values()) {
    for (const raw of t.supertypes) {
      const superType = resolveTypeName(raw, t.file_id, t.module);
      if (!superType) continue;
      insertEdge.run(
        t.symbol_id,
        superType.symbol_id,
        superType.kind === 'interface' ? 'implements' : 'extends',
        1.0,
        'declaration',
        null,
      );
      stats.inheritance++;
    }
  }

  const refs = db
    .prepare(
      `SELECT r.* FROM refs r JOIN files f ON f.id = r.file_id WHERE f.lang IN (${LANG_LIST})`,
    )
    .all();

  for (const ref of refs) {
    if (ref.from_symbol_id == null) {
      insertUnresolved.run(ref.id, 'no-enclosing-symbol');
      stats.unresolved++;
      continue;
    }
    const fromSymbol = symbolById.get(ref.from_symbol_id);
    const file = fileById.get(ref.file_id);

    if (ref.kind === 'new') {
      const type = resolveTypeName(ref.name, ref.file_id, file?.pkg);
      if (!type) {
        insertUnresolved.run(ref.id, 'unknown-type');
        stats.unresolved++;
        continue;
      }
      insertEdge.run(ref.from_symbol_id, type.symbol_id, 'instantiates', 1.0, 'direct', ref.line);
      const ctor = findMember(type, 'constructor');
      if (ctor) insertEdge.run(ref.from_symbol_id, ctor.id, 'calls', 1.0, 'constructor', ref.line);
      stats.direct++;
      continue;
    }

    // A bare call is either a local function or an imported one.
    if (!ref.receiver) {
      const module = file?.pkg;
      const localFn = (symbolsByModule.get(module) ?? []).find(
        (s) => s.name === ref.name && s.kind === 'function',
      );
      let target = localFn;
      if (!target) {
        for (const imp of importsByFile.get(ref.file_id) ?? []) {
          if (imp.kind !== 'import' || imp.simple !== ref.name) continue;
          const mod = resolveModule(module, imp.fqn);
          target = mod ? resolveExport(mod, imp.orig ?? ref.name) : null;
          if (target) break;
        }
      }
      if (target) {
        insertEdge.run(ref.from_symbol_id, target.id, 'calls', 1.0, 'direct', ref.line);
        stats.direct++;
        continue;
      }
      // Otherwise it may be a method on `this` reached without the prefix.
    }

    const type = receiverType(ref, fromSymbol);

    if (type === undefined) {
      insertUnresolved.run(ref.id, 'external-or-complex-receiver');
      stats.unresolved++;
      continue;
    }

    if (type) {
      const target = findMember(type, ref.name);
      if (target) {
        insertEdge.run(ref.from_symbol_id, target.id, 'calls', 1.0, 'direct', ref.line);
        stats.direct++;

        const declaring = symbolById.get(target.id)?.container_fqn;
        if (types.get(declaring)?.kind === 'interface') {
          for (const subFqn of subtypesOf.get(declaring) ?? []) {
            const impl = findMember(types.get(subFqn), ref.name);
            if (impl && impl.id !== target.id) {
              insertEdge.run(ref.from_symbol_id, impl.id, 'calls', 0.9, 'interface->impl', ref.line);
              stats.viaImpl++;
            }
          }
        }
        continue;
      }
      insertUnresolved.run(ref.id, `no-such-member-on:${type.name}`);
      stats.unresolved++;
      continue;
    }

    const byName = callablesByName.get(ref.name) ?? [];
    if (byName.length === 1) {
      insertEdge.run(ref.from_symbol_id, byName[0].id, 'calls', 0.5, 'unique-name', ref.line);
      stats.uniqueName++;
    } else {
      insertUnresolved.run(ref.id, byName.length ? 'ambiguous-name' : 'unknown-method');
      stats.unresolved++;
    }
  }

  return stats;
}
