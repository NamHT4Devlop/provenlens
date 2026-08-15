/**
 * Java resolver.
 *
 * Turns raw call sites into graph edges. Everything here is best-effort and
 * every edge carries a confidence plus a `via` note explaining how it was
 * derived, so a wrong edge can be traced back rather than silently trusted.
 *
 *   1.0  direct     -- receiver type known, method found on it or a supertype
 *   0.9  interface->impl  -- receiver was an interface; linked to overrides
 *   0.5  unique-name      -- no type info, but exactly one method has that name
 */

const JAVA_LANG = new Set([
  'String', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Character', 'Byte',
  'Short', 'Object', 'System', 'Math', 'Exception', 'RuntimeException', 'Thread',
  'StringBuilder', 'Iterable', 'Comparable', 'Runnable', 'Class', 'Number',
]);

export function resolveJava(db) {
  // ---- load the world into memory (personal-scale repos fit comfortably) ----

  const files = db.prepare('SELECT id, path, pkg FROM files WHERE lang = ?').all('java');
  const fileById = new Map(files.map((f) => [f.id, f]));

  const importsByFile = new Map();
  for (const row of db.prepare('SELECT * FROM imports').all()) {
    if (!importsByFile.has(row.file_id)) importsByFile.set(row.file_id, []);
    importsByFile.get(row.file_id).push(row);
  }

  const types = new Map(); // fqn -> { fqn, symbol_id, kind, supertypes, file_id }
  for (const row of db
    .prepare(
      `SELECT t.fqn, t.symbol_id, t.kind, t.supertypes, s.file_id
         FROM types t
         JOIN symbols s ON s.id = t.symbol_id
         JOIN files f   ON f.id = s.file_id
        WHERE f.lang = 'java'`,
    )
    .all()) {
    types.set(row.fqn, { ...row, supertypes: JSON.parse(row.supertypes || '[]') });
  }

  const bySimpleName = new Map(); // "DonationService" -> [fqn, ...]
  for (const fqn of types.keys()) {
    const simple = fqn.split('.').pop();
    if (!bySimpleName.has(simple)) bySimpleName.set(simple, []);
    bySimpleName.get(simple).push(fqn);
  }

  const methodsByContainer = new Map(); // fqn -> [{id, name, arity, kind}]
  const fieldsByContainer = new Map(); // fqn -> Map(name -> type_name)
  for (const row of db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.arity, s.container_fqn, s.type_name, s.params
         FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE f.lang = 'java' AND s.kind IN ('method','constructor','field')`,
    )
    .all()) {
    if (!row.container_fqn) continue;
    if (row.kind === 'field') {
      if (!fieldsByContainer.has(row.container_fqn)) fieldsByContainer.set(row.container_fqn, new Map());
      fieldsByContainer.get(row.container_fqn).set(row.name, row.type_name);
    } else {
      if (!methodsByContainer.has(row.container_fqn)) methodsByContainer.set(row.container_fqn, []);
      methodsByContainer.get(row.container_fqn).push(row);
    }
  }

  const methodsByName = new Map(); // "findAll" -> [symbol rows]
  for (const list of methodsByContainer.values()) {
    for (const m of list) {
      if (!methodsByName.has(m.name)) methodsByName.set(m.name, []);
      methodsByName.get(m.name).push(m);
    }
  }

  const localsByScope = new Map(); // symbol_id -> Map(name -> type_name)
  for (const row of db.prepare('SELECT scope_symbol_id, name, type_name FROM locals').all()) {
    if (row.scope_symbol_id == null) continue;
    if (!localsByScope.has(row.scope_symbol_id)) localsByScope.set(row.scope_symbol_id, new Map());
    localsByScope.get(row.scope_symbol_id).set(row.name, row.type_name);
  }

  const symbolById = new Map();
  for (const row of db
    .prepare('SELECT id, name, kind, container_fqn, fqn, file_id FROM symbols')
    .all()) {
    symbolById.set(row.id, row);
  }

  // ---- name resolution -----------------------------------------------------

  /** Simple or scoped type name -> FQN of a type we actually indexed. */
  function resolveTypeName(name, fileId) {
    if (!name) return null;
    if (types.has(name)) return name;

    const simple = name.includes('.') ? name.split('.').pop() : name;

    for (const imp of importsByFile.get(fileId) ?? []) {
      if (!imp.is_wildcard && imp.simple === simple && types.has(imp.fqn)) return imp.fqn;
    }

    const pkg = fileById.get(fileId)?.pkg;
    if (pkg && types.has(`${pkg}.${simple}`)) return `${pkg}.${simple}`;

    for (const imp of importsByFile.get(fileId) ?? []) {
      if (imp.is_wildcard && types.has(`${imp.fqn}.${simple}`)) return `${imp.fqn}.${simple}`;
    }

    const candidates = bySimpleName.get(simple);
    if (candidates?.length === 1) return candidates[0];

    return null;
  }

  /** The type plus everything it extends/implements, nearest first. */
  function typeChain(fqn, seen = new Set()) {
    if (!fqn || seen.has(fqn)) return [];
    seen.add(fqn);
    const t = types.get(fqn);
    if (!t) return [];
    const chain = [t];
    for (const raw of t.supertypes) {
      const superFqn = resolveTypeName(raw, t.file_id);
      if (superFqn) chain.push(...typeChain(superFqn, seen));
    }
    return chain;
  }

  /** Reverse of typeChain: who implements/extends this type. */
  const subtypesOf = new Map();
  for (const t of types.values()) {
    for (const raw of t.supertypes) {
      const superFqn = resolveTypeName(raw, t.file_id);
      if (!superFqn) continue;
      if (!subtypesOf.has(superFqn)) subtypesOf.set(superFqn, []);
      subtypesOf.get(superFqn).push(t.fqn);
    }
  }

  /**
   * Types one argument token: `!String` is a literal typed at extraction time,
   * anything else is a variable name to look up in scope. Returns null when the
   * argument's type is genuinely unknown.
   */
  function argType(token, ref, enclosingFqn) {
    if (!token) return null;
    if (token.startsWith('!')) return token.slice(1);

    const local = localsByScope.get(ref.from_symbol_id)?.get(token);
    if (local) return local;

    for (const t of typeChain(enclosingFqn)) {
      const fieldType = fieldsByContainer.get(t.fqn)?.get(token);
      if (fieldType) return fieldType;
    }
    return null;
  }

  /**
   * Picks between same-arity overloads by comparing declared parameter types
   * against the argument types we could work out. Falls back to arity alone,
   * which is what the previous version did for every call.
   */
  function findMethod(typeFqn, name, arity, ref = null, enclosingFqn = null) {
    for (const t of typeChain(typeFqn)) {
      const candidates = (methodsByContainer.get(t.fqn) ?? []).filter((m) => m.name === name);
      if (!candidates.length) continue;

      const sameArity = candidates.filter((m) => m.arity === arity);
      if (sameArity.length <= 1) return sameArity[0] ?? candidates[0];

      const tokens = ref?.arg_types ? JSON.parse(ref.arg_types) : null;
      if (!tokens) return sameArity[0];

      const argTypes = tokens.map((token) => argType(token, ref, enclosingFqn));

      let best = null;
      let bestScore = -1;
      for (const candidate of sameArity) {
        const params = candidate.params ? JSON.parse(candidate.params) : [];
        let score = 0;
        for (const [i, want] of params.entries()) {
          const got = argTypes[i];
          if (!want || !got) continue;
          if (want === got) score += 2;
          // A resolved type matching by simple name still beats no match.
          else if (want.split('.').pop() === got.split('.').pop()) score += 1;
        }
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
      return best ?? sameArity[0];
    }
    return null;
  }

  /** Static type of a call receiver, or null when we genuinely cannot tell. */
  function receiverType(ref, fromSymbol) {
    const enclosing = fromSymbol?.container_fqn ?? null;
    const raw = ref.receiver;

    if (!raw || raw === 'this') return enclosing;

    if (raw === 'super') {
      const t = types.get(enclosing);
      const first = t?.supertypes?.[0];
      return first ? resolveTypeName(first, t.file_id) : null;
    }

    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(raw)) return undefined; // chained/complex

    const local = localsByScope.get(ref.from_symbol_id)?.get(raw);
    if (local) return resolveTypeName(local, ref.file_id);

    for (const t of typeChain(enclosing)) {
      const fieldType = fieldsByContainer.get(t.fqn)?.get(raw);
      if (fieldType) return resolveTypeName(fieldType, ref.file_id);
    }

    if (/^[A-Z]/.test(raw)) {
      if (JAVA_LANG.has(raw)) return undefined; // JDK type, deliberately out of scope
      return resolveTypeName(raw, ref.file_id);
    }

    return null;
  }

  // ---- write the graph ----------------------------------------------------

  // Scoped to this language: resolvers run one after another over a shared DB,
  // so a blanket DELETE would wipe the other languages' graphs.
  db.exec(`DELETE FROM edges WHERE from_symbol_id IN (
             SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.lang = 'java')`);
  db.exec(`DELETE FROM unresolved WHERE ref_id IN (
             SELECT r.id FROM refs r JOIN files f ON f.id = r.file_id WHERE f.lang = 'java')`);

  const insertEdge = db.prepare(
    `INSERT OR IGNORE INTO edges (from_symbol_id, to_symbol_id, kind, confidence, via, line)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertUnresolved = db.prepare(
    'INSERT OR IGNORE INTO unresolved (ref_id, reason) VALUES (?, ?)',
  );

  const stats = { direct: 0, viaImpl: 0, uniqueName: 0, unresolved: 0, inheritance: 0 };

  // Type-level inheritance edges first -- useful on their own.
  for (const t of types.values()) {
    for (const raw of t.supertypes) {
      const superFqn = resolveTypeName(raw, t.file_id);
      const target = superFqn && types.get(superFqn);
      if (!target) continue;
      const kind = target.kind === 'interface' ? 'implements' : 'extends';
      insertEdge.run(t.symbol_id, target.symbol_id, kind, 1.0, 'declaration', null);
      stats.inheritance++;
    }
  }

  const refs = db
    .prepare(`SELECT r.* FROM refs r JOIN files f ON f.id = r.file_id WHERE f.lang = 'java'`)
    .all();

  for (const ref of refs) {
    if (ref.from_symbol_id == null) {
      insertUnresolved.run(ref.id, 'no-enclosing-symbol');
      stats.unresolved++;
      continue;
    }
    const fromSymbol = symbolById.get(ref.from_symbol_id);

    if (ref.kind === 'new') {
      const typeFqn = resolveTypeName(ref.name, ref.file_id);
      const target = typeFqn && types.get(typeFqn);
      if (!target) {
        insertUnresolved.run(ref.id, 'unknown-type');
        stats.unresolved++;
        continue;
      }
      insertEdge.run(ref.from_symbol_id, target.symbol_id, 'instantiates', 1.0, 'direct', ref.line);
      const ctor = findMethod(
        typeFqn,
        typeFqn.split('.').pop(),
        ref.arity,
        ref,
        fromSymbol?.container_fqn,
      );
      if (ctor) insertEdge.run(ref.from_symbol_id, ctor.id, 'calls', 1.0, 'constructor', ref.line);
      stats.direct++;
      continue;
    }

    const recvType = receiverType(ref, fromSymbol);

    if (recvType === undefined) {
      insertUnresolved.run(ref.id, 'external-or-complex-receiver');
      stats.unresolved++;
      continue;
    }

    if (recvType) {
      const target = findMethod(recvType, ref.name, ref.arity, ref, fromSymbol?.container_fqn);
      if (target) {
        insertEdge.run(ref.from_symbol_id, target.id, 'calls', 1.0, 'direct', ref.line);
        stats.direct++;

        // Calling through an interface is the normal case in Spring; the real
        // work happens in the implementations, so link those too.
        const declaring = symbolById.get(target.id)?.container_fqn;
        if (types.get(declaring)?.kind === 'interface') {
          for (const subFqn of subtypesOf.get(declaring) ?? []) {
            const impl = findMethod(subFqn, ref.name, ref.arity, ref, fromSymbol?.container_fqn);
            if (impl && impl.id !== target.id) {
              insertEdge.run(ref.from_symbol_id, impl.id, 'calls', 0.9, 'interface->impl', ref.line);
              stats.viaImpl++;
            }
          }
        }
        continue;
      }
      insertUnresolved.run(ref.id, `no-such-method-on:${recvType}`);
      stats.unresolved++;
      continue;
    }

    const byName = methodsByName.get(ref.name) ?? [];
    const arityMatch = byName.filter((m) => m.arity === ref.arity);
    const pool = arityMatch.length ? arityMatch : byName;
    if (pool.length === 1) {
      insertEdge.run(ref.from_symbol_id, pool[0].id, 'calls', 0.5, 'unique-name', ref.line);
      stats.uniqueName++;
    } else {
      insertUnresolved.run(ref.id, pool.length ? 'ambiguous-name' : 'unknown-method');
      stats.unresolved++;
    }
  }

  return stats;
}
