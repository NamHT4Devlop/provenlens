/**
 * Ruby resolver.
 *
 * Ruby gives far less to go on than Java, so confidences are lower across the
 * board and the tiers are explicit:
 *
 *   1.0  direct             -- receiver typed by `X.new` or an explicit constant
 *   0.8  rails-association  -- receiver typed through a generated association reader
 *   0.7  self-chain         -- implicit self, found on the class / superclass / mixin
 *   0.4  unique-name        -- no type info, exactly one method in the project matches
 *
 * Bare identifiers that match nothing are dropped rather than reported as
 * unresolved: most of them are local variable reads, not missed calls.
 */

/**
 * Kernel and Object methods. These are the one thing that cannot be discovered
 * from the source: they have no gem to point at and no ancestor to walk to,
 * because every object has them.
 */
const RUBY_CORE = new Set([
  'puts', 'print', 'p', 'pp', 'format', 'sprintf', 'raise', 'fail', 'require',
  'require_relative', 'loop', 'sleep', 'rand', 'srand', 'lambda', 'proc', 'catch',
  'throw', 'block_given?', 'binding', 'freeze', 'frozen?', 'dup', 'clone', 'send',
  'public_send', 'respond_to?', 'is_a?', 'kind_of?', 'instance_of?', 'nil?', 'tap',
  'then', 'itself', 'hash', 'object_id', 'inspect', 'to_s', 'to_i', 'to_f', 'to_a',
  'to_h', 'to_sym', 'to_proc', 'instance_variable_get', 'instance_variable_set',
  'define_method', 'method', 'methods', 'extend', 'display', 'exit', 'at_exit',
]);

