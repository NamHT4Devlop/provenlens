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
      const strings = [...text(c, src).matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map((m) => m[1]);
      if (strings.length) {
        annotationArgs.push({ name, strings, line: c.startPosition.row + 1 });
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
      default:
        out.push(null);
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
      const { modifiers, annotations } = readModifiers(node, src);

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

      // A record's header params are also fields.
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
        signature: `${isCtor ? '' : `${ret ?? 'void'} `}${simpleName}(${params
          .map((p) => p.type ?? '?')
          .join(', ')})`,
        arity: params.length,
        params: params.map((p) => p.type),
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
      const typeName = declared === 'var' ? null : declared;

      for (const d of namedChildrenOfType(node, 'variable_declarator')) {
        const nameNode = childByField(d, 'name');
        const value = childByField(d, 'value');
        if (nameNode && scopeId != null) {
          locals.push({
            scopeTmpId: scopeId,
            name: text(nameNode, src),
            type_name: typeName,
            line: node.startPosition.row + 1,
            init_kind: !typeName && value?.type === 'method_invocation' ? 'call' : null,
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
        for (const n of names) {
          locals.push({ scopeTmpId: scopeId, name: text(n, src), type_name: null });
        }
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
        const before = refs.length;
        walk(objNode, typeStack, scopeId);
        if (objNode.type === 'method_invocation' && refs.length > before) {
          receiverRefTmp = refs.length - 1;
        }
      }

      if (nameNode) {
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
        refs.push({
          fromTmpId: scopeId,
          name: normalizeType(text(typeNode, src)),
          receiver: null,
          arity: args ? args.namedChildCount : null,
          line: node.startPosition.row + 1,
          kind: 'new',
        });
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) walk(c, typeStack, scopeId);
    }
  }

  walk(tree.rootNode, [], null);

  return { package: pkg, imports, symbols, refs, locals };
}
