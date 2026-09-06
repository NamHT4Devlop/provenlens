/**
 * Java extractor.
 *
 * Walks the tree-sitter AST and produces flat records. Nothing here resolves
 * anything across files -- that is the resolver's job. The contract is:
 *   symbols[] carry a tmpId (their array index); refs/locals point at those.
 */

const TYPE_NODES = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
  'annotation_type_declaration',
]);

const TYPE_KIND = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  record_declaration: 'record',
  annotation_type_declaration: 'annotation',
};

/** `List<User>` -> `List`, `String[]` -> `String`, `a.b.C<T>` -> `a.b.C` */
export function normalizeType(text) {
  if (!text) return null;
  let t = text.trim();
  const lt = t.indexOf('<');
  if (lt !== -1) t = t.slice(0, lt);
  t = t.replace(/\[\s*\]/g, '').trim();
  return t || null;
}

/**
 * The single type argument of a generic type: `Mono<User>` -> `User`,
 * `List<Post>` -> `Post`. Null when there is none, when there are several
 * (`Map<K,V>` names no element), or when the argument is itself generic --
 * the point is to know what one element is, not to model the whole type.
 *
 * This is what a lambda over the value receives, and erasing it is what made
 * `client.fetch(User.class, name).map(user -> user.getSpec())` untypable.
 */
export function genericArgOf(text) {
  if (!text) return null;
  const lt = text.indexOf('<');
  if (lt === -1) return null;
  const inner = text.slice(lt + 1, text.lastIndexOf('>')).trim();
  if (!inner || inner.includes(',') || inner.includes('<') || inner === '?') return null;
  return normalizeType(inner.replace(/^\?\s+extends\s+/, ''));
}

function childByField(node, field) {
  return node.childForFieldName(field) ?? null;
}

function namedChildrenOfType(node, type) {
  const out = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && c.type === type) out.push(c);
  }
  return out;
}

function firstOfType(node, type) {
  return namedChildrenOfType(node, type)[0] ?? null;
}

/** Spring's route annotations, which mean something even with no argument. */
const ROUTE_ANNOTATIONS = new Set([
  'RequestMapping', 'GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping',
]);

/**
 * Collects `@Foo` / `@Foo(...)` names from a `modifiers` node.
 * `withArgs` also returns the string literals each annotation was given, which
 * is how `@SqsListener("orders")` names the queue it listens to.
 */