export function resolveRuby(db) {
  const types = new Map(); // fqn -> { fqn, symbol_id, kind, supertypes, file_id }
  for (const row of db
    .prepare(
      `SELECT t.fqn, t.symbol_id, t.kind, t.supertypes, s.file_id
         FROM types t
         JOIN symbols s ON s.id = t.symbol_id
         JOIN files f   ON f.id = s.file_id
        WHERE f.lang = 'ruby' AND s.kind IN ('class', 'module')`,
    )
    .all()) {
    types.set(row.fqn, { ...row, supertypes: JSON.parse(row.supertypes || '[]') });
  }

  const bySimpleName = new Map();
  for (const fqn of types.keys()) {
    const simple = fqn.split('::').pop();
    if (!bySimpleName.has(simple)) bySimpleName.set(simple, []);
    bySimpleName.get(simple).push(fqn);
  }

  const membersByContainer = new Map(); // fqn -> [symbol rows]
  const typeIdByFqn = new Map();
  for (const row of db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.arity, s.container_fqn, s.type_name, s.modifiers, s.fqn
         FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE f.lang = 'ruby' AND s.kind IN ('method','class_method','class','module')`,
    )
    .all()) {
    if (row.kind === 'class' || row.kind === 'module') {
      typeIdByFqn.set(row.fqn, row.id);
      continue;
    }
    if (!row.container_fqn) continue;
    if (!membersByContainer.has(row.container_fqn)) membersByContainer.set(row.container_fqn, []);
    membersByContainer.get(row.container_fqn).push(row);
  }

  const methodsByName = new Map();
  for (const list of membersByContainer.values()) {
    for (const m of list) {
      if (!methodsByName.has(m.name)) methodsByName.set(m.name, []);
      methodsByName.get(m.name).push(m);
    }
  }

  const localsByScope = new Map();
  for (const row of db.prepare('SELECT scope_symbol_id, name, type_name FROM locals').all()) {
    if (row.scope_symbol_id == null) continue;
    if (!localsByScope.has(row.scope_symbol_id)) localsByScope.set(row.scope_symbol_id, new Map());
    localsByScope.get(row.scope_symbol_id).set(row.name, row.type_name);
  }

  const symbolById = new Map();
  for (const row of db
    .prepare('SELECT id, name, kind, container_fqn, fqn, modifiers FROM symbols')
    .all()) {
    symbolById.set(row.id, row);
  }

  /** Ruby constants live in one global namespace, so a simple name usually suffices. */
  function resolveTypeName(name) {
    if (!name) return null;
    const clean = name.trim();
    if (types.has(clean)) return clean;
    const simple = clean.split('::').pop();
    if (types.has(simple)) return simple;
    const candidates = bySimpleName.get(simple);
    return candidates?.length === 1 ? candidates[0] : null;
  }

  /** Class, then superclass, then anything mixed in with `include`. */
  function typeChain(fqn, seen = new Set()) {
    if (!fqn || seen.has(fqn)) return [];
    seen.add(fqn);
    const t = types.get(fqn);
    if (!t) return [];
    const chain = [t];
    for (const raw of t.supertypes) {
      const superFqn = resolveTypeName(raw);
      if (superFqn) chain.push(...typeChain(superFqn, seen));
    }
    return chain;
  }

  const subtypesOf = new Map();
  for (const t of types.values()) {
    for (const raw of t.supertypes) {
      const superFqn = resolveTypeName(raw);
      if (!superFqn) continue;
      if (!subtypesOf.has(superFqn)) subtypesOf.set(superFqn, []);
      subtypesOf.get(superFqn).push(t.fqn);
    }
  }

  /**
   * The first ancestor that is not indexed. Rails controllers inherit render
   * and redirect_to from ActionController::Base, which lives in a gem, so an
   * unknown bare call inside one is a gem call rather than a miss.
   */
  function externalAncestor(typeFqn) {
    for (const t of typeChain(typeFqn)) {
      for (const raw of t.supertypes) {
        if (resolveTypeName(raw)) continue;
        return raw;
      }
    }
    return null;
  }

  const refById = new Map();
  const chainMemo = new Map();

  /** Resolves an inner call in a chain so its return type can type the next. */
  function chainTarget(ref, depth) {
    if (!ref || depth > 8) return null;
    if (chainMemo.has(ref.id)) return chainMemo.get(ref.id);
    chainMemo.set(ref.id, null);

    const fromSymbol = symbolById.get(ref.from_symbol_id);
    const enclosingClassId = typeIdByFqn.get(fromSymbol?.container_fqn) ?? null;
    const info = receiverInfo(ref, fromSymbol, enclosingClassId, depth + 1);
    const result = info?.type
      ? (findMember(info.type, ref.name, info.classMethod) ??
         findMember(info.type, ref.name, !info.classMethod))
      : null;
    chainMemo.set(ref.id, result);
    return result;
  }

  function findMember(typeFqn, name, wantClassMethod) {
    for (const t of typeChain(typeFqn)) {
      const hit = (membersByContainer.get(t.fqn) ?? []).find(
        (m) => m.name === name && (wantClassMethod ? m.kind === 'class_method' : m.kind === 'method'),
      );
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Returns { type, via } or null (unknown) / undefined (external, stop trying).
   */
  function receiverInfo(ref, fromSymbol, enclosingClassId, depth = 0) {
    const enclosing = fromSymbol?.container_fqn ?? null;
    const raw = ref.receiver;

    // `donor.donations.first` -- carry the inner call's declared type forward.
    if (ref.receiver_ref_id != null) {
      const target = chainTarget(refById.get(ref.receiver_ref_id), depth);
      if (target?.type_name) {
        const t = resolveTypeName(target.type_name);
        if (t) return { type: t, via: 'rails-association' };
      }
    }

    if (!raw || raw === 'self') {
      const isSingleton = JSON.parse(fromSymbol?.modifiers || '[]').includes('singleton');
      return { type: enclosing, via: 'self-chain', classMethod: isSingleton && !!raw };
    }

    // `new(a, b).record` inside a class method -- the idiomatic Ruby service object.
    if (/^new\b/.test(raw)) return { type: enclosing, via: 'direct' };

    if (/^[A-Z]/.test(raw) && /^[\w:]+$/.test(raw)) {
      const t = resolveTypeName(raw);
      // An unknown constant is a gem: Rails, Time, ActiveRecord.
      return t ? { type: t, via: 'direct', classMethod: true } : { external: raw.split('::')[0] };
    }

    if (!/^@?[a-z_][\w]*[?!]?$/i.test(raw)) {
      const head = /^([A-Z][\w]*)/.exec(raw)?.[1];
      if (head && !resolveTypeName(head)) return { external: head };
      return undefined; // genuinely chained or complex
    }

    const local = localsByScope.get(ref.from_symbol_id)?.get(raw);
    if (local) return { type: resolveTypeName(local), via: 'direct' };

    const ivar = enclosingClassId != null ? localsByScope.get(enclosingClassId)?.get(raw) : null;
    if (ivar) return { type: resolveTypeName(ivar), via: 'direct' };

    // The Rails payoff: `donor.name` where `donor` is a belongs_to reader.
    const reader = findMember(enclosing, raw, false);
    if (reader?.type_name) {
      const isGenerated = JSON.parse(reader.modifiers || '[]').includes('generated');
      const t = resolveTypeName(reader.type_name);
      if (t) return { type: t, via: isGenerated ? 'rails-association' : 'direct' };
    }

    return null;
  }

  const CONFIDENCE = {
    direct: 1.0,
    'rails-association': 0.8,
    'self-chain': 0.7,
    'unique-name': 0.4,
  };

  db.exec(`DELETE FROM edges WHERE from_symbol_id IN (
             SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.lang = 'ruby')`);
  db.exec(`DELETE FROM unresolved WHERE ref_id IN (
             SELECT r.id FROM refs r JOIN files f ON f.id = r.file_id WHERE f.lang = 'ruby')`);

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
    dropped: 0,
  };
  const insertUnresolved = (refId, reason) => {
    insertRow.run(refId, reason, 0, null);
    stats.unresolved++;
  };
  /** A call into a gem or Ruby core: expected, not a miss. */
  const insertExternal = (refId, owner) => {
    insertRow.run(refId, owner ? `external:${owner}` : 'external', 1, owner ?? null);
    stats.external++;
  };

  for (const t of types.values()) {
    for (const raw of t.supertypes) {
      const superFqn = resolveTypeName(raw);
      const target = superFqn && types.get(superFqn);
      if (!target) continue;
      insertEdge.run(
        t.symbol_id,
        target.symbol_id,
        target.kind === 'module' ? 'includes' : 'extends',
        1.0,
        'declaration',
        null,
      );
      stats.inheritance++;
    }
  }

  const refs = db
    .prepare(
      `SELECT r.* FROM refs r JOIN files f ON f.id = r.file_id
        WHERE f.lang = 'ruby' AND r.kind != 'annotation'`,
    )
    .all();
  for (const r of refs) refById.set(r.id, r);

  for (const ref of refs) {
    if (ref.from_symbol_id == null) {
      if (ref.kind !== 'ident_call') insertUnresolved(ref.id, 'no-enclosing-symbol');
      else stats.dropped++;
      continue;
    }

    const fromSymbol = symbolById.get(ref.from_symbol_id);
    const enclosingClassId = typeIdByFqn.get(fromSymbol?.container_fqn) ?? null;

    // Bare `new(...)` inside a class method instantiates the enclosing class.
    if (ref.kind === 'call' && ref.name === 'new' && !ref.receiver) {
      const enclosing = fromSymbol?.container_fqn;
      const target = enclosing && types.get(enclosing);
      if (target) {
        insertEdge.run(ref.from_symbol_id, target.symbol_id, 'instantiates', 1.0, 'direct', ref.line);
        const init = findMember(enclosing, 'initialize', false);
        if (init) insertEdge.run(ref.from_symbol_id, init.id, 'calls', 1.0, 'constructor', ref.line);
        stats.direct++;
        continue;
      }
    }

    if (ref.kind === 'new') {
      const typeFqn = resolveTypeName(ref.receiver);
      const target = typeFqn && types.get(typeFqn);
      if (!target) {
        insertExternal(ref.id, (ref.receiver ?? '').split('::')[0] || null);
        continue;
      }
      insertEdge.run(ref.from_symbol_id, target.symbol_id, 'instantiates', 1.0, 'direct', ref.line);
      const init = findMember(typeFqn, 'initialize', false);
      if (init) insertEdge.run(ref.from_symbol_id, init.id, 'calls', 1.0, 'constructor', ref.line);
      stats.direct++;
      continue;
    }

    const info = receiverInfo(ref, fromSymbol, enclosingClassId);

    if (info?.external) {
      insertExternal(ref.id, info.external);
      continue;
    }

    if (info === undefined) {
      if (ref.kind === 'ident_call') stats.dropped++;
      else insertUnresolved(ref.id, 'complex-receiver-chain');
      continue;
    }

    if (info?.type) {
      const target =
        findMember(info.type, ref.name, info.classMethod) ??
        findMember(info.type, ref.name, !info.classMethod);

      if (target) {
        const confidence = CONFIDENCE[info.via] ?? 0.5;
        insertEdge.run(ref.from_symbol_id, target.id, 'calls', confidence, info.via, ref.line);
        if (info.via === 'rails-association') stats.viaImpl++;
        else stats.direct++;

        // A call landing on a module method may really run in any includer.
        const declaring = symbolById.get(target.id)?.container_fqn;
        if (types.get(declaring)?.kind === 'module') {
          for (const subFqn of subtypesOf.get(declaring) ?? []) {
            const impl = findMember(subFqn, ref.name, info.classMethod);
            if (impl && impl.id !== target.id) {
              insertEdge.run(ref.from_symbol_id, impl.id, 'calls', 0.7, 'module->includer', ref.line);
              stats.viaImpl++;
            }
          }
        }
        continue;
      }

      // Type known, method absent: it comes from a gem ancestor such as
      // ActiveRecord::Base, which is where `all` and `sum` actually live.
      // Bare identifiers are excluded: most are local reads, not calls.
      const inherited = ref.kind === 'ident_call' ? null : externalAncestor(info.type);
      if (inherited) {
        insertExternal(ref.id, inherited);
        continue;
      }
    }

    const byName = methodsByName.get(ref.name) ?? [];
    if (byName.length === 1) {
      insertEdge.run(ref.from_symbol_id, byName[0].id, 'calls', 0.4, 'unique-name', ref.line);
      stats.uniqueName++;
    } else if (ref.kind === 'ident_call') {
      stats.dropped++; // almost certainly a local variable read
    } else if (byName.length) {
      insertUnresolved(ref.id, 'ambiguous-name');
    } else {
      if (!ref.receiver && RUBY_CORE.has(ref.name)) {
        insertExternal(ref.id, 'Kernel');
        continue;
      }
      // Inherited from a gem base class: render, validates, it, expect.
      // A call written in a class body belongs to that class, so its own fqn
      // is the place to start walking from.
      const owner =
        fromSymbol && ['class', 'module'].includes(fromSymbol.kind)
          ? fromSymbol.fqn
          : fromSymbol?.container_fqn;
      const inherited = !ref.receiver ? externalAncestor(owner) : null;
      if (inherited) insertExternal(ref.id, inherited);
      else insertUnresolved(ref.id, 'unknown-method');
    }
  }

  return stats;
}
