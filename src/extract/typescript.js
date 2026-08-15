/**
 * TypeScript / TSX / JavaScript extractor.
 *
 * One extractor serves all three: the node types overlap almost entirely, and
 * the JS grammar simply never produces the type-annotation nodes.
 *
 * Symbols are module-qualified, because a bare `Donation` says nothing about
 * which file it came from:
 *   type    src/domain/donation:Donation
 *   member  src/domain/donation:Donation#isLarge
 *   fn      src/lib/format:formatAmount
 */

/** `src/domain/donation.ts` -> `src/domain/donation` */
export function modulePathOf(filePath) {
  return filePath.replace(/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/, '');
}

function text(node, src) {
  return src.slice(node.startIndex, node.endIndex);
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
 * `Promise<Donation>` -> `Promise`, `Donation[]` -> `Donation[]`.
 *
 * The array suffix is deliberately kept: a receiver of type `Donation[]` is an
 * Array, not a Donation, and dropping the brackets makes `store.push(...)`
 * resolve to a member of the element type, which is wrong.
 */
export function normalizeType(raw) {
  if (!raw) return null;
  let t = raw.trim().replace(/^:\s*/, '');
  const isArray = /\[\s*\]\s*$/.test(t);
  const lt = t.indexOf('<');
  if (lt !== -1) t = t.slice(0, lt);
  t = t.replace(/\[\s*\]/g, '').trim();
  // A union or intersection tells us too little to pick one type from.
  if (/[|&]/.test(t)) return null;
  if (!t) return null;
  return isArray ? `${t}[]` : t;
}

/** Strips the array suffix for places that can never hold one (heritage, `new`). */
function bareType(raw) {
  const t = normalizeType(raw);
  return t ? t.replace(/\[\]$/, '') : null;
}

function typeFromAnnotation(node, src) {
  const ann = firstOfType(node, 'type_annotation') ?? childByField(node, 'type');
  if (!ann) return null;
  return normalizeType(text(ann, src));
}

export function extractTypeScript(tree, src, ctx = {}) {
  const modulePath = modulePathOf(ctx.path ?? '');
  const symbols = [];
  const refs = [];
  const locals = [];
  const imports = [];

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

  const unquote = (node) => text(node, src).replace(/^['"`]|['"`]$/g, '');

  function readImport(node) {
    const source = childByField(node, 'source');
    if (!source) return;
    const spec = unquote(source);
    const clause = firstOfType(node, 'import_clause');
    if (!clause) {
      imports.push({ fqn: spec, simple: null, is_wildcard: 1, is_static: 0, kind: 'side-effect' });
      return;
    }

    const named = firstOfType(clause, 'named_imports');
    if (named) {
      for (const spec2 of namedChildrenOfType(named, 'import_specifier')) {
        const nameNode = childByField(spec2, 'name');
        const aliasNode = childByField(spec2, 'alias');
        if (!nameNode) continue;
        imports.push({
          fqn: spec,
          simple: text(aliasNode ?? nameNode, src),
          orig: text(nameNode, src),
          is_wildcard: 0,
          is_static: 0,
          kind: 'import',
        });
      }
    }

    const def = firstOfType(clause, 'identifier');
    if (def) {
      imports.push({
        fqn: spec,
        simple: text(def, src),
        orig: 'default',
        is_wildcard: 0,
        is_static: 0,
        kind: 'import',
      });
    }

    const ns = firstOfType(clause, 'namespace_import');
    if (ns) {
      const alias = firstOfType(ns, 'identifier');
      imports.push({
        fqn: spec,
        simple: alias ? text(alias, src) : null,
        orig: '*',
        is_wildcard: 1,
        is_static: 0,
        kind: 'import',
      });
    }
  }

  /** `export * from './a'` and `export { X } from './b'` -- barrel plumbing. */
  function readReexport(node) {
    const source = childByField(node, 'source');
    if (!source) return false;
    const spec = unquote(source);
    const clause = firstOfType(node, 'export_clause');

    if (!clause) {
      imports.push({
        fqn: spec,
        simple: null,
        orig: '*',
        is_wildcard: 1,
        is_static: 0,
        kind: 'reexport-all',
      });
      return true;
    }

    for (const spec2 of namedChildrenOfType(clause, 'export_specifier')) {
      const nameNode = childByField(spec2, 'name');
      const aliasNode = childByField(spec2, 'alias');
      if (!nameNode) continue;
      imports.push({
        fqn: spec,
        simple: text(aliasNode ?? nameNode, src),
        orig: text(nameNode, src),
        is_wildcard: 0,
        is_static: 0,
        kind: 'reexport',
      });
    }
    return true;
  }

  function heritage(node) {
    const out = [];
    const clause = firstOfType(node, 'class_heritage') ?? firstOfType(node, 'extends_type_clause');
    const scan = (n) => {
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (!c) continue;
        if (c.type === 'type_identifier' || c.type === 'identifier') {
          const name = bareType(text(c, src));
          if (name) out.push(name);
        } else scan(c);
      }
    };
    if (clause) scan(clause);
    // `interface A extends B` puts the clause directly on the declaration.
    for (const t of ['extends_type_clause', 'implements_clause', 'extends_clause']) {
      const n = firstOfType(node, t);
      if (n) scan(n);
    }
    return [...new Set(out)];
  }

  function readParams(paramsNode, ownerTmpId, containerFqn) {
    const params = [];
    if (!paramsNode) return params;

    for (let i = 0; i < paramsNode.namedChildCount; i++) {
      const p = paramsNode.namedChild(i);
      if (!p) continue;
      if (!['required_parameter', 'optional_parameter'].includes(p.type)) continue;

      const patt = childByField(p, 'pattern') ?? firstOfType(p, 'identifier');
      const name = patt ? text(patt, src) : null;
      const typeName = typeFromAnnotation(p, src);
      params.push({ name, type: typeName });

      if (name && ownerTmpId != null) {
        locals.push({ scopeTmpId: ownerTmpId, name, type_name: typeName });
      }

      // TypeScript parameter property: `constructor(private repo: Repo)` also
      // declares a field, which is how most DI in TS is written.
      if (containerFqn && firstOfType(p, 'accessibility_modifier') && name) {
        addSymbol({
          name,
          fqn: `${containerFqn}#${name}`,
          kind: 'field',
          container_fqn: containerFqn,
          type_name: typeName,
          signature: `${text(firstOfType(p, 'accessibility_modifier'), src)} ${name}: ${typeName ?? '?'}`,
          arity: null,
          supertypes: [],
          modifiers: ['parameter-property'],
          annotations: [],
          ...pos(p),
        });
      }
    }
    return params;
  }

  function walk(node, typeStack, scopeId, exported) {
    switch (node.type) {
      case 'import_statement':
        readImport(node);
        return;

      case 'export_statement': {
        if (readReexport(node)) return;
        const decl = childByField(node, 'declaration');
        if (decl) {
          walk(decl, typeStack, scopeId, true);
          return;
        }
        break;
      }
    }

    if (['class_declaration', 'interface_declaration', 'abstract_class_declaration'].includes(node.type)) {
      const nameNode = childByField(node, 'name');
      if (!nameNode) return;
      const simpleName = text(nameNode, src);
      const fqn = `${modulePath}:${simpleName}`;

      const id = addSymbol({
        name: simpleName,
        fqn,
        kind: node.type === 'interface_declaration' ? 'interface' : 'class',
        container_fqn: modulePath,
        type_name: null,
        signature: `${node.type === 'interface_declaration' ? 'interface' : 'class'} ${simpleName}`,
        arity: null,
        supertypes: heritage(node),
        modifiers: exported ? ['export'] : [],
        annotations: [],
        ...pos(node),
      });

      const body = childByField(node, 'body');
      if (body) {
        for (let i = 0; i < body.namedChildCount; i++) {
          const c = body.namedChild(i);
          if (c) walk(c, [...typeStack, fqn], id, false);
        }
      }
      return;
    }

    if (node.type === 'method_definition' || node.type === 'method_signature') {
      const nameNode = childByField(node, 'name');
      if (!nameNode) return;
      const simpleName = text(nameNode, src);
      const containerFqn = typeStack[typeStack.length - 1] ?? modulePath;
      const isCtor = simpleName === 'constructor';
      const ret = typeFromAnnotation(node, src);

      const id = addSymbol({
        name: simpleName,
        fqn: `${containerFqn}#${simpleName}`,
        kind: isCtor ? 'constructor' : 'method',
        container_fqn: containerFqn,
        type_name: ret,
        signature: simpleName,
        arity: 0,
        supertypes: [],
        modifiers: [],
        annotations: [],
        ...pos(node),
      });

      const params = readParams(childByField(node, 'parameters'), id, containerFqn);
      symbols[id].arity = params.length;
      symbols[id].signature =
        `${simpleName}(${params.map((p) => `${p.name}${p.type ? `: ${p.type}` : ''}`).join(', ')})` +
        (ret ? `: ${ret}` : '');

      const body = childByField(node, 'body');
      if (body) walk(body, typeStack, id, false);
      return;
    }

    if (node.type === 'public_field_definition' || node.type === 'property_signature') {
      const nameNode = childByField(node, 'name');
      const containerFqn = typeStack[typeStack.length - 1] ?? modulePath;
      if (nameNode) {
        const fieldName = text(nameNode, src);
        const typeName = typeFromAnnotation(node, src);
        addSymbol({
          name: fieldName,
          fqn: `${containerFqn}#${fieldName}`,
          kind: 'field',
          container_fqn: containerFqn,
          type_name: typeName,
          signature: `${fieldName}${typeName ? `: ${typeName}` : ''}`,
          arity: null,
          supertypes: [],
          modifiers: [],
          annotations: [],
          ...pos(node),
        });
        const value = childByField(node, 'value');
        if (value) walk(value, typeStack, scopeId, false);
      }
      return;
    }

    if (node.type === 'function_declaration' || node.type === 'generator_function_declaration') {
      const nameNode = childByField(node, 'name');
      if (!nameNode) return;
      const simpleName = text(nameNode, src);
      const ret = typeFromAnnotation(node, src);

      const id = addSymbol({
        name: simpleName,
        fqn: `${modulePath}:${simpleName}`,
        kind: 'function',
        container_fqn: modulePath,
        type_name: ret,
        signature: simpleName,
        arity: 0,
        supertypes: [],
        modifiers: exported ? ['export'] : [],
        annotations: [],
        ...pos(node),
      });

      const params = readParams(childByField(node, 'parameters'), id, null);
      symbols[id].arity = params.length;
      symbols[id].signature = `${simpleName}(${params
        .map((p) => `${p.name}${p.type ? `: ${p.type}` : ''}`)
        .join(', ')})${ret ? `: ${ret}` : ''}`;

      const body = childByField(node, 'body');
      if (body) walk(body, typeStack, id, false);
      return;
    }

    if (node.type === 'variable_declarator') {
      const nameNode = childByField(node, 'name');
      const value = childByField(node, 'value');
      const declaredType = typeFromAnnotation(node, src);

      if (nameNode && nameNode.type === 'identifier') {
        const varName = text(nameNode, src);
        // `const x: Foo = ...` beats inference; otherwise `new Foo()` types it.
        let typeName = declaredType;
        if (!typeName && value?.type === 'new_expression') {
          const ctor = childByField(value, 'constructor');
          if (ctor) typeName = bareType(text(ctor, src));
        }

        // A top-level arrow function is a function, not a variable.
        if (value && ['arrow_function', 'function_expression'].includes(value.type)) {
          const id = addSymbol({
            name: varName,
            fqn: `${modulePath}:${varName}`,
            kind: 'function',
            container_fqn: modulePath,
            type_name: typeFromAnnotation(value, src),
            signature: varName,
            arity: 0,
            supertypes: [],
            modifiers: exported ? ['export'] : [],
            annotations: [],
            ...pos(node),
          });
          const params = readParams(childByField(value, 'parameters'), id, null);
          symbols[id].arity = params.length;
          const body = childByField(value, 'body');
          if (body) walk(body, typeStack, id, false);
          return;
        }

        if (scopeId != null) {
          locals.push({
            scopeTmpId: scopeId,
            name: varName,
            type_name: typeName,
            line: node.startPosition.row + 1,
            // Flags `const x = svc.doThing()` for return-type inference later.
            init_kind: !typeName && value?.type === 'call_expression' ? 'call' : null,
          });
        }
      }

      if (value) walk(value, typeStack, scopeId, false);
      return;
    }

    if (node.type === 'call_expression') {
      const fn = childByField(node, 'function');
      const args = childByField(node, 'arguments');
      if (fn) {
        if (fn.type === 'member_expression') {
          const obj = childByField(fn, 'object');
          const prop = childByField(fn, 'property');
          if (prop) {
            refs.push({
              fromTmpId: scopeId,
              name: text(prop, src),
              receiver: obj ? text(obj, src) : null,
              arity: args ? args.namedChildCount : null,
              line: node.startPosition.row + 1,
              kind: 'call',
            });
          }
        } else if (fn.type === 'identifier') {
          refs.push({
            fromTmpId: scopeId,
            name: text(fn, src),
            receiver: null,
            arity: args ? args.namedChildCount : null,
            line: node.startPosition.row + 1,
            kind: 'call',
          });
        }
      }
    }

    if (node.type === 'new_expression') {
      const ctor = childByField(node, 'constructor');
      const args = childByField(node, 'arguments');
      if (ctor) {
        refs.push({
          fromTmpId: scopeId,
          name: bareType(text(ctor, src)),
          receiver: null,
          arity: args ? args.namedChildCount : null,
          line: node.startPosition.row + 1,
          kind: 'new',
        });
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) walk(c, typeStack, scopeId, false);
    }
  }

  walk(tree.rootNode, [], null, false);

  return { package: modulePath, imports, symbols, refs, locals };
}