function readModifiers(node, src) {
  const modifiers = [];
  const annotations = [];
  const annotationArgs = [];
  const mods = firstOfType(node, 'modifiers');
  if (!mods) return { modifiers, annotations, annotationArgs };

  for (let i = 0; i < mods.childCount; i++) {
    const c = mods.child(i);
    if (!c) continue;
    if (c.type === 'marker_annotation' || c.type === 'annotation') {
      const nameNode = childByField(c, 'name');
      if (!nameNode) continue;
      const name = text(nameNode, src);
      annotations.push(name);
      // @Accessors changes what Lombok writes, so the settings it carries have
      // to survive alongside the name: chain makes setters return the object,
      // fluent drops the get/set prefixes entirely.
      if (name === 'Accessors') {
        const raw = text(c, src);
        if (/\bchain\s*=\s*true/.test(raw)) annotations.push('Accessors.chain');
        if (/\bfluent\s*=\s*true/.test(raw)) annotations.push('Accessors.fluent');
      }
      const raw = text(c, src);
      const strings = [...raw.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map((m) => m[1]);
      // The argument text travels too: `str_args` keeps the values and drops
      // the attribute names, and `@GetMapping(produces = "application/json",
      // value = "/list")` cannot be read without them. A route annotation is
      // kept even with no argument at all -- `@PostMapping` alone serves the
      // class prefix, and dropping it dropped the route.
      if (strings.length || ROUTE_ANNOTATIONS.has(name)) {
        const open = raw.indexOf('(');
        annotationArgs.push({
          name,
          strings,
          raw: open === -1 ? '' : raw.slice(open + 1, raw.lastIndexOf(')')),
          line: c.startPosition.row + 1,
        });
      }
    } else if (!c.isNamed) {
      modifiers.push(text(c, src));
    }
  }
  return { modifiers, annotations, annotationArgs };
}

function text(node, src) {
  return src.slice(node.startIndex, node.endIndex);
}

/** Pulls raw supertype names out of extends/implements clauses. */
/**
 * `class Box<T, C extends Comparable<C>>` declares T and C as NAMES, not as
 * types. A repository large enough contains a real class called C, and letting
 * a type variable find it does not fail to resolve -- it resolves WRONG, and
 * every call on that receiver is then blamed on a class the code never
 * mentioned. quarkus had 118 of those.
 *
 * Recorded as `tp:C` on the declaring symbol's modifiers, which already carry
 * this kind of fact and need no schema change to hold one more.
 */
function readTypeParams(node, src) {
  const params = firstOfType(node, 'type_parameters');
  if (!params) return [];
  const out = [];
  for (let i = 0; i < params.namedChildCount; i++) {
    const p = params.namedChild(i);
    if (p?.type !== 'type_parameter') continue;
    const id = firstOfType(p, 'type_identifier') ?? p.namedChild(0);
    const name = id ? text(id, src) : null;
    if (name) out.push(`tp:${name}`);
  }
  return out;
}

function readSupertypes(node, src) {
  const out = [];
  for (const clause of ['superclass', 'super_interfaces', 'extends_interfaces', 'interfaces']) {
    const n = firstOfType(node, clause) ?? childByField(node, clause);
    if (!n) continue;
    const list = firstOfType(n, 'type_list') ?? n;
    for (let i = 0; i < list.namedChildCount; i++) {
      const t = list.namedChild(i);
      if (!t) continue;
      const name = normalizeType(text(t, src));
      if (name) out.push(name);
    }
  }
  return [...new Set(out)];
}

function paramList(paramsNode, src) {
  const params = [];
  if (!paramsNode) return params;
  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const p = paramsNode.namedChild(i);
    if (!p) continue;
    if (p.type !== 'formal_parameter' && p.type !== 'spread_parameter') continue;
    const typeNode = childByField(p, 'type');
    const nameNode = childByField(p, 'name') ?? firstOfType(p, 'variable_declarator');
    params.push({
      name: nameNode ? text(nameNode, src) : null,
      type: typeNode ? normalizeType(text(typeNode, src)) : null,
      // Kept whole: `Consumer<Options>` is the only place a lambda's parameter
      // type is written down. Overload matching erases it again on read.
      raw: typeNode ? text(typeNode, src).trim() : null,
    });
  }
  return params;
}

/**
 * Records what each argument looks like at a call site. A literal is typed on
 * the spot; a bare name is left as-is for the resolver to look up in scope.
 * Anything more complex becomes null -- unknown, rather than guessed.
 */
function argumentTokens(argsNode, src) {
  if (!argsNode) return [];
  const out = [];
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const arg = argsNode.namedChild(i);
    if (!arg) {
      out.push(null);
      continue;
    }
    switch (arg.type) {
      case 'string_literal':
        out.push('!String');
        break;
      case 'decimal_integer_literal':
      case 'hex_integer_literal':
        out.push('!int');
        break;
      case 'decimal_floating_point_literal':
        out.push('!double');
        break;
      case 'true':
      case 'false':
      case 'boolean_literal':
        out.push('!boolean');
        break;
      case 'character_literal':
        out.push('!char');
        break;
      case 'null_literal':
        out.push(null);
        break;
      case 'identifier':
        out.push(text(arg, src));
        break;
      default: {
        // `User.class` is how a generic Java API is told which type to hand
        // back, so the token is worth keeping even though it is not a plain
        // identifier: it is often the only place the element type is written.
        const raw = text(arg, src);
        out.push(/^[A-Za-z_$][\w$.]*\.class$/.test(raw) ? raw : null);
      }
    }
  }
  return out;
}

