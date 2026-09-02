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
import { classify } from '../extract/ruby.js';

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
  for (const row of db.prepare('SELECT scope_symbol_id, name, type_name, init_kind FROM locals').all()) {
    if (row.scope_symbol_id == null) continue;
    if (!localsByScope.has(row.scope_symbol_id)) localsByScope.set(row.scope_symbol_id, new Map());
    localsByScope.get(row.scope_symbol_id).set(row.name, {
      type: row.type_name,
      init: row.init_kind,
    });
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

    // `X.new` is the one call whose result type needs no signature: the
    // constructor returns an X. This is what lets `X.new.method` resolve.
    if (ref.kind === 'new' && ref.receiver) {
      const constructed = { type_name: ref.receiver, constructed: true };
      chainMemo.set(ref.id, constructed);
      return constructed;
    }

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
   * What a recorded local is worth as a receiver type.
   *
   * `X.new` and a factory both say outright what they build. A finder --
   * `Rubygem.find(id)` -- only holds if Rubygem really is a record, which the
   * ancestry says: a plain PORO with a `find` of its own would return anything
   * at all, and assuming otherwise would invent edges.
   */
  function localType(local) {
    const fqn = resolveTypeName(local.type);
    if (!fqn) return null;
    if (local.init === 'finder' && !isRecord(fqn)) return null;
    const via = local.init === 'factory' || local.init === 'finder' ? 'rails-association' : 'direct';
    return { type: fqn, via };
  }

  /** Does this class descend from ActiveRecord, as the source declares it? */
  const recordMemo = new Map();
  function isRecord(fqn) {
    if (recordMemo.has(fqn)) return recordMemo.get(fqn);
    recordMemo.set(fqn, false);
    const chain = typeChain(fqn);
    const named = chain.some((t) =>
      (t.supertypes ?? []).some((sup) => /ApplicationRecord|ActiveRecord::Base|ActiveModel/.test(sup)),
    );
    // An unindexed ancestor is the usual case: ApplicationRecord itself lives
    // in the app, but its parent does not.
    const answer = named || chain.some((t) => t.fqn === 'ApplicationRecord');
    recordMemo.set(fqn, answer);
    return answer;
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
        // A constructed receiver is a certainty; an association reader is an
        // inference, and the confidence table treats them accordingly.
        if (t) return { type: t, via: target.constructed ? 'direct' : 'rails-association' };
      }
    }

    // `super` means the method of this name one step further up. Answering
    // with the enclosing class would find the method we are standing in and
    // link it to itself.
    if (raw === 'super') {
      for (const t of typeChain(enclosing).slice(1)) {
        if ((membersByContainer.get(t.fqn) ?? []).some((m) => m.name === ref.name)) {
          return { type: t.fqn, via: 'super' };
        }
      }
      // No ancestor in this repository declares it, so `super` leaves the
      // repository -- Ruby always has one more ancestor, and eventually
      // Object. Named outright rather than returned as "unknown", because
      // unknown falls through to a by-name search that can find the same
      // method name on an unrelated class and report a miss against it.
      // 24 of devise's 31 super calls landed there.
      const outside = enclosing ? externalAncestor(enclosing) : null;
      return { external: outside ?? 'ancestor' };
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

    const local =
      localsByScope.get(ref.from_symbol_id)?.get(raw) ??
      (enclosingClassId != null ? localsByScope.get(enclosingClassId)?.get(raw) : null);
    if (local) {
      const typed = localType(local);
      if (typed) return typed;
    }

    // The Rails payoff: `donor.name` where `donor` is a belongs_to reader.
    const reader = findMember(enclosing, raw, false);
    if (reader?.type_name) {
      const isGenerated = JSON.parse(reader.modifiers || '[]').includes('generated');
      const t = resolveTypeName(reader.type_name);
      if (t) return { type: t, via: isGenerated ? 'rails-association' : 'direct' };
    }

    // Rails names a variable after the model it holds, and this is the last
    // evidence left once every declaration has been searched. It is a
    // convention, not a proof, so it is accepted only when the class it names
    // actually declares the member being called -- `user.account` needs a User
    // with an `account` on it. That constraint is what keeps it from inventing
    // edges: a guess that has to survive a member lookup is a narrow guess.
    const byConvention = resolveTypeName(classify(raw.replace(/^@/, '')));
    if (byConvention && isRecord(byConvention) && findMember(byConvention, ref.name, false)) {
      return { type: byConvention, via: 'name-convention' };
    }

    // The receiver itself is declared nowhere in this repository -- not a
    // local, not a parameter, not a block variable, not a method on anything
    // indexed. Then whatever it holds was not made here, so the call on it
    // cannot land here either. `response.body` in a request spec is the shape:
    // `response` comes from ActionDispatch, so `body` does too.
    //
    // This is the same proof the resolver already applies to a called name,
    // moved one step left to the receiver. It needs every binding form to be
    // recorded, which is why parameters and plain assignments are locals now:
    // without them this would fire on `def deliver(donor)` and be wrong.
    if (!local && !reader && !methodsByName.has(raw)) {
      return { external: null };
    }

    return null;
  }

  const CONFIDENCE = {
    direct: 1.0,
    'rails-association': 0.8,
    'self-chain': 0.7,
    // A variable named after its model: usual in Rails, never certain.
    'name-convention': 0.5,
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
    notInProject: 0,
    outOfScope: 0,
    inheritance: 0,
    dropped: 0,
  };
  const refOutcome = new Map();
  /**
   * What each ref resolved to, so a chain can inherit it. If `a.b()` returned
   * something from a library, `.c()` on that result is a library call too --
   * a proof, not a guess. Refs are inserted receiver-first, so the inner link
   * is always decided before the outer one is examined.
   */
  const inheritedExternal = (ref) => {
    if (ref.receiver_ref_id == null) return undefined;
    const inner = refOutcome.get(ref.receiver_ref_id);
    return inner?.external ? (inner.owner ?? null) : undefined;
  };

  const insertUnresolved = (refId, reason) => {
    insertRow.run(refId, reason, 0, null);
    refOutcome.set(refId, { external: false });
    stats.unresolved++;
  };
  /** A call into a gem or Ruby core: expected, not a miss. */
  const insertExternal = (refId, owner) => {
    insertRow.run(refId, owner ? `external:${owner}` : 'external', 1, owner ?? null);
    refOutcome.set(refId, { external: true, owner });
    stats.external++;
  };
  /**
   * The called name is declared nowhere in the index, so it cannot be a call
   * into this project. Ruby leans on this hardest: an RSpec spec file is almost
   * entirely `expect`, `it`, `let` and friends, none of which the app defines.
   */
  const insertNotInProject = (refId) => {
    insertRow.run(refId, 'external:not-in-project', 1, null);
    refOutcome.set(refId, { external: true, owner: null });
    stats.external++;
    stats.notInProject++;
  };
  /**
   * A bare call reaches `self` and nothing else. If the name is not on the
   * enclosing class, its superclasses or its mixins, then the methods elsewhere
   * in the project that happen to share the name are not in scope here, so it
   * must come from outside -- an RSpec `expect`, a gem DSL, a Rails macro.
   *
   * Matching such a call against every method in the project regardless of
   * scope is what produced most of the remaining ambiguity, and any edge it
   * created was wrong.
   */
  const insertOutOfScope = (refId) => {
    insertRow.run(refId, 'external:not-reachable-from-scope', 1, null);
    refOutcome.set(refId, { external: true, owner: null });
    stats.external++;
    stats.outOfScope++;
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
      const carried = inheritedExternal(ref);
      if (ref.kind === 'ident_call') stats.dropped++;
      else if (!methodsByName.has(ref.name)) insertNotInProject(ref.id);
      else if (carried !== undefined) insertExternal(ref.id, carried);
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

      // Ruby only reaches method_missing after the whole ancestor chain has
      // failed, which is exactly the point this code has reached: the type is
      // known, no member matches, and no unindexed ancestor could hold it. A
      // class that defines method_missing is declaring that such calls are its
      // API, so the honest edge is to the interceptor -- at low confidence,
      // because what it does with the name is its own business.
      if (ref.kind !== 'ident_call') {
        const interceptor = findMember(info.type, 'method_missing', false);
        if (interceptor) {
          insertEdge.run(ref.from_symbol_id, interceptor.id, 'calls', 0.4, 'method-missing', ref.line);
          stats.uniqueName++;
          continue;
        }
      }
    }

    // A bare call reaches `self`. Everything self could offer has been tried by
    // now: the class, its ancestors, its mixins, Kernel. Whatever else in the
    // project shares this name is simply not in scope here. This is the common
    // case in a spec file, where `expect`, `it` and `context` come from RSpec.
    if (!ref.receiver) {
      // A bare identifier is either a local read or a self call. Either way,
      // by this point self has been searched, so a global name match could only
      // land on something out of scope -- always the wrong edge.
      if (ref.kind === 'ident_call') {
        stats.dropped++;
        continue;
      }
      // Proof first: a name this repository declares nowhere cannot be
      // reached from here, and that beats guessing at Kernel.
      if (!methodsByName.has(ref.name)) insertNotInProject(ref.id);
      else if (RUBY_CORE.has(ref.name)) insertExternal(ref.id, 'Kernel');
      else insertOutOfScope(ref.id);
      continue;
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
      if (!ref.receiver && RUBY_CORE.has(ref.name) && methodsByName.has(ref.name)) {
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
      else if (!methodsByName.has(ref.name)) insertNotInProject(ref.id);
      else insertUnresolved(ref.id, 'unknown-method');
    }
  }

  return stats;
}
