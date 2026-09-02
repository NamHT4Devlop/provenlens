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

/**
 * Methods the language and the standard library give every value, reached on a
 * receiver whose type we could not work out. Like the JS list, this is an
 * assumption rather than a proof, and it is recorded under its own owner so it
 * can be discounted. A receiver whose type IS known resolves against that type
 * first, so a project method named `size` is never shadowed by this.
 */
const JAVA_RUNTIME = new Set([
  // java.lang.Object
  'equals', 'hashCode', 'toString', 'getClass', 'clone', 'notify', 'notifyAll', 'wait',
  // Collections and Optional
  'size', 'isEmpty', 'iterator', 'contains', 'containsKey', 'containsValue', 'keySet',
  'entrySet', 'putAll', 'addAll', 'removeAll', 'retainAll', 'toArray', 'isPresent',
  'isBlank', 'orElse', 'orElseGet', 'orElseThrow', 'ifPresent', 'ifPresentOrElse',
  // Streams
  'stream', 'collect', 'findFirst', 'findAny', 'anyMatch', 'allMatch', 'noneMatch',
  'flatMap', 'distinct', 'limit', 'skip', 'sorted', 'count', 'boxed', 'mapToInt',
  'mapToObj', 'mapToLong', 'joining', 'toList',
  // CompletableFuture
  'thenApply', 'thenAccept', 'thenRun', 'thenCompose', 'thenCombine', 'exceptionally',
  'whenComplete', 'join', 'complete', 'completeExceptionally',
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
      `SELECT t.fqn, t.symbol_id, t.kind, t.supertypes, s.file_id, s.modifiers,
              f.external AS isExternal, f.owner AS extOwner
         FROM types t
         JOIN symbols s ON s.id = t.symbol_id
         JOIN files f   ON f.id = s.file_id
        WHERE f.lang = 'java'`,
    )
    .all()) {
    types.set(row.fqn, { ...row, supertypes: JSON.parse(row.supertypes || '[]') });
  }

  /**
   * The type variables in scope at a declaration: its own, and every one it
   * is nested inside. `class Outer<T> { class Inner<U> }` puts both T and U in
   * scope for Inner.
   */
  const typeVarsByFqn = new Map();
  for (const [fqn, t] of types) {
    let modifiers = [];
    try {
      modifiers = JSON.parse(t.modifiers || '[]');
    } catch {
      modifiers = [];
    }
    const own = modifiers.filter((m) => String(m).startsWith('tp:')).map((m) => m.slice(3));
    if (own.length) typeVarsByFqn.set(fqn, new Set(own));
  }
  function isTypeVariable(name, enclosing) {
    if (name.includes('.') || !/^[A-Za-z_$][\w$]*$/.test(name)) return false;
    for (let scope = enclosing; scope; ) {
      if (typeVarsByFqn.get(scope)?.has(name)) return true;
      const dot = scope.lastIndexOf('.');
      scope = dot === -1 ? null : scope.slice(0, dot);
    }
    return false;
  }

  const bySimpleName = new Map(); // "DonationService" -> [fqn, ...]
  const externalBySimpleName = new Map(); // the same, for classpath types only
  for (const fqn of types.keys()) {
    const simple = fqn.split('.').pop();
    const target = types.get(fqn)?.isExternal ? externalBySimpleName : bySimpleName;
    if (!target.has(simple)) target.set(simple, []);
    target.get(simple).push(fqn);
  }

  const methodsByContainer = new Map(); // fqn -> [{id, name, arity, kind}]
  const fieldsByContainer = new Map(); // fqn -> Map(name -> type_name)
  const fieldElements = new Map(); // "fqn#field" -> its single generic argument
  for (const row of db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.arity, s.container_fqn, s.type_name, s.type_args, s.params,
              s.file_id, f.external AS isExternal, f.owner AS extOwner
         FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE f.lang = 'java' AND s.kind IN ('method','constructor','field')`,
    )
    .all()) {
    if (!row.container_fqn) continue;
    if (row.kind === 'field') {
      if (!fieldsByContainer.has(row.container_fqn)) fieldsByContainer.set(row.container_fqn, new Map());
      fieldsByContainer.get(row.container_fqn).set(row.name, row.type_name);
      fieldElements.set(`${row.container_fqn}#${row.name}`, row.type_args ?? null);
    } else {
      if (!methodsByContainer.has(row.container_fqn)) methodsByContainer.set(row.container_fqn, []);
      methodsByContainer.get(row.container_fqn).push(row);
    }
  }

  const methodsByName = new Map(); // "findAll" -> [symbol rows]
  for (const list of methodsByContainer.values()) {
    for (const m of list) {
      if (m.isExternal) continue;
      if (!methodsByName.has(m.name)) methodsByName.set(m.name, []);
      methodsByName.get(m.name).push(m);
    }
  }

  const localsByScope = new Map(); // symbol_id -> Map(name -> type_name)
  for (const row of db
    .prepare('SELECT scope_symbol_id, name, type_name, type_args, owner_ref_id, init_kind FROM locals')
    .all()) {
    if (row.scope_symbol_id == null) continue;
    if (!localsByScope.has(row.scope_symbol_id)) localsByScope.set(row.scope_symbol_id, new Map());
    // A lambda parameter has no declared type; it carries the call it belongs
    // to instead, and receiverType works the rest out.
    localsByScope.get(row.scope_symbol_id).set(row.name, {
      type: row.type_name,
      args: row.type_args,
      ownerRef: row.owner_ref_id,
      init: row.init_kind,
    });
  }

  const symbolById = new Map();
  for (const row of db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.container_fqn, s.fqn, s.file_id, s.type_args,
              f.external AS isExternal
         FROM symbols s JOIN files f ON f.id = s.file_id`,
    )
    .all()) {
    symbolById.set(row.id, row);
  }

  // ---- name resolution -----------------------------------------------------

  /**
   * Simple or scoped type name -> FQN of a type we actually indexed.
   *
   * `enclosing` is the type the name was written inside, which Java consults
   * before anything else: `Criteria` inside `OrderExample` means
   * `OrderExample.Criteria`. Without it the simple name is ambiguous across
   * every generated Example class in the repo, so it resolved to nothing --
   * 304 unknown-type misses in mall from that one omission.
   */
  function resolveTypeName(name, fileId, enclosing = null) {
    if (!name) return null;
    // A name the enclosing declaration introduced as a type variable is not a
    // class, however many classes share the spelling. Checked before anything
    // else, because a repository large enough has a real `C` somewhere and
    // finding it does not fail to resolve -- it resolves WRONG.
    if (enclosing && isTypeVariable(name, enclosing)) return null;
    if (types.has(name)) return name;

    const simple = name.includes('.') ? name.split('.').pop() : name;

    // Nested types, innermost scope first, exactly as javac searches.
    if (enclosing) {
      for (const scope of lexicalScope(enclosing)) {
        if (types.has(`${scope}.${simple}`)) return `${scope}.${simple}`;
        // An inner class can also name one inherited from the outer's parent.
        for (const t of typeChain(scope)) {
          if (types.has(`${t.fqn}.${simple}`)) return `${t.fqn}.${simple}`;
        }
      }
    }

    for (const imp of importsByFile.get(fileId) ?? []) {
      if (imp.is_wildcard || imp.simple !== simple) continue;
      if (types.has(imp.fqn)) return imp.fqn;
      // The file says outright which `Money` it means, and it is not one of
      // ours. Guessing on past that -- to a same-named class in some other
      // module of a monorepo -- does not fail to resolve, it resolves WRONG.
      return null;
    }

    const pkg = fileById.get(fileId)?.pkg;
    if (pkg && types.has(`${pkg}.${simple}`)) return `${pkg}.${simple}`;

    for (const imp of importsByFile.get(fileId) ?? []) {
      if (imp.is_wildcard && types.has(`${imp.fqn}.${simple}`)) return `${imp.fqn}.${simple}`;
    }

    // `Map.Entry` written as a nested name: the outer half is a name some
    // import does resolve, and the jar spells the pair with a dollar sign.
    if (name.includes('.') && !types.has(name)) {
      const parts = name.split('.');
      if (parts.length === 2 && /^[A-Z]/.test(parts[0]) && /^[A-Z]/.test(parts[1])) {
        const outer = resolveTypeName(parts[0], fileId, enclosing);
        if (outer && types.has(`${outer}$${parts[1]}`)) return `${outer}$${parts[1]}`;
        if (types.has(`java.util.${parts[0]}$${parts[1]}`)) {
          return `java.util.${parts[0]}$${parts[1]}`;
        }
      }
    }

    // `T`, `K`, `V`, `T2` are type variables by universal Java convention, and
    // a repository large enough will contain a real class by that name -- one
    // `enum T` nested in a quarkus test was answering for 2,383 type variables
    // across the whole project. Nested and imported lookups above still apply,
    // so a genuine `T` in scope is still found; only the whole-project search
    // by simple name is refused, because that is the one that reaches across
    // the repository to a class the code never named.
    if (/^[A-Z][0-9]?$/.test(simple)) return null;

    // This project's own types answer first: a classpath signature exists to
    // prove a call leaves the project, never to outvote a type it declares.
    const mine = (bySimpleName.get(simple) ?? []).filter((fqn) => !types.get(fqn)?.isExternal);
    if (mine.length === 1) return mine[0];
    if (mine.length > 1) return null;
    const candidates = bySimpleName.get(simple);
    if (candidates?.length === 1) return candidates[0];

    // Nothing this project declares carries the name, so a classpath type may.
    // `java.lang` first, because the language imports it whether or not the
    // file says so -- which is why `catch (Exception e)` had no type at all,
    // and every `e.getMessage()` on it went unresolved.
    if (types.has(`java.lang.${simple}`)) return `java.lang.${simple}`;
    const fromClasspath = externalBySimpleName.get(simple);
    if (fromClasspath?.length === 1) return fromClasspath[0];

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

  /**
   * A type together with the types it is nested inside, innermost first.
   *
   * An inner class can see the enclosing class's fields and methods, which is
   * exactly how a JUnit 5 @Nested test reaches the mocks declared on its outer
   * class. Without this, every such receiver looks untyped.
   */
  function lexicalScope(fqn) {
    const out = [];
    let current = fqn;
    while (current) {
      if (types.has(current)) out.push(current);
      const dot = current.lastIndexOf('.');
      if (dot === -1) break;
      current = current.slice(0, dot);
    }
    return out;
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
    if (local?.type) return local.type;

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
        // Declared types are stored whole; the generic part means nothing to
        // overload matching, which compares erased names.
        const params = (candidate.params ? JSON.parse(candidate.params) : []).map((t) =>
          typeof t === 'string' ? t.replace(/<.*$/, '').replace(/\[\s*\]/g, '').trim() : t,
        );
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

    // `new Ticket().setSeat(...)` -- a constructor needs no return type looked
    // up, it yields the thing it constructs.
    if (ref.kind === 'new') {
      const built = { type_name: ref.name, type_args: null };
      chainMemo.set(ref.id, built);
      return built;
    }

    const recv = receiverType(ref, fromSymbol, depth + 1);
    const result =
      typeof recv === 'string' && recv
        ? findMethod(recv, ref.name, ref.arity, ref, fromSymbol?.container_fqn)
        : null;

    chainMemo.set(ref.id, result);
    return result;
  }

  /**
   * What one element of this call's result is.
   *
   * Two sources, both written in the source rather than assumed. A declared
   * generic argument says it outright -- `Mono<User> find()` yields Users. And
   * a `Foo.class` argument says it for the generic APIs that take one:
   * `client.fetch(User.class, name)` is how a Java API asks for Foos back, and
   * the type is right there in the call.
   */
  function elementTypeOfRef(ref, depth) {
    if (!ref || depth > 6) return null;
    const fromSymbol = symbolById.get(ref.from_symbol_id);

    // `Foo.class` anywhere in the arguments, when Foo is a type we indexed.
    for (const token of JSON.parse(ref.arg_types || '[]')) {
      const cls = /^([A-Za-z_$][\w$.]*)\.class$/.exec(String(token ?? '').replace(/^!/, ''));
      if (!cls) continue;
      const hit = resolveTypeName(cls[1], ref.file_id, fromSymbol?.container_fqn ?? null);
      if (hit) return hit;
    }

    // Otherwise the callee's declared return type, if it names one element.
    const recv = receiverType(ref, fromSymbol, depth + 1);
    if (typeof recv !== 'string' || !recv) return null;
    const target = findMethod(recv, ref.name, ref.arity, ref, fromSymbol?.container_fqn);
    if (!target?.type_args) return null;

    const named = resolveTypeName(target.type_args, ref.file_id, fromSymbol?.container_fqn ?? null);
    if (named) return named;

    // `List<E>.stream()` is declared to return `Stream<E>` -- a type variable,
    // not a type. Substituting it properly means tracking type parameters
    // through the whole signature; what a container method does in practice is
    // pass its element along, so the receiver's element type is the answer.
    // Only for a name that looks like a variable: a real type that simply is
    // not indexed must stay unknown rather than borrow one.
    if (!/^[A-Z][0-9]?$/.test(target.type_args)) return null;
    if (ref.receiver_ref_id != null) {
      const inner = elementTypeOfRef(refById.get(ref.receiver_ref_id), depth + 1);
      if (inner) return inner;
    }
    const holder =
      localsByScope.get(ref.from_symbol_id)?.get(ref.receiver) ??
      fieldElementOf(fromSymbol?.container_fqn, ref.receiver);
    if (holder?.args) {
      return resolveTypeName(holder.args, ref.file_id, fromSymbol?.container_fqn ?? null);
    }
    return null;
  }

  /**
   * The type of a lambda parameter, from the call the lambda was handed to.
   *
   * `list.forEach(item -> ...)` gives the lambda an element of `list`, so the
   * answer is the element type of that call's RECEIVER -- not of the call
   * itself, which is what `forEach` returns.
   */
  function lambdaParamType(ownerRefId, depth) {
    if (depth > 6) return null;
    const owner = refById.get(ownerRefId);
    if (!owner) return null;

    // `simpleAttribute(User.class, user -> user.getSpec())` -- the type and
    // the lambda are arguments to the same call, and the first says what the
    // second receives. Checked before the receiver, being the nearer evidence.
    const from = symbolById.get(owner.from_symbol_id);
    for (const token of JSON.parse(owner.arg_types || '[]')) {
      const cls = /^([A-Za-z_$][\w$.]*)\.class$/.exec(String(token ?? '').replace(/^!/, ''));
      if (!cls) continue;
      const hit = resolveTypeName(cls[1], owner.file_id, from?.container_fqn ?? null);
      if (hit) return hit;
    }

    if (owner.receiver_ref_id != null) {
      const fromChain = elementTypeOfRef(refById.get(owner.receiver_ref_id), depth + 1);
      if (fromChain) return fromChain;
    }
    // `posts.forEach(p -> ...)` -- the receiver is a plain name, so its own
    // declared generic argument is the element type.
    const holder =
      localsByScope.get(owner.from_symbol_id)?.get(owner.receiver) ??
      fieldElementOf(symbolById.get(owner.from_symbol_id)?.container_fqn, owner.receiver);
    if (holder?.args) {
      const hit = resolveTypeName(holder.args, owner.file_id, symbolById.get(owner.from_symbol_id)?.container_fqn ?? null);
      if (hit) return hit;
    }

    // Last and most direct: the callee's own signature. `configure(Consumer<
    // ContainerOptions> c)` says outright what the lambda is handed, and a
    // functional parameter is the one with a single type argument.
    const recv = receiverType(owner, from, depth + 1);
    if (typeof recv === 'string' && recv) {
      const target = findMethod(recv, owner.name, owner.arity, owner, from?.container_fqn);
      const declared = JSON.parse(target?.params || 'null');
      if (Array.isArray(declared)) {
        const candidates = declared
          .map((d) => genericArgOfName(typeof d === 'string' ? d : d?.type))
          .filter(Boolean);
        if (candidates.length === 1) {
          const hit = resolveTypeName(candidates[0], owner.file_id, from?.container_fqn ?? null);
          if (hit) return hit;
        }
      }
      return null;
    }

    // The call itself goes into a library, so what it hands the lambda came
    // from there too -- the same inheritance proof, one argument along.
    if (recv && typeof recv === 'object' && recv.external !== undefined) {
      return { external: recv.external };
    }
    return null;
  }

  /** `Consumer<Options>` -> `Options`; nothing for a raw or multi-arg type. */
  function genericArgOfName(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const lt = raw.indexOf('<');
    if (lt === -1) return null;
    const inner = raw.slice(lt + 1, raw.lastIndexOf('>')).trim();
    if (!inner || inner.includes(',') || inner.includes('<') || inner === '?') return null;
    return inner.replace(/^\?\s+(?:extends|super)\s+/, '').trim() || null;
  }

  /** A field's element type, looked up through the enclosing type's chain. */
  function fieldElementOf(enclosingFqn, name) {
    if (!enclosingFqn || !name) return null;
    for (const t of typeChain(enclosingFqn)) {
      const args = fieldElements.get(`${t.fqn}#${name}`);
      if (args) return { type: fieldsByContainer.get(t.fqn)?.get(name) ?? null, args };
    }
    return null;
  }

  function receiverType(ref, fromSymbol, depth = 0) {
    const enclosing = fromSymbol?.container_fqn ?? null;
    let raw = ref.receiver;

    if (!raw || raw === 'this') return enclosing;

    // `repo.findAll().size()` -- carry the inner call's return type along.
    if (ref.receiver_ref_id != null) {
      const target = chainTarget(refById.get(ref.receiver_ref_id), depth);
      if (target?.type_name) {
        // Resolved against the file that DECLARED the method first: a caller
        // need not import the type it is handed back, and asking its imports
        // for a name it never mentions ends the chain one hop in.
        const hit =
          (target.file_id != null
            ? resolveTypeName(target.type_name, target.file_id, target.container_fqn)
            : null) ?? resolveTypeName(target.type_name, ref.file_id, enclosing);
        if (hit) return hit;
        const owner =
          (target.file_id != null ? externalOwner(target.type_name, target.file_id) : null) ??
          externalOwner(target.type_name, ref.file_id);
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

    // `context.getBean().config.timeout()` -- a path of declared fields. Each
    // hop reads a type rather than guessing at one, and is resolved against
    // the type that DECLARES the field, which need not be a name this file has
    // ever imported. Everything that was not a bare identifier or a single
    // `this.x` used to fall straight through to "complex" below.
    if (depth < 8 && /^(?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(raw)) {
      const segments = raw.split('.');
      let current = receiverType(
        { ...ref, receiver: segments[0], receiver_ref_id: null },
        fromSymbol,
        depth + 1,
      );
      for (let i = 1; i < segments.length; i++) {
        if (typeof current !== 'string' || !current) break;
        let fieldType = null;
        for (const t of typeChain(current)) {
          const hit = fieldsByContainer.get(t.fqn)?.get(segments[i]);
          if (hit) {
            fieldType = hit;
            break;
          }
        }
        if (!fieldType) {
          current = { complex: true };
          break;
        }
        const home = types.get(current)?.file_id ?? ref.file_id;
        const owner = externalOwner(fieldType, home);
        current =
          resolveTypeName(fieldType, home, current) ??
          resolveTypeName(fieldType, ref.file_id, enclosing) ??
          (owner ? { external: owner } : { complex: true });
      }
      if (current) return current;
    }

    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(raw)) {
      // A chain such as `view().name(...)` or `Foo.bar().baz()`. If the token
      // it starts from is itself a library call or type, so is the whole chain.
      // `new NotifyBuilder(ctx).whenDone(...)` starts from the constructed type.
      const head =
        /^new\s+([A-Za-z_$][\w$.]*)/.exec(raw)?.[1] ?? /^([A-Za-z_$][\w$]*)/.exec(raw)?.[1];
      if (head) {
        const inRepo = resolveTypeName(head, ref.file_id, enclosing);
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
      if (!local?.type) {
        // A lambda parameter: no declared type, but it holds one element of
        // whatever the call it was passed to is iterating over.
        const fromLambda = local?.ownerRef != null ? lambdaParamType(local.ownerRef, depth) : null;
        if (fromLambda) return fromLambda;
        // Otherwise a declared name we cannot type. Guessing from the bare
        // method name here would invent edges, so stop instead.
        return { complex: true };
      }
      const hit = resolveTypeName(local.type, ref.file_id, enclosing);
      if (hit) return hit;
      const owner = externalOwner(local.type, ref.file_id);
      return owner ? { external: owner } : null;
    }

    for (const scope of lexicalScope(enclosing)) {
      for (const t of typeChain(scope)) {
        const fieldType = fieldsByContainer.get(t.fqn)?.get(raw);
        if (!fieldType) continue;
        const hit = resolveTypeName(fieldType, ref.file_id, enclosing);
        if (hit) return hit;
        const owner = externalOwner(fieldType, ref.file_id);
        return owner ? { external: owner } : null;
      }
    }

    if (/^[A-Z]/.test(raw)) {
      const hit = resolveTypeName(raw, ref.file_id, enclosing);
      if (hit) return hit;
      const owner = externalOwner(raw, ref.file_id);
      return owner ? { external: owner } : { external: null };
    }

    return null;
  }

  // Loaded before anything walks a chain: receiverType follows receiver_ref_id
  // through this map, so an empty one silently turns every chained receiver
  // into "complex" -- which is exactly what used to happen to the inference
  // pass below, and with it every `var x = a.b().c()`.
  const refs = db
    .prepare(`SELECT r.* FROM refs r JOIN files f ON f.id = r.file_id
        WHERE f.lang = 'java' AND f.external = 0 AND r.kind != 'annotation'`)
    .all();
  for (const r of refs) refById.set(r.id, r);

  // `var manager = context.entityManager` names no type and calls nothing, so
  // there was nothing to infer from. The path is what declares it: one field
  // per segment. Runs first -- a path usually starts from something already
  // declared, and what it types can then carry a call below.
  {
    const updateLocal = db.prepare('UPDATE locals SET type_name = ? WHERE id = ?');
    const pathLocals = db
      .prepare(
        `SELECT l.id, l.file_id, l.scope_symbol_id, l.name, l.init_path
           FROM locals l JOIN files f ON f.id = l.file_id
          WHERE f.lang = 'java' AND l.type_name IS NULL AND l.init_kind = 'path'`,
      )
      .all();
    for (const local of pathLocals) {
      if (!local.init_path || local.scope_symbol_id == null) continue;
      const scope = symbolById.get(local.scope_symbol_id);
      const held = receiverType(
        {
          file_id: local.file_id,
          from_symbol_id: local.scope_symbol_id,
          receiver: local.init_path,
          receiver_ref_id: null,
        },
        scope,
        0,
      );
      if (typeof held !== 'string' || !held) continue;
      updateLocal.run(held, local.id);
      if (!localsByScope.has(local.scope_symbol_id)) {
        localsByScope.set(local.scope_symbol_id, new Map());
      }
      localsByScope.get(local.scope_symbol_id).set(local.name, {
        type: held,
        args: null,
        ownerRef: null,
        init: 'inferred',
      });
    }
  }

  // Return-type inference: `var builder = Foo.builder()` names no type, but the
  // method it calls declares what it returns. Runs before the main pass so
  // those locals can type their own receivers afterwards.
  {
    const pending = db
      .prepare(
        `SELECT l.id, l.scope_symbol_id, l.name, l.line
           FROM locals l JOIN files f ON f.id = l.file_id
          WHERE f.lang = 'java' AND l.type_name IS NULL AND l.init_kind = 'call'`,
      )
      .all();
    const updateLocal = db.prepare('UPDATE locals SET type_name = ? WHERE id = ?');
    const refAt = db.prepare(
      `SELECT * FROM refs WHERE from_symbol_id = ? AND line = ? AND kind = 'call'
        ORDER BY id DESC LIMIT 1`,
    );

    for (const local of pending) {
      const ref = refAt.get(local.scope_symbol_id, local.line);
      if (!ref) continue;
      const fromSymbol = symbolById.get(ref.from_symbol_id);
      const recv = receiverType(ref, fromSymbol, 0);
      if (typeof recv !== 'string' || !recv) continue;
      const target = findMethod(recv, ref.name, ref.arity, ref, fromSymbol?.container_fqn);
      if (!target?.type_name) continue;
      // Resolved in the file that DECLARED the method, not the one calling it:
      // a caller need not import the type it is handed back.
      const held =
        resolveTypeName(target.type_name, target.file_id, target.container_fqn) ?? target.type_name;
      updateLocal.run(held, local.id);
      if (!localsByScope.has(local.scope_symbol_id)) {
        localsByScope.set(local.scope_symbol_id, new Map());
      }
      localsByScope.get(local.scope_symbol_id).set(local.name, {
        type: held,
        args: target.type_args ?? null,
        ownerRef: null,
        init: 'inferred',
      });
    }
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
    notInProject: 0,
    outOfScope: 0,
    runtime: 0,
    inheritance: 0,
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
  /** A call into a library: expected, not a miss. */
  const insertExternal = (refId, owner) => {
    insertRow.run(refId, owner ? `external:${owner}` : 'external', 1, owner ?? null);
    refOutcome.set(refId, { external: true, owner });
    stats.external++;
  };
  /**
   * The called name is declared nowhere in the index, so the call cannot
   * target this project. Weaker than naming the library, but still a proof
   * rather than a guess -- recorded separately so it stays auditable.
   */
  /**
   * Every name the indexed Java declares, of any kind. A call to a name absent
   * from it provably cannot land here -- the proof that outranks a JDK guess.
   */
  // "Does THIS project declare that name?" -- the proof a call cannot land
  // here. A classpath signature must stay out of it: reading java.util.List
  // must not make `size` look like something this repository defines.
  const declaredNames = new Set();
  for (const row of symbolById.values()) if (!row.isExternal) declaredNames.add(row.name);

  const insertNotInProject = (refId) => {
    insertRow.run(refId, 'external:not-in-project', 1, null);
    refOutcome.set(refId, { external: true, owner: null });
    stats.external++;
    stats.notInProject++;
  };
  /**
   * A bare call reaches only what is in scope: the enclosing type and its
   * ancestors, a static import, a module-level function. Once all of those have
   * been tried, other methods in the project that happen to share the name are
   * not reachable from here, so the call comes from outside.
   */
  const insertOutOfScope = (refId) => {
    insertRow.run(refId, 'external:not-reachable-from-scope', 1, null);
    refOutcome.set(refId, { external: true, owner: null });
    stats.external++;
    stats.outOfScope++;
  };
  /**
   * A JDK method on an untyped receiver.
   *
   * Assumed only when it has to be: a name this repository declares nowhere
   * cannot be reached from it, and that is a proof, which outranks the guess.
   */
  const insertRuntime = (refId, name) => {
    if (name && !declaredNames.has(name)) return insertNotInProject(refId);
    insertRow.run(refId, 'external:jdk-runtime', 1, 'jdk-runtime');
    refOutcome.set(refId, { external: true, owner: 'jdk-runtime' });
    stats.external++;
    stats.runtime++;
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


  for (const ref of refs) {
    if (ref.from_symbol_id == null) {
      insertUnresolved(ref.id, 'no-enclosing-symbol');
      continue;
    }
    const fromSymbol = symbolById.get(ref.from_symbol_id);

    if (ref.kind === 'new') {
      const typeFqn = resolveTypeName(ref.name, ref.file_id, fromSymbol?.container_fqn ?? null);
      const target = typeFqn && types.get(typeFqn);
      if (target?.isExternal) {
        // Constructing a classpath type: the signature proves where it lives,
        // and nothing on the classpath is ever an edge target.
        insertExternal(ref.id, target.extOwner ?? externalOwner(ref.name, ref.file_id));
        continue;
      }
      if (!target) {
        const owner = externalOwner(ref.name, ref.file_id);
        if (owner) insertExternal(ref.id, owner);
        else if (!bySimpleName.has(ref.name)) insertNotInProject(ref.id);
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
      const carried = inheritedExternal(ref);
      if (!recv.complex) insertExternal(ref.id, recv.external);
      // However tangled the receiver is, a name declared nowhere in the index
      // cannot be a call into this project.
      else if (!methodsByName.has(ref.name)) insertNotInProject(ref.id);
      else if (carried !== undefined) insertExternal(ref.id, carried);
      else if (JAVA_RUNTIME.has(ref.name)) insertRuntime(ref.id, ref.name);
      else insertUnresolved(ref.id, 'complex-receiver-chain');
      continue;
    }

    const recvType = recv;
    // A receiver whose type is declared on the classpath cannot be calling
    // into this project, whatever the member turns out to be. The signature
    // proves it, where before the name only suggested it.
    if (typeof recvType === 'string' && types.get(recvType)?.isExternal) {
      insertExternal(ref.id, types.get(recvType).extOwner ?? null);
      continue;
    }
    if (recvType) {
      let target = findMethod(recvType, ref.name, ref.arity, ref, fromSymbol?.container_fqn);
      // Implicit `this` inside a nested class can also mean the outer class.
      if (!target && !ref.receiver) {
        for (const scope of lexicalScope(recvType).slice(1)) {
          target = findMethod(scope, ref.name, ref.arity, ref, fromSymbol?.container_fqn);
          if (target) break;
        }
      }
      if (target) {
        insertEdge.run(ref.from_symbol_id, target.id, 'calls', 1.0, 'direct', ref.line);
        refOutcome.set(ref.id, { external: false });
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
      // The type is known but the method is not on it. Three ways that can be
      // explained without guessing, in order of how much they tell us.
      const inherited = externalAncestor(recvType);
      if (inherited) {
        insertExternal(ref.id, inherited);
        continue;
      }
      // A bare call inside a class that declares no such method is usually a
      // static import: assertThat, status(), view() in a test.
      const imported = !ref.receiver ? staticImportOwner(ref.name, ref.file_id) : null;
      if (imported) {
        insertExternal(ref.id, imported);
        continue;
      }
      if (!methodsByName.has(ref.name)) {
        insertNotInProject(ref.id);
        continue;
      }
      // Implicit `this` with nothing on the type chain to match: whatever else
      // in the project carries this name is not reachable from here.
      if (!ref.receiver) {
        if (JAVA_RUNTIME.has(ref.name)) insertRuntime(ref.id, ref.name);
        else insertOutOfScope(ref.id);
        continue;
      }
      insertUnresolved(ref.id, `no-such-method-on:${recvType}`);
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
    if (!methodsByName.has(ref.name)) {
      insertNotInProject(ref.id);
      continue;
    }
    insertUnresolved(ref.id, 'unknown-method');
  }

  return stats;
}
