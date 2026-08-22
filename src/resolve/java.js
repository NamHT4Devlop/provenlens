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

  /**
   * Names the library a type belongs to, or null if it might be in this repo.
   *
   * The evidence is already in the file: an import whose FQN is not among the
   * indexed types can only come from a JAR. This needs no list of frameworks,
   * so it works for whatever the project happens to depend on.
   */
  function externalOwner(typeName, fileId) {
    if (!typeName) return null;
    const simple = typeName.includes('.') ? typeName.split('.').pop() : typeName;

    for (const imp of importsByFile.get(fileId) ?? []) {
      if (imp.is_wildcard || imp.simple !== simple) continue;
      if (types.has(imp.fqn)) return null; // indexed after all
      return imp.fqn.split('.').slice(0, 3).join('.');
    }
    if (JAVA_LANG.has(simple)) return 'java.lang';
    if (typeName.startsWith('java.') || typeName.startsWith('javax.')) {
      return typeName.split('.').slice(0, 2).join('.');
    }
    return null;
  }

  /**
   * The first supertype in a chain that is not indexed. When a call cannot be
   * found on a type, an unindexed ancestor is almost always where it lives --
   * `extends RouteBuilder` gives Camel's from(), `extends JpaRepository` gives
   * findById(), `extends ActionController::Base` gives render().
   */
  function externalAncestor(typeFqn) {
    for (const t of typeChain(typeFqn)) {
      for (const raw of t.supertypes) {
        if (resolveTypeName(raw, t.file_id)) continue;
        return externalOwner(raw, t.file_id) ?? raw;
      }
    }
    return null;
  }

  /**
   * Static type of a call receiver.
   *   string    -> resolved type FQN
   *   {external}-> provably a library call, with the owner named where possible
   *   null      -> unknown
   */
  /** `import static org.assertj...Assertions.assertThat` -> the owning library. */
  function staticImportOwner(methodName, fileId) {
    let wildcard = null;
    for (const imp of importsByFile.get(fileId) ?? []) {
      if (!imp.is_static) continue;
      if (!imp.is_wildcard && imp.simple === methodName) {
        return imp.fqn.split('.').slice(0, 3).join('.');
      }
      if (imp.is_wildcard) wildcard ??= imp.fqn.split('.').slice(0, 3).join('.');
    }
    // A wildcard static import is the usual source of an otherwise unknown
    // bare call in a test: assertThat, status(), view(), post().
    return wildcard;
  }

  const refById = new Map();
  const chainMemo = new Map();

  /**
   * The method an inner call in a chain resolves to, so its declared return
   * type can become the next receiver. Memoised, depth-limited, and seeded with
   * null before recursing so a cyclic chain cannot spin.
   */
  function chainTarget(ref, depth) {
    if (!ref || depth > 8) return null;
    if (chainMemo.has(ref.id)) return chainMemo.get(ref.id);
    chainMemo.set(ref.id, null);

    const fromSymbol = symbolById.get(ref.from_symbol_id);
    const recv = receiverType(ref, fromSymbol, depth + 1);
    const result =
      typeof recv === 'string' && recv
        ? findMethod(recv, ref.name, ref.arity, ref, fromSymbol?.container_fqn)
        : null;

    chainMemo.set(ref.id, result);
    return result;
  }

  function receiverType(ref, fromSymbol, depth = 0) {
    const enclosing = fromSymbol?.container_fqn ?? null;
    let raw = ref.receiver;

    if (!raw || raw === 'this') return enclosing;

    // `repo.findAll().size()` -- carry the inner call's return type along.
    if (ref.receiver_ref_id != null) {
      const target = chainTarget(refById.get(ref.receiver_ref_id), depth);
      if (target?.type_name) {
        const hit = resolveTypeName(target.type_name, ref.file_id);
        if (hit) return hit;
        const owner = externalOwner(target.type_name, ref.file_id);
        if (owner) return { external: owner };
      }
    }

    // `this.repository.save(...)` is ordinary Java; treat it as the field.
    const thisField = /^this\.([A-Za-z_$][\w$]*)$/.exec(raw);
    if (thisField) raw = thisField[1];

    if (raw === 'super') {
      const t = types.get(enclosing);
      const first = t?.supertypes?.[0];
      if (!first) return null;
      return (
        resolveTypeName(first, t.file_id) ?? { external: externalOwner(first, t.file_id) ?? first }
      );
    }

    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(raw)) {
      // A chain such as `view().name(...)` or `Foo.bar().baz()`. If the token
      // it starts from is itself a library call or type, so is the whole chain.
      // `new NotifyBuilder(ctx).whenDone(...)` starts from the constructed type.
      const head =
        /^new\s+([A-Za-z_$][\w$.]*)/.exec(raw)?.[1] ?? /^([A-Za-z_$][\w$]*)/.exec(raw)?.[1];
      if (head) {
        const inRepo = resolveTypeName(head, ref.file_id);
        if (!inRepo) {
          const owner = externalOwner(head, ref.file_id) ?? staticImportOwner(head, ref.file_id);
          if (owner) return { external: owner };
        }
      }
      return { complex: true };
    }

    const scope = localsByScope.get(ref.from_symbol_id);
    if (scope?.has(raw)) {
      const local = scope.get(raw);
      // A declared name with no type -- a lambda parameter. Guessing from the
      // bare method name here would invent edges, so stop instead.
      if (!local) return { complex: true };
      const hit = resolveTypeName(local, ref.file_id);
      if (hit) return hit;
      const owner = externalOwner(local, ref.file_id);
      return owner ? { external: owner } : null;
    }

    for (const t of typeChain(enclosing)) {
      const fieldType = fieldsByContainer.get(t.fqn)?.get(raw);
      if (!fieldType) continue;
      const hit = resolveTypeName(fieldType, ref.file_id);
      if (hit) return hit;
      const owner = externalOwner(fieldType, ref.file_id);
      return owner ? { external: owner } : null;
    }

    if (/^[A-Z]/.test(raw)) {
      const hit = resolveTypeName(raw, ref.file_id);
      if (hit) return hit;
      const owner = externalOwner(raw, ref.file_id);
      return owner ? { external: owner } : { external: null };
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
  const insertRow = db.prepare(
    'INSERT OR IGNORE INTO unresolved (ref_id, reason, external, owner) VALUES (?, ?, ?, ?)',
  );
  const stats = {
    direct: 0,
    viaImpl: 0,
    uniqueName: 0,
    unresolved: 0,
    external: 0,
    inheritance: 0,
  };

  const insertUnresolved = (refId, reason) => {
    insertRow.run(refId, reason, 0, null);
    stats.unresolved++;
  };
  /** A call into a library: expected, not a miss. */
  const insertExternal = (refId, owner) => {
    insertRow.run(refId, owner ? `external:${owner}` : 'external', 1, owner ?? null);
    stats.external++;
  };

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
    .prepare(`SELECT r.* FROM refs r JOIN files f ON f.id = r.file_id
        WHERE f.lang = 'java' AND r.kind != 'annotation'`)
    .all();
  for (const r of refs) refById.set(r.id, r);

  for (const ref of refs) {
    if (ref.from_symbol_id == null) {
      insertUnresolved(ref.id, 'no-enclosing-symbol');
      continue;
    }
    const fromSymbol = symbolById.get(ref.from_symbol_id);

    if (ref.kind === 'new') {
      const typeFqn = resolveTypeName(ref.name, ref.file_id);
      const target = typeFqn && types.get(typeFqn);
      if (!target) {
        const owner = externalOwner(ref.name, ref.file_id);
        if (owner) insertExternal(ref.id, owner);
        else insertUnresolved(ref.id, 'unknown-type');
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

    const recv = receiverType(ref, fromSymbol, 0);

    if (recv && typeof recv === 'object') {
      if (recv.complex) insertUnresolved(ref.id, 'complex-receiver-chain');
      else insertExternal(ref.id, recv.external);
      continue;
    }

    const recvType = recv;
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
      // The type is known but the method is not on it, so it comes from an
      // ancestor we never indexed -- JpaRepository#findById, RouteBuilder#from.
      const inherited = externalAncestor(recvType);
      if (inherited) insertExternal(ref.id, inherited);
      else insertUnresolved(ref.id, `no-such-method-on:${recvType}`);
      continue;
    }

    const byName = methodsByName.get(ref.name) ?? [];
    const arityMatch = byName.filter((m) => m.arity === ref.arity);
    const pool = arityMatch.length ? arityMatch : byName;
    if (pool.length === 1) {
      insertEdge.run(ref.from_symbol_id, pool[0].id, 'calls', 0.5, 'unique-name', ref.line);
      stats.uniqueName++;
      continue;
    }
    if (pool.length > 1) {
      insertUnresolved(ref.id, 'ambiguous-name');
      continue;
    }

    // A bare call that exists nowhere in the repo came from outside it: either
    // statically imported, or inherited from a library base class -- which is
    // exactly what Camel's from() and AssertJ's assertThat() are.
    if (!ref.receiver) {
      const owner =
        staticImportOwner(ref.name, ref.file_id) ?? externalAncestor(fromSymbol?.container_fqn);
      if (owner) {
        insertExternal(ref.id, owner);
        continue;
      }
    }
    insertUnresolved(ref.id, 'unknown-method');
  }

  return stats;
}