/** Literal string values of the arguments; null wherever it is not a literal. */
function stringArgs(argsNode, src) {
  if (!argsNode) return null;
  const out = [];
  let any = false;
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const arg = argsNode.namedChild(i);
    if (arg && arg.type === 'string_literal') {
      out.push(text(arg, src).replace(/^["']|["']$/g, ''));
      any = true;
    } else out.push(null);
  }
  return any ? out : null;
}

export function extractJava(tree, src) {
  const symbols = [];
  const refs = [];
  /** node id -> index of the ref that node's own call produced. */
  const callRefByNode = new Map();
  // javac numbers anonymous classes per file, and so does this.
  let anonymousCount = 0;
  const locals = [];
  const imports = [];
  let pkg = null;

  const addSymbol = (s) => {
    s.tmpId = symbols.length;
    symbols.push(s);
    return s.tmpId;
  };

  const pos = (node) => ({
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    start_byte: node.startIndex,
    end_byte: node.endIndex,
  });

  /**
   * @param typeStack  enclosing type FQN segments, for nested classes
   * @param scopeId    tmpId of the symbol a ref/local belongs to
   */
  function walk(node, typeStack, scopeId) {
    switch (node.type) {
      case 'package_declaration': {
        const id = firstOfType(node, 'scoped_identifier') ?? firstOfType(node, 'identifier');
        if (id) pkg = text(id, src);
        return;
      }

      case 'import_declaration': {
        const id = firstOfType(node, 'scoped_identifier') ?? firstOfType(node, 'identifier');
        if (!id) return;
        const raw = text(id, src);
        const isWildcard = text(node, src).includes('*');
        const isStatic = text(node, src).trimStart().startsWith('import static');
        imports.push({
          fqn: raw,
          simple: raw.split('.').pop(),
          is_wildcard: isWildcard ? 1 : 0,
          is_static: isStatic ? 1 : 0,
        });
        return;
      }
    }

    if (TYPE_NODES.has(node.type)) {
      const nameNode = childByField(node, 'name');
      if (!nameNode) return;
      const simpleName = text(nameNode, src);
      const nextStack = [...typeStack, simpleName];
      const fqn = [pkg, ...nextStack].filter(Boolean).join('.');
      const { modifiers, annotations, annotationArgs } = readModifiers(node, src);
      // The type variables this declaration introduces travel with it.
      modifiers.push(...readTypeParams(node, src));

      const id = addSymbol({
        name: simpleName,
        fqn,
        kind: TYPE_KIND[node.type] ?? 'class',
        container_fqn: typeStack.length ? [pkg, ...typeStack].filter(Boolean).join('.') : pkg,
        type_name: null,
        signature: `${TYPE_KIND[node.type] ?? 'class'} ${simpleName}`,
        arity: null,
        supertypes: readSupertypes(node, src),
        modifiers,
        annotations,
        ...pos(node),
      });

      // A class-level `@RequestMapping("/api/orders")` is the prefix of every
      // route the class declares. Methods have always sent their annotations
      // down the ref pipeline; types discarded theirs, so the prefix was never
      // read and every Spring route in every repository was keyed without it.
      for (const ann of annotationArgs) {
        refs.push({
          fromTmpId: id,
          name: `@${ann.name}`,
          receiver: null,
          receiverRefTmp: null,
          arity: ann.strings.length,
          str_args: ann.strings,
          arg_types: [ann.raw],
          line: ann.line,
          kind: 'annotation',
        });
      }

      // A record's header params are also fields -- and each one compiles to
      // an accessor of the same name. `Request(String name)` gives you
      // `request.name()`, which is not written anywhere in the source.
      if (node.type === 'record_declaration') {
        for (const p of paramList(childByField(node, 'parameters'), src)) {
          if (!p.name) continue;
          addSymbol({
            name: p.name,
            fqn: `${fqn}#${p.name}`,
            kind: 'field',
            container_fqn: fqn,
            type_name: p.type,
            signature: `${p.type ?? '?'} ${p.name}`,
            arity: null,
            supertypes: [],
            modifiers: ['private', 'final'],
            annotations: [],
            ...pos(node),
          });
          addSymbol({
            name: p.name,
            fqn: `${fqn}#${p.name}`,
            kind: 'method',
            container_fqn: fqn,
            type_name: p.type,
            signature: `${p.type ?? '?'} ${p.name}()  // record accessor`,
            arity: 0,
            supertypes: [],
            modifiers: ['generated', 'public'],
            annotations: ['record'],
            generated: true,
            ...pos(node),
          });
        }
      }

      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c) walk(c, nextStack, id);
      }
      return;
    }

    if (node.type === 'method_declaration' || node.type === 'constructor_declaration') {
      const nameNode = childByField(node, 'name');
      if (!nameNode) return;
      const simpleName = text(nameNode, src);
      const containerFqn = [pkg, ...typeStack].filter(Boolean).join('.');
      const isCtor = node.type === 'constructor_declaration';
      const params = paramList(childByField(node, 'parameters'), src);
      const retNode = childByField(node, 'type');
      const ret = retNode ? normalizeType(text(retNode, src)) : null;
      const { modifiers, annotations, annotationArgs } = readModifiers(node, src);

      const id = addSymbol({
        name: simpleName,
        fqn: `${containerFqn}#${simpleName}`,
        kind: isCtor ? 'constructor' : 'method',
        container_fqn: containerFqn,
        type_name: ret,
        type_args: retNode ? genericArgOf(text(retNode, src)) : null,
        signature: `${isCtor ? '' : `${ret ?? 'void'} `}${simpleName}(${params
          .map((p) => p.type ?? '?')
          .join(', ')})`,
        arity: params.length,
        params: params.map((p) => p.raw ?? p.type),
        supertypes: [],
        modifiers,
        annotations,
        ...pos(node),
      });

      // Annotations carrying string literals ride the ref pipeline, so the
      // binding plugins can read them without a second traversal.
      for (const ann of annotationArgs) {
        refs.push({
          fromTmpId: id,
          name: `@${ann.name}`,
          receiver: null,
          receiverRefTmp: null,
          arity: ann.strings.length,
          str_args: ann.strings,
          // For an annotation, the one "argument" is its whole argument list
          // as written, attribute names included.
          arg_types: [ann.raw],
          line: ann.line,
          kind: 'annotation',
        });
      }

      for (const p of params) {
        if (p.name) locals.push({ scopeTmpId: id, name: p.name, type_name: p.type });
      }

      const body = childByField(node, 'body');
      if (body) walk(body, typeStack, id);
      return;
    }

    if (node.type === 'field_declaration') {
      const containerFqn = [pkg, ...typeStack].filter(Boolean).join('.');
      const typeNode = childByField(node, 'type');
      const typeName = typeNode ? normalizeType(text(typeNode, src)) : null;
      const { modifiers, annotations } = readModifiers(node, src);

      for (const d of namedChildrenOfType(node, 'variable_declarator')) {
        const nameNode = childByField(d, 'name');
        if (!nameNode) continue;
        const fieldName = text(nameNode, src);
        addSymbol({
          name: fieldName,
          fqn: `${containerFqn}#${fieldName}`,
          kind: 'field',
          container_fqn: containerFqn,
          type_name: typeName,
          type_args: typeNode ? genericArgOf(text(typeNode, src)) : null,
          signature: `${typeName ?? '?'} ${fieldName}`,
          arity: null,
          supertypes: [],
          modifiers,
          annotations,
          ...pos(node),
        });
        // Initialiser expressions still contain calls worth recording.
        const value = childByField(d, 'value');
        if (value) walk(value, typeStack, scopeId);
      }
      return;
    }

    if (node.type === 'local_variable_declaration') {
      const typeNode = childByField(node, 'type');
      const declared = typeNode ? normalizeType(text(typeNode, src)) : null;
      // `var` names no type; the resolver fills it in from what the call returns.
      let typeName = declared === 'var' ? null : declared;

      for (const d of namedChildrenOfType(node, 'variable_declarator')) {
        const nameNode = childByField(d, 'name');
        const value = childByField(d, 'value');
        // `var metadata = new Metadata()` needs no inference pass: the
        // constructor names the type outright.
        if (!typeName && value?.type === 'object_creation_expression') {
          const ctor = childByField(value, 'type');
          if (ctor) typeName = normalizeType(text(ctor, src));
        }
        // `var manager = context.entityManager` names no type and calls
        // nothing. The path is what declares it, one field per segment.
        let initPath = null;
        if (!typeName && value?.type === 'field_access') {
          const written = text(value, src).trim();
          if (/^(?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(written)) {
            initPath = written;
          }
        }
        if (nameNode && scopeId != null) {
          locals.push({
            scopeTmpId: scopeId,
            name: text(nameNode, src),
            type_name: typeName,
            type_args: typeNode ? genericArgOf(text(typeNode, src)) : null,
            line: node.startPosition.row + 1,
            init_kind: typeName
              ? null
              : value?.type === 'method_invocation'
                ? 'call'
                : initPath
                  ? 'path'
                  : null,
            init_path: initPath,
          });
        }
        if (value) walk(value, typeStack, scopeId);
      }
      return;
    }

    // Lambda parameters have no written type -- it comes from the functional
    // interface, which usually lives in a library. Recording them without a
    // type still matters: it stops the resolver guessing from the bare name.
    if (node.type === 'lambda_expression' && scopeId != null) {
      const params = childByField(node, 'parameters');
      if (params) {
        const names =
          params.type === 'identifier'
            ? [params]
            : [
                ...namedChildrenOfType(params, 'identifier'),
                ...namedChildrenOfType(params, 'formal_parameter').map(
                  (p) => childByField(p, 'name') ?? p,
                ),
              ];
        // Which call this lambda was passed to. Its parameter holds one
        // element of whatever that call's receiver produces, and only the
        // resolver can say what that is.
        let owner = node.parent;
        while (owner && owner.type !== 'method_invocation') owner = owner.parent;
        const ownerRefTmp = owner ? (callRefByNode.get(owner.id) ?? null) : null;

        for (const n of names) {
          locals.push({
            scopeTmpId: scopeId,
            name: text(n, src),
            type_name: null,
            ownerRefTmp,
            init_kind: ownerRefTmp == null ? null : 'lambda',
          });
        }
      }
    }

    // Bindings that are not local_variable_declaration. Missing them does not
    // just lose a link: an untyped receiver falls through to name matching,
    // which happily attached `e.getMessage()` to the enclosing class's own
    // getMessage. A wrong edge is worse than a missing one.
    if (node.type === 'catch_clause' && scopeId != null) {
      const param = firstOfType(node, 'catch_formal_parameter');
      if (param) {
        const nameNode = childByField(param, 'name');
        const typeNode = firstOfType(param, 'catch_type') ?? childByField(param, 'type');
        if (nameNode) {
          // `catch (IOException | SQLException e)` has no single type.
          const raw = typeNode ? text(typeNode, src) : null;
          locals.push({
            scopeTmpId: scopeId,
            name: text(nameNode, src),
            type_name: raw && !raw.includes('|') ? normalizeType(raw) : null,
          });
        }
      }
    }

    if (node.type === 'resource' && scopeId != null) {
      // try (InputStream in = ...) declares `in` for the whole block.
      const nameNode = childByField(node, 'name');
      const typeNode = childByField(node, 'type');
      if (nameNode) {
        locals.push({
          scopeTmpId: scopeId,
          name: text(nameNode, src),
          type_name: typeNode ? normalizeType(text(typeNode, src)) : null,
        });
      }
    }

    if (node.type === 'enhanced_for_statement') {
      const typeNode = childByField(node, 'type');
      const nameNode = childByField(node, 'name');
      if (nameNode && scopeId != null) {
        locals.push({
          scopeTmpId: scopeId,
          name: text(nameNode, src),
          type_name: typeNode ? normalizeType(text(typeNode, src)) : null,
        });
      }
    }

    if (node.type === 'method_invocation') {
      const nameNode = childByField(node, 'name');
      const objNode = childByField(node, 'object');
      const args = childByField(node, 'arguments');

      // Walk the receiver first so that in a.b().c() the ref for b() already
      // exists and c() can point at it; that link is what lets the resolver
      // carry a return type along the chain.
      let receiverRefTmp = null;
      if (objNode) {
        walk(objNode, typeStack, scopeId);
        // The receiver's own ref, looked up by node. `refs.length - 1` was
        // whatever the receiver's ARGUMENTS pushed last, since a call walks
        // its arguments after itself -- so any chain whose inner call took an
        // argument linked to the wrong ref and lost its type.
        receiverRefTmp = callRefByNode.get(objNode.id) ?? null;
      }

      if (nameNode) {
        callRefByNode.set(node.id, refs.length);
        refs.push({
          fromTmpId: scopeId,
          name: text(nameNode, src),
          receiver: objNode ? text(objNode, src) : null,
          receiverRefTmp,
          arity: args ? args.namedChildCount : null,
          arg_types: argumentTokens(args, src),
          str_args: stringArgs(args, src),
          line: node.startPosition.row + 1,
          kind: 'call',
        });
      }
      if (args) walk(args, typeStack, scopeId);
      return;
    }

    if (node.type === 'object_creation_expression') {
      const typeNode = childByField(node, 'type');
      const args = childByField(node, 'arguments');
      if (typeNode) {
        // Registered like a call so `new Ticket().setSeat(...)` can chain: the
        // constructed type is the receiver of whatever follows it.
        callRefByNode.set(node.id, refs.length);
        refs.push({
          fromTmpId: scopeId,
          name: normalizeType(text(typeNode, src)),
          receiver: null,
          arity: args ? args.namedChildCount : null,
          line: node.startPosition.row + 1,
          kind: 'new',
        });
      }

      // `new ClassLoader() { ... }` declares a class. It has no name in the
      // source, but it has a supertype written right there, and `super` inside
      // it means THAT type -- not the class the expression happens to sit in.
      // Walking the body as ordinary code attributed every member to the
      // enclosing class and left `super` pointing at the wrong place.
      const body = firstOfType(node, 'class_body');
      if (body && typeNode) {
        const superName = normalizeType(text(typeNode, src));
        anonymousCount += 1;
        const outer = [pkg, ...typeStack].filter(Boolean).join('.') || pkg;
        // Named the way every other nested type here is named -- with a dot --
        // so the scope walk finds its way back out to the enclosing class. A
        // bare call inside the body reaches the OUTER class's methods, and
        // spelling this `Outer$1` the way javac does hid that path: the walk
        // splits on dots, so `Outer$1` climbed straight past Outer to the
        // package. A digit is not a legal Java identifier, so nothing real
        // collides with it.
        const fqn = `${outer}.${anonymousCount}`;
        const id = addSymbol({
          name: `${anonymousCount}`,
          fqn,
          kind: 'class',
          container_fqn: outer || null,
          type_name: null,
          signature: `new ${superName}() { ... }`,
          arity: null,
          supertypes: superName ? [superName] : [],
          modifiers: ['anonymous'],
          annotations: [],
          ...pos(node),
        });
        // The arguments belong to the constructor call, not to the body.
        if (args) walk(args, typeStack, scopeId);
        walk(body, [...typeStack, `${anonymousCount}`], id);
        return;
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) walk(c, typeStack, scopeId);
    }
  }

  walk(tree.rootNode, [], null);
  addLombokMembers(symbols);

  return { package: pkg, imports, symbols, refs, locals };
}

/** Class-level Lombok annotations and what each of them writes. */
const LOMBOK_GETTERS = new Set(['Data', 'Getter', 'Value']);
const LOMBOK_SETTERS = new Set(['Data', 'Setter']);
const LOMBOK_BUILDERS = new Set(['Builder', 'SuperBuilder']);

/**
 * Lombok members, written the way the annotation processor writes them.
 *
 * `@Data class OrderParam { private Long couponId; }` compiles to a class with
 * `getCouponId()` on it. Nothing in the source says so, which is why every
 * `orderParam.getCouponId()` in a Spring codebase looked like a call into
 * thin air -- 16 misses on one class in mall alone, and the same shape all
 * through halo. These are as real as the fields they read, so they become
 * symbols, marked `generated` like every other derived member.
 */
function addLombokMembers(symbols) {
  const types = symbols.filter((s) => ['class', 'record'].includes(s.kind) && s.fqn);
  if (!types.length) return;

  const fieldsOf = new Map();
  const declared = new Map();
  for (const s of symbols) {
    if (!s.container_fqn) continue;
    if (s.kind === 'field') {
      if (!fieldsOf.has(s.container_fqn)) fieldsOf.set(s.container_fqn, []);
      fieldsOf.get(s.container_fqn).push(s);
    } else if (['method', 'constructor'].includes(s.kind)) {
      if (!declared.has(s.container_fqn)) declared.set(s.container_fqn, new Set());
      declared.get(s.container_fqn).add(s.name);
    }
  }

  const add = (spec) => {
    spec.tmpId = symbols.length;
    symbols.push(spec);
    return spec.tmpId;
  };

  for (const type of types) {
    const ann = new Set(type.annotations ?? []);
    const fields = (fieldsOf.get(type.fqn) ?? []).filter(
      (f) => !(f.modifiers ?? []).includes('static'),
    );
    if (!fields.length) continue;
    const already = declared.get(type.fqn) ?? new Set();

    const generated = (name, typeName, signature, container, extra = {}) => {
      if ((declared.get(container) ?? new Set()).has(name)) return;
      add({
        name,
        fqn: `${container}#${name}`,
        kind: 'method',
        container_fqn: container,
        type_name: typeName,
        type_args: extra.type_args ?? null,
        signature,
        arity: extra.arity ?? 0,
        supertypes: [],
        modifiers: ['generated', 'public'],
        annotations: ['lombok'],
        generated: true,
        start_line: type.start_line,
        end_line: type.start_line,
        start_byte: type.start_byte,
        end_byte: type.start_byte,
      });
    };

    // @Accessors(fluent) names them after the field; @Accessors(chain) makes
    // the setter hand the object back, which is what keeps a builder-style
    // `new ListOptions().setA(x).setB(y)` from dying at the second call.
    const fluent = ann.has('Accessors.fluent');
    const chains = ann.has('Accessors.chain') || fluent;

    for (const field of fields) {
      const own = new Set(field.annotations ?? []);
      const cap = field.name.charAt(0).toUpperCase() + field.name.slice(1);
      // `boolean flag` reads as `isFlag()`; the boxed Boolean keeps `getFlag()`.
      const getter = fluent ? field.name : field.type_name === 'boolean' ? `is${cap}` : `get${cap}`;
      const setter = fluent ? field.name : `set${cap}`;

      if ([...ann].some((a) => LOMBOK_GETTERS.has(a)) || own.has('Getter')) {
        generated(getter, field.type_name, `${field.type_name ?? '?'} ${getter}()  // lombok`, type.fqn, {
          type_args: field.type_args ?? null,
        });
      }
      const settable = !(field.modifiers ?? []).includes('final') && !ann.has('Value');
      if (settable && ([...ann].some((a) => LOMBOK_SETTERS.has(a)) || own.has('Setter'))) {
        const returns = chains ? type.fqn : 'void';
        generated(setter, returns, `${returns === 'void' ? 'void' : type.name} ${setter}(${field.type_name ?? '?'})  // lombok`, type.fqn, { arity: 1 });
      }
    }

    if (![...ann].some((a) => LOMBOK_BUILDERS.has(a))) continue;

    // @Builder writes a nested builder class: one method per field returning
    // the builder, and build() returning the type. Modelling it is what keeps
    // `Condition.builder().type(x).build()` from dying at the first hop.
    const builderName = `${type.name}Builder`;
    const builderFqn = `${type.fqn}.${builderName}`;
    if (!already.has('builder')) {
      add({
        name: 'builder',
        fqn: `${type.fqn}#builder`,
        kind: 'method',
        container_fqn: type.fqn,
        type_name: builderFqn,
        signature: `static ${builderName} builder()  // lombok`,
        arity: 0,
        supertypes: [],
        modifiers: ['generated', 'public', 'static'],
        annotations: ['lombok'],
        generated: true,
        start_line: type.start_line,
        end_line: type.start_line,
        start_byte: type.start_byte,
        end_byte: type.start_byte,
      });
    }
    add({
      name: builderName,
      fqn: builderFqn,
      kind: 'class',
      container_fqn: type.fqn,
      type_name: null,
      signature: `class ${builderName}  // lombok`,
      arity: null,
      supertypes: [],
      modifiers: ['generated', 'public', 'static'],
      annotations: ['lombok'],
      generated: true,
      start_line: type.start_line,
      end_line: type.start_line,
      start_byte: type.start_byte,
      end_byte: type.start_byte,
    });
    for (const field of fields) {
      generated(field.name, builderFqn, `${builderName} ${field.name}(${field.type_name ?? '?'})  // lombok`, builderFqn, { arity: 1 });
    }
    generated('build', type.fqn, `${type.name} build()  // lombok`, builderFqn);
  }
}
