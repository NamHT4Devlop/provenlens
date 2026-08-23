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
/**
 * `Table | undefined` -> `Table`. An optional is still that type wherever a
 * member is read from it, which is precisely why TypeScript makes the author
 * write `table!` or guard it first before doing so. A union of two *real*
 * types still says too little to pick one, and returns null.
 */
function narrowNullable(raw) {
  if (!raw.includes('|')) return raw;
  const kept = raw
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part && part !== 'undefined' && part !== 'null');
  return kept.length === 1 ? kept[0] : null;
}

export function normalizeType(raw) {
  if (!raw) return null;
  let t = raw.trim().replace(/^:\s*/, '');
  // `Array<Donation>` is the same type `Donation[]` spells; keeping the two
  // apart would give the receiver different behaviour by syntax alone.
  const arrayGeneric = /^(?:Array|ReadonlyArray)\s*<\s*([\w$.]+)\s*>$/.exec(t);
  if (arrayGeneric) t = `${arrayGeneric[1]}[]`;
  const isArray = /\[\s*\]\s*$/.test(t);
  const lt = t.indexOf('<');
  if (lt !== -1) t = t.slice(0, lt);
  t = t.replace(/\[\s*\]/g, '').trim();
  t = narrowNullable(t) ?? t;
  // A union of real types, or an intersection, tells us too little to pick one.
  if (/[|&]/.test(t)) return null;
  if (!t) return null;
  return isArray ? `${t}[]` : t;
}

/**
 * One element of a container type: `Promise<User>` and `User[]` both yield
 * `User`. This is what a callback over the value receives, and dropping it is
 * what made every `.then(u => ...)` and `.map(item => ...)` untypable.
 */
export function elementOf(raw) {
  if (!raw) return null;
  const t = raw.trim().replace(/^:\s*/, '');
  if (/\[\s*\]\s*$/.test(t)) return normalizeType(t.replace(/\[\s*\]\s*$/, ''));
  const lt = t.indexOf('<');
  if (lt === -1) return null;
  const inner = t.slice(lt + 1, t.lastIndexOf('>')).trim();
  if (!inner || inner.includes(',') || inner.includes('<')) return null;
  // `Promise<Table | undefined>` awaited is a Table: 1,061 calls in typeorm
  // are written `table!.findColumnByName(...)`, and the `!` is the author
  // saying so.
  const narrowed = narrowNullable(inner);
  return narrowed ? normalizeType(narrowed) : null;
}

/** Strips the array suffix for places that can never hold one (heritage, `new`). */
function bareType(raw) {
  const t = normalizeType(raw);
  return t ? t.replace(/\[\]$/, '') : null;
}

/**
 * `@Injectable()` / `@SqsMessageHandler('queue')` -- the TS spelling of what
 * Java calls an annotation, and it carries the same kind of binding-relevant
 * strings, so it is recorded the same way: on the symbol, and as an
 * `annotation` ref the binding plugins can match.
 */
function readDecorator(node, src) {
  const call = firstOfType(node, 'call_expression');
  const nameNode = call ? childByField(call, 'function') : node.namedChild(0);
  if (!nameNode) return null;
  const name = text(nameNode, src).split('.').pop();
  return {
    name: `@${name}`,
    strArgs: call ? (stringArgs(childByField(call, 'arguments'), src) ?? []) : [],
    line: node.startPosition.row + 1,
  };
}

function typeFromAnnotation(node, src) {
  const ann = firstOfType(node, 'type_annotation') ?? childByField(node, 'type');
  if (!ann) return null;
  return normalizeType(text(ann, src));
}

/**
 * The type a function returns when it never says so: TypeScript infers it, and
 * a body whose returns all construct the same class says it plainly enough.
 *
 * Only `return new X(...)` counts. That is the shape a factory has -- and
 * `Test.createTestingModule(...)` in Nest is exactly one, with no annotation,
 * which is where a whole test suite's worth of chains used to stop dead.
 */
function inferredReturn(body, src) {
  if (!body) return null;
  let found = null;
  let conflicted = false;
  const scan = (n, depth) => {
    if (conflicted || depth > 4 || !n) return;
    // A nested function's returns belong to it, not to us.
    if (depth && ['function_declaration', 'function_expression', 'arrow_function', 'method_definition'].includes(n.type)) return;
    if (n.type === 'return_statement') {
      const value = n.namedChild(0);
      const built =
        value?.type === 'new_expression'
          ? bareType(text(childByField(value, 'constructor') ?? value, src))
          : null;
      if (!built) conflicted = true;
      else if (found && found !== built) conflicted = true;
      else found = built;
      return;
    }
    for (let i = 0; i < n.namedChildCount; i++) scan(n.namedChild(i), depth + 1);
  };
  scan(body, 0);
  return conflicted ? null : found;
}

/** The element of an annotated type: `Promise<User>` -> `User`. */
function elementFromAnnotation(node, src) {
  const ann = firstOfType(node, 'type_annotation') ?? childByField(node, 'type');
  return ann ? elementOf(text(ann, src)) : null;
}

/** Literal string values of the arguments; null wherever it is not a literal. */
function stringArgs(argsNode, src) {
  if (!argsNode) return null;
  const out = [];
  let any = false;
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const arg = argsNode.namedChild(i);
    if (arg && (arg.type === 'string' || arg.type === 'template_string')) {
      out.push(src.slice(arg.startIndex, arg.endIndex).replace(/^['"`]|['"`]$/g, ''));
      any = true;
    } else out.push(null);
  }
  return any ? out : null;
}

export function extractTypeScript(tree, src, ctx = {}) {
  const modulePath = modulePathOf(ctx.path ?? '');
  const symbols = [];
  const refs = [];
  /** node id -> index of the ref that node's own call produced. */
  const callRefByNode = new Map();
  /** Arrows already given parameters, so a named one is not done twice. */
  const arrowSeen = new Set();
  // Decorators seen in a class body, waiting for the member they decorate.
  let pendingDecorators = [];
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

  /**
   * `const utils = require('./support/utils')` is the same statement as an
   * import, written the older way. Half of a plain-JS repository binds its
   * modules like this, and without it every `utils.foo()` looked like a call
   * on a name that came from nowhere.
   *
   * Handles the namespace form, destructuring, and `require('m').thing`.
   */
  function readRequire(node) {
    const declarator = node.type === 'variable_declarator' ? node : null;
    if (!declarator) return false;
    const value = childByField(declarator, 'value');
    const nameNode = childByField(declarator, 'name');
    if (!value || !nameNode) return false;

    // `require('m')` itself, or `require('m').member`
    let call = value;
    let member = null;
    if (value.type === 'member_expression') {
      call = childByField(value, 'object');
      member = childByField(value, 'property');
    }
    if (call?.type !== 'call_expression') return false;
    const fn = childByField(call, 'function');
    if (!fn || text(fn, src) !== 'require') return false;
    const args = childByField(call, 'arguments');
    const first = args?.namedChild(0);
    if (!first || !['string', 'template_string'].includes(first.type)) return false;
    const spec = unquote(first);

    if (member) {
      imports.push({
        fqn: spec, simple: text(nameNode, src), orig: text(member, src),
        is_wildcard: 0, is_static: 0, kind: 'import',
      });
      return true;
    }
    if (nameNode.type === 'object_pattern') {
      for (let i = 0; i < nameNode.namedChildCount; i++) {
        const el = nameNode.namedChild(i);
        if (!el) continue;
        const key = childByField(el, 'key') ?? el;
        const alias = childByField(el, 'value') ?? key;
        imports.push({
          fqn: spec, simple: text(alias, src), orig: text(key, src),
          is_wildcard: 0, is_static: 0, kind: 'import',
        });
      }
      return true;
    }
    imports.push({
      fqn: spec, simple: text(nameNode, src), orig: '*',
      is_wildcard: 1, is_static: 0, kind: 'import',
    });
    return true;
  }

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

  function readParams(paramsNode, ownerTmpId, containerFqn, extra = {}) {
    const params = [];
    if (!paramsNode) return params;

    for (let i = 0; i < paramsNode.namedChildCount; i++) {
      const p = paramsNode.namedChild(i);
      if (!p) continue;

      // JavaScript writes a parameter as a bare identifier; only TypeScript
      // wraps it in required_parameter. Missing this made every parameter in a
      // .js file invisible, so calls on one fell through to name guessing.
      const isPlain = ['identifier', 'assignment_pattern', 'rest_pattern'].includes(p.type);
      if (!isPlain && !['required_parameter', 'optional_parameter'].includes(p.type)) continue;

      const patt = isPlain
        ? (p.type === 'identifier' ? p : (childByField(p, 'left') ?? firstOfType(p, 'identifier')))
        : (childByField(p, 'pattern') ?? firstOfType(p, 'identifier'));
      const name = patt ? text(patt, src) : null;
      const ann = isPlain ? null : (firstOfType(p, 'type_annotation') ?? childByField(p, 'type'));
      const typeName = isPlain ? null : typeFromAnnotation(p, src);
      params.push({ name, type: typeName });

      if (name && ownerTmpId != null) {
        locals.push({
          scopeTmpId: ownerTmpId,
          name,
          type_name: typeName,
          type_args: ann ? elementOf(text(ann, src)) : null,
          ...extra,
        });
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
          type_args: ann ? elementOf(text(ann, src)) : null,
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

      case 'variable_declarator':
        if (readRequire(node)) return;
        break;

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

      const decorators = [];
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c?.type === 'decorator') {
          const d = readDecorator(c, src);
          if (d) decorators.push(d);
        }
      }

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
        annotations: decorators.map((d) => d.name),
        ...pos(node),
      });
      for (const d of decorators) {
        refs.push({ fromTmpId: id, name: d.name, receiver: null, arity: null, str_args: d.strArgs, line: d.line, kind: 'annotation' });
      }

      const body = childByField(node, 'body');
      if (body) {
        // A method's decorators are its preceding siblings in the class body,
        // so they are gathered here and handed to the next member walked.
        let pending = [];
        for (let i = 0; i < body.namedChildCount; i++) {
          const c = body.namedChild(i);
          if (!c) continue;
          if (c.type === 'decorator') {
            const d = readDecorator(c, src);
            if (d) pending.push(d);
            continue;
          }
          pendingDecorators = pending;
          walk(c, [...typeStack, fqn], id, false);
          pendingDecorators = [];
          pending = [];
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
      const ret = typeFromAnnotation(node, src) ?? inferredReturn(childByField(node, 'body'), src);

      const decorators = pendingDecorators;
      pendingDecorators = [];
      const id = addSymbol({
        name: simpleName,
        fqn: `${containerFqn}#${simpleName}`,
        kind: isCtor ? 'constructor' : 'method',
        container_fqn: containerFqn,
        type_name: ret,
        type_args: elementFromAnnotation(node, src),
        signature: simpleName,
        arity: 0,
        supertypes: [],
        modifiers: [],
        annotations: decorators.map((d) => d.name),
        ...pos(node),
      });
      for (const d of decorators) {
        refs.push({ fromTmpId: id, name: d.name, receiver: null, arity: null, str_args: d.strArgs, line: d.line, kind: 'annotation' });
      }

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
          type_args: elementFromAnnotation(node, src),
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
      const ret = typeFromAnnotation(node, src) ?? inferredReturn(childByField(node, 'body'), src);

      const id = addSymbol({
        name: simpleName,
        fqn: `${modulePath}:${simpleName}`,
        kind: 'function',
        container_fqn: modulePath,
        type_name: ret,
        type_args: elementFromAnnotation(node, src),
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

        // `export const initTRPC = new TRPCBuilder()` -- a value another module
        // imports by name. Only arrow functions were being recorded as
        // symbols, so a singleton like this existed nowhere the importer could
        // see it, and every `initTRPC.create()` in another file died at the
        // first hop: 600-odd calls in trpc from this one declaration.
        if (exported && scopeId === fileScope) {
          addSymbol({
            name: varName,
            fqn: `${modulePath}:${varName}`,
            kind: 'field',
            container_fqn: modulePath,
            type_name: typeName,
            signature: `${varName}${typeName ? `: ${typeName}` : ''}`,
            arity: null,
            supertypes: [],
            modifiers: ['export'],
            annotations: [],
            ...pos(node),
          });
        }

        // The initialiser is walked first so the local can name the exact ref
        // its value came from. Matching by line instead lost every multi-line
        // chain: `const m = await Test.createTestingModule({...}).compile();`
        // declares on one line and makes its last call on another.
        if (value) walk(value, typeStack, scopeId, false);

        if (scopeId != null) {
          const awaited = value?.type === 'await_expression';
          const call = awaited ? (value.namedChild(0) ?? value) : value;
          const initRefTmp = call ? (callRefByNode.get(call.id) ?? null) : null;
          // `const res = new PassThrough()` needs no inference: the
          // constructor names the type. Without this every such variable was
          // untypeable, and axios -- which builds its fakes this way -- lost
          // 300 calls to it.
          let constructed = null;
          if (!typeName && value?.type === 'new_expression') {
            const ctor = childByField(value, 'constructor');
            constructed = ctor ? bareType(text(ctor, src)) : null;
          }
          // `const manager = connection.manager` -- no annotation, no call, so
          // there was nothing to infer from and the variable stayed untyped,
          // taking every call on it down with it. The path itself is the
          // answer: each segment is a declared field, and the resolver can
          // walk it once the whole project is indexed.
          let initPath = null;
          if (!typeName && !constructed && initRefTmp == null && value?.type === 'member_expression') {
            const written = text(value, src).trim();
            if (/^(?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(written)) {
              initPath = written;
            }
          }
          locals.push({
            scopeTmpId: scopeId,
            name: varName,
            type_name: typeName ?? constructed,
            type_args: elementFromAnnotation(node, src),
            line: node.startPosition.row + 1,
            // Flags `const x = svc.doThing()` for return-type inference later.
            // `await` is not incidental: the callee returns Promise<T> and the
            // variable holds the T.
            ownerRefTmp: typeName || constructed ? null : initRefTmp,
            init_kind:
              typeName || constructed
                ? null
                : initRefTmp == null
                  ? initPath
                    ? 'path'
                    : null
                  : awaited
                    ? 'await'
                    : 'call',
            init_path: initPath,
          });
        }
      }

      return;
    }

    if (node.type === 'call_expression') {
      const fn = childByField(node, 'function');
      const args = childByField(node, 'arguments');
      if (fn) {
        if (fn.type === 'member_expression') {
          const obj = childByField(fn, 'object');
          const prop = childByField(fn, 'property');

          // Receiver first, so a.b().c() can link c() back to b().
          let receiverRefTmp = null;
          if (obj) {
            walk(obj, typeStack, scopeId, false);
            // The receiver's own ref, not whatever its arguments pushed last.
            receiverRefTmp = callRefByNode.get(obj.id) ?? null;
          }

          if (prop) {
            callRefByNode.set(node.id, refs.length);
            refs.push({
              fromTmpId: scopeId,
              name: text(prop, src),
              receiver: obj ? text(obj, src) : null,
              receiverRefTmp,
              arity: args ? args.namedChildCount : null,
              str_args: stringArgs(args, src),
              line: node.startPosition.row + 1,
              kind: 'call',
            });
          }
          if (args) walk(args, typeStack, scopeId, false);
          return;
        }
        if (fn.type === 'identifier') {
          callRefByNode.set(node.id, refs.length);
          refs.push({
            fromTmpId: scopeId,
            name: text(fn, src),
            receiver: null,
            receiverRefTmp: null,
            arity: args ? args.namedChildCount : null,
            str_args: stringArgs(args, src),
            line: node.startPosition.row + 1,
            kind: 'call',
          });
        }
      }
    }

    if (node.type === 'new_expression') {
      const ctor = childByField(node, 'constructor');
      const args = childByField(node, 'arguments');
      // `new (resolveClass())()` and friends have no name to record.
      const ctorName = ctor ? bareType(text(ctor, src)) : null;
      if (ctorName) {
        refs.push({
          fromTmpId: scopeId,
          name: ctorName,
          receiver: null,
          arity: args ? args.namedChildCount : null,
          line: node.startPosition.row + 1,
          kind: 'new',
        });
      }
    }

    // An arrow passed straight into a call -- `.then(user => ...)`. Its
    // parameter holds one element of what that call's receiver produces, and
    // only the resolver can say what that is, so the link is recorded here.
    if (node.type === 'arrow_function' && scopeId != null && !arrowSeen.has(node.id)) {
      arrowSeen.add(node.id);
      let owner = node.parent;
      while (owner && owner.type !== 'call_expression') owner = owner.parent;
      const ownerRefTmp = owner ? (callRefByNode.get(owner.id) ?? null) : null;
      if (ownerRefTmp != null) {
        readParams(childByField(node, 'parameters') ?? childByField(node, 'parameter'), scopeId, null, {
          ownerRefTmp,
          init_kind: 'lambda',
        });
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      // `export const x = ...` is three nodes deep: the export statement, the
      // declaration, then the declarator that carries the name. Dropping the
      // flag at the first hop meant nothing below an export ever knew it was
      // one, which is why `export const initTRPC = new TRPCBuilder()` existed
      // nowhere another module could import it from.
      const stillExported = exported && node.type === 'lexical_declaration';
      if (c) walk(c, typeStack, scopeId, stillExported);
    }
  }

  // Module-level statements (`export const x = atom(...)`, side-effect calls)
  // need somewhere to belong, or every one of them is an orphaned reference.
  const fileScope = addSymbol({
    name: (ctx.path ?? modulePath).split('/').pop(),
    fqn: modulePath,
    kind: 'file',
    container_fqn: null,
    type_name: null,
    signature: `module ${modulePath}`,
    arity: null,
    supertypes: [],
    modifiers: [],
    annotations: [],
    start_line: 1,
    end_line: tree.rootNode.endPosition.row + 1,
    start_byte: 0,
    end_byte: tree.rootNode.endIndex,
  });

  walk(tree.rootNode, [], fileScope, false);
  readCommonJs(tree.rootNode, src, modulePath, symbols, addSymbol, pos);

  return { package: modulePath, imports, symbols, refs, locals };
}

/**
 * The CommonJS half of a module, which no `export` keyword ever announces.
 *
 * Node code says `module.exports = View` to export, `User.all = function(){}`
 * to hang a member off a constructor, and `User.prototype.render = ...` for an
 * instance one. None of it is syntax the ESM reader looks at, so a plain-JS
 * repository exported nothing and its constructors had no members at all.
 *
 * Run after the walk, so every function this names already has its symbol.
 */
function readCommonJs(root, src, modulePath, symbols, addSymbol, pos) {
  const moduleLevel = new Map();
  for (const s of symbols) {
    if (['function', 'class'].includes(s.kind) && s.container_fqn === modulePath) {
      moduleLevel.set(s.name, s);
    }
  }
  if (!moduleLevel.size) return;

  const visit = (node) => {
    if (node.type === 'assignment_expression') {
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      const target = left ? text(left, src) : '';

      // `module.exports = View` / `exports = module.exports = View`
      const exported = /^(?:module\.)?exports$/.test(target) && right?.type === 'identifier';
      if (exported) {
        const owner = moduleLevel.get(text(right, src));
        if (owner) owner.modifiers = [...new Set([...(owner.modifiers ?? []), 'export', 'cjs-default'])];
      }

    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) visit(c);
    }
  };
  visit(root);
}
