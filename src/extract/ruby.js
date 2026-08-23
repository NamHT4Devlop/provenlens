/**
 * Ruby extractor.
 *
 * Ruby resists static analysis, so this leans on two things that do hold in
 * practice:
 *   1. `x = Foo.new` types a local exactly.
 *   2. Rails associations follow naming conventions, so `belongs_to :donor`
 *      can be turned into a real method returning a real class.
 *
 * Methods invented from a DSL are marked `generated: true` and annotated with
 * the macro that produced them, so nothing downstream mistakes them for code
 * that exists on disk.
 */

/** `line_item` -> `LineItem`, with no singularisation of its own. */
export function camelize(name) {
  return name
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** `line_items` -> `LineItem`. Deliberately simple; irregulars are not covered. */
export function classify(name) {
  return camelize(singularize(name));
}

export function singularize(word) {
  if (/ies$/.test(word)) return word.replace(/ies$/, 'y');
  if (/(ch|sh|ss|x|z)es$/.test(word)) return word.replace(/es$/, '');
  // `status`, `address`, `analysis` are singular already despite the trailing s.
  if (/s$/.test(word) && !/(ss|us|is)$/.test(word)) return word.replace(/s$/, '');
  return word;
}

const ASSOCIATION_MACROS = new Set(['belongs_to', 'has_one', 'has_many', 'has_and_belongs_to_many']);

/**
 * Finders that hand back an instance of the model they are called on. These
 * are ActiveRecord's, and the constant on the left names the class -- the
 * resolver still checks that class really is a record before trusting it.
 */
const AR_FINDERS = new Set([
  'new', 'create', 'create!', 'find', 'find!', 'find_by', 'find_by!', 'first', 'last', 'take',
  'find_or_create_by', 'find_or_create_by!', 'find_or_initialize_by', 'build',
]);

/** Factory helpers whose symbol argument names the model they build. */
const FACTORY_BARE = new Set(['create', 'build', 'build_stubbed', 'create_list', 'build_list']);
const FACTORY_CONST = new Set(['Fabricate', 'FactoryBot', 'FactoryGirl']);

/**
 * The class an expression yields, when the source says so plainly:
 *
 *   User.new / User.find(id) / User.find_by(...)   -> User
 *   Fabricate(:user) / create(:user)               -> User
 *
 * A factory's symbol argument names its model by construction -- that is the
 * whole contract of `Fabricate(:user)` -- and in a spec suite it is the only
 * thing that ever says what `let(:user)` holds.
 *
 * Returns { name, via } so the caller can keep the two apart: a finder still
 * has to be checked against the class's ancestry, a factory does not.
 */
function modelTypeOf(node, src, childByField, argNodes, text) {
  if (!node || node.type !== 'call') return null;
  const method = childByField(node, 'method');
  const recv = childByField(node, 'receiver');
  const args = argNodes(node);
  const symbolArg = args.find((a) => a?.type === 'simple_symbol');
  const asModel = (sym) => classify(text(sym, src).replace(/^:/, ''));

  // `Fabricate(:user)` -- the constant IS the callee, so there is no receiver.
  if (!recv && method?.type === 'constant' && FACTORY_CONST.has(text(method, src))) {
    return symbolArg ? { name: asModel(symbolArg), via: 'factory' } : null;
  }
  // `Fabricate.build(:user)`, `FactoryBot.create(:user)`
  if (recv?.type === 'constant' && FACTORY_CONST.has(text(recv, src))) {
    return symbolArg ? { name: asModel(symbolArg), via: 'factory' } : null;
  }
  // Bare `create(:user)` -- the symbol argument is what marks it as a factory
  // rather than some other create.
  if (!recv && method?.type === 'identifier' && FACTORY_BARE.has(text(method, src)) && symbolArg) {
    return { name: asModel(symbolArg), via: 'factory' };
  }
  // `User.find(id)` and friends.
  if (recv?.type === 'constant' && method && AR_FINDERS.has(text(method, src))) {
    return { name: text(recv, src), via: text(method, src) === 'new' ? 'construct' : 'finder' };
  }
  return null;
}

/** The value of a `key:` argument in a macro call, as plain text. */
function keywordArg(args, key) {
  for (const arg of args) {
    const pairs = arg.type === 'pair' ? [arg] : [];
    if (arg.type === 'hash' || arg.type === 'bare_hash' || arg.type === 'keyword_hash') {
      for (let i = 0; i < arg.namedChildCount; i++) {
        const c = arg.namedChild(i);
        if (c?.type === 'pair') pairs.push(c);
      }
    }
    for (const pair of pairs) {
      const k = pair.childForFieldName('key');
      const v = pair.childForFieldName('value');
      if (!k || !v) continue;
      const keyText = k.text.replace(/[:'"]/g, '');
      if (keyText === key) return v.text.replace(/^:/, '').replace(/^['"]|['"]$/g, '');
    }
  }
  return null;
}
const COLLECTION_MACROS = new Set(['has_many', 'has_and_belongs_to_many']);
const ATTR_MACROS = new Set(['attr_reader', 'attr_writer', 'attr_accessor']);

function text(node, src) {
  return src.slice(node.startIndex, node.endIndex);
}

function childByField(node, field) {
  return node.childForFieldName(field) ?? null;
}

/** `:donor` -> `donor`, `"donor"` -> `donor` */
function symbolArgName(node, src) {
  if (!node) return null;
  const raw = text(node, src).trim();
  if (raw.startsWith(':')) return raw.slice(1);
  const unquoted = raw.replace(/^['"]|['"]$/g, '');
  return /^[a-z_][\w]*[?!=]?$/i.test(unquoted) ? unquoted : null;
}

/** Literal string values of the arguments; null wherever it is not a literal. */
function stringArgs(callNode, src) {
  const out = [];
  let any = false;
  for (const arg of argNodes(callNode)) {
    if (arg.type === 'string' || arg.type === 'simple_symbol') {
      out.push(src.slice(arg.startIndex, arg.endIndex).replace(/^[:'"]|['"]$/g, ''));
      any = true;
    } else out.push(null);
  }
  return any ? out : null;
}

function argNodes(callNode) {
  const args = childByField(callNode, 'arguments');
  if (!args) return [];
  const out = [];
  for (let i = 0; i < args.namedChildCount; i++) {
    const c = args.namedChild(i);
    if (c) out.push(c);
  }
  return out;
}

const RSPEC_BINDERS = new Set(['let', 'let!', 'subject']);
const RSPEC_DESCRIBERS = new Set(['describe', 'context', 'RSpec.describe', 'feature']);

export function extractRuby(tree, src, ctx = {}) {
  const symbols = [];
  const refs = [];
  /** node id -> index of the ref that node's own call produced. */
  const callRefByNode = new Map();
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

  /** Turns a Rails macro call in a class body into the methods it defines. */
  function applyMacro(callNode, containerFqn, ownerName) {
    const macro = text(childByField(callNode, 'method'), src);
    const args = argNodes(callNode);
    const first = symbolArgName(args[0], src);

    const generated = (name, typeName, extra = {}) =>
      // addSymbol hands back the symbol's index, which delegate needs for its
      // synthetic call site.
      addSymbol({
        name,
        fqn: `${containerFqn}#${name}`,
        kind: 'method',
        container_fqn: containerFqn,
        type_name: typeName,
        signature: `${name}  # generated by ${macro}`,
        arity: 0,
        supertypes: [],
        modifiers: ['generated'],
        annotations: [macro],
        generated: true,
        ...extra,
        ...pos(callNode),
      });

    if (ASSOCIATION_MACROS.has(macro) && first) {
      const isCollection = COLLECTION_MACROS.has(macro);
      generated(first, classify(first), {
        modifiers: isCollection ? ['generated', 'collection'] : ['generated'],
      });
      if (!isCollection) generated(`${first}=`, classify(first));
      return true;
    }

    if (ATTR_MACROS.has(macro)) {
      for (const arg of args) {
        const name = symbolArgName(arg, src);
        if (!name) continue;
        if (macro !== 'attr_writer') generated(name, null);
        if (macro !== 'attr_reader') generated(`${name}=`, null);
      }
      return true;
    }

    if (macro === 'delegate') {
      // `delegate :name, :email, to: :owner` writes forwarding methods. The
      // forward is real code as far as callers are concerned, so each one
      // becomes a generated method AND a synthetic call site to the target --
      // the resolver then links the forward exactly as if it were handwritten.
      const to = keywordArg(args, 'to');
      const prefix = keywordArg(args, 'prefix');
      if (!to) return false;
      let made = false;
      for (const arg of args) {
        const name = symbolArgName(arg, src);
        if (!name) continue;
        const exposed = prefix === 'true' ? `${to}_${name}` : name;
        const id = generated(exposed, null, { annotations: ['delegate', `to:${to}`] });
        refs.push({
          fromTmpId: id,
          name,
          receiver: to,
          arity: 0,
          str_args: [],
          line: callNode.startPosition.row + 1,
          kind: 'call',
        });
        made = true;
      }
      return made;
    }

    if (macro === 'scope' && first) {
      addSymbol({
        name: first,
        fqn: `${containerFqn}.${first}`,
        kind: 'class_method',
        container_fqn: containerFqn,
        type_name: ownerName,
        signature: `${first}  # generated by scope`,
        arity: 0,
        supertypes: [],
        modifiers: ['generated'],
        annotations: ['scope'],
        generated: true,
        ...pos(callNode),
      });
      return true;
    }

    return false;
  }

  // Created before the walk so RSpec bindings, which live at file level, have
  // somewhere to attach as they are encountered.
  const fileScopeId = addSymbol({
    name: (ctx.path ?? 'file').split('/').pop(),
    fqn: ctx.path ?? null,
    kind: 'file',
    container_fqn: null,
    type_name: null,
    signature: `file ${ctx.path ?? ''}`,
    arity: null,
    supertypes: [],
    modifiers: [],
    annotations: [],
    start_line: 1,
    end_line: tree.rootNode.endPosition.row + 1,
    start_byte: 0,
    end_byte: tree.rootNode.endIndex,
  });

  /** What `RSpec.describe Account do` is about; types a bare `subject`. */
  let describedClass = null;

  /**
   * The class a `X.new` inside a block constructs, which is what types an
   * RSpec `let` or `subject`. Only a direct construction counts; anything
   * cleverer is left untyped rather than guessed at.
   */
  function constructedTypeIn(node) {
    if (!node) return null;
    let found = null;
    const scan = (n, depth) => {
      if (found || depth > 6) return;
      if (n.type === 'call') {
        const model = modelTypeOf(n, src, childByField, argNodes, text);
        if (model) {
          found = model.name;
          return;
        }
      }
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (c) scan(c, depth + 1);
      }
    };
    scan(node, 0);
    return found;
  }

  function walk(node, nest, scopeId, inClassBody, classScopeId) {
    if (node.type === 'class' || node.type === 'module') {
      const nameNode = childByField(node, 'name');
      if (!nameNode) return;
      const simpleName = text(nameNode, src);
      const nextNest = [...nest, simpleName];
      const fqn = nextNest.join('::');

      const supertypes = [];
      const superNode = childByField(node, 'superclass');
      if (superNode) {
        // The `superclass` node wraps the constant, hence the trim of `<`.
        const raw = text(superNode, src).replace(/^\s*<\s*/, '').trim();
        if (raw) supertypes.push(raw);
      }

      const id = addSymbol({
        name: simpleName,
        fqn,
        kind: node.type === 'module' ? 'module' : 'class',
        container_fqn: nest.length ? nest.join('::') : null,
        type_name: null,
        signature: `${node.type} ${fqn}`,
        arity: null,
        supertypes,
        modifiers: [],
        annotations: [],
        ...pos(node),
      });

      // Walked after the symbol exists, because `include Foo` appends to its
      // supertypes as it is encountered.
      const body = childByField(node, 'body');
      if (body) {
        for (let i = 0; i < body.namedChildCount; i++) {
          const c = body.namedChild(i);
          if (c) walk(c, nextNest, id, true, id);
        }
      }
      return;
    }

    if (node.type === 'method' || node.type === 'singleton_method') {
      const nameNode = childByField(node, 'name');
      if (!nameNode) return;
      const simpleName = text(nameNode, src);
      const containerFqn = nest.join('::') || null;
      const isSingleton = node.type === 'singleton_method';

      const params = [];
      const paramsNode = childByField(node, 'parameters');
      if (paramsNode) {
        for (let i = 0; i < paramsNode.namedChildCount; i++) {
          const p = paramsNode.namedChild(i);
          if (!p) continue;
          params.push(text(p, src).split(/[:=]/)[0].trim());
        }
      }

      const id = addSymbol({
        name: simpleName,
        fqn: `${containerFqn}${isSingleton ? '.' : '#'}${simpleName}`,
        kind: isSingleton ? 'class_method' : 'method',
        container_fqn: containerFqn,
        type_name: null,
        signature: `${isSingleton ? 'self.' : ''}${simpleName}(${params.join(', ')})`,
        arity: params.length,
        supertypes: [],
        modifiers: isSingleton ? ['singleton'] : [],
        annotations: [],
        ...pos(node),
      });

      // Recorded so the resolver can tell "a name we simply cannot type" from
      // "a name this repository never declares". Only the second is proof that
      // the value came from outside.
      for (const name of params) {
        if (/^[a-z_][\w]*$/.test(name)) locals.push({ scopeTmpId: id, name, type_name: null, init_kind: 'param' });
      }

      const body = childByField(node, 'body');
      if (body) walk(body, nest, id, false, classScopeId);
      return;
    }

    if (node.type === 'call') {
      const methodNode = childByField(node, 'method');
      const receiverNode = childByField(node, 'receiver');
      const methodName = methodNode ? text(methodNode, src) : null;

      // Class-body DSL calls define things rather than call them.
      if (inClassBody && !receiverNode && methodName) {
        const containerFqn = nest.join('::') || null;
        if (methodName === 'include' || methodName === 'extend' || methodName === 'prepend') {
          const mod = argNodes(node)[0];
          if (mod && scopeId != null) {
            symbols[scopeId].supertypes = [...(symbols[scopeId].supertypes ?? []), text(mod, src)];
          }
          return;
        }
        // A concern's `included do ... end` runs in the includer's class body,
        // so its macros belong to this module the same way its instance
        // methods do -- the module->includer machinery carries both across.
        if (methodName === 'included') {
          const block = childByField(node, 'block');
          const blockBody = block ? childByField(block, 'body') ?? block : null;
          if (blockBody) {
            for (let i = 0; i < blockBody.namedChildCount; i++) {
              const c = blockBody.namedChild(i);
              if (c) walk(c, nest, scopeId, true, classScopeId);
            }
            return;
          }
        }
        if (containerFqn && applyMacro(node, containerFqn, nest[nest.length - 1])) return;
      }

      // RSpec binds names with blocks rather than assignment: `let(:user) {
      // User.new }` makes `user` available to every example below it. Those
      // bindings are most of a spec file, so without them a spec resolves to
      // almost nothing.
      if (methodName && !receiverNode && RSPEC_BINDERS.has(methodName)) {
        const args = argNodes(node);
        const bound =
          methodName === 'subject' ? (symbolArgName(args[0], src) ?? 'subject') : symbolArgName(args[0], src);
        const block = childByField(node, 'block');
        const built = constructedTypeIn(block) ?? describedClass;
        // Recorded even untyped: `let(:thing)` still declares the name, and a
        // name this file declares must not be mistaken for one from a gem.
        if (bound) {
          locals.push({ scopeTmpId: fileScopeId, name: bound, type_name: built ?? null, init_kind: 'let' });
          if (methodName === 'subject' && bound !== 'subject') {
            locals.push({ scopeTmpId: fileScopeId, name: 'subject', type_name: built ?? null, init_kind: 'let' });
          }
        }
      }

      // `RSpec.describe Account do` names what the file is about, which is what
      // `described_class` and a bare `subject` refer to.
      if (methodName && RSPEC_DESCRIBERS.has(methodName) && !describedClass) {
        const first = argNodes(node)[0];
        if (first && first.type === 'constant') {
          describedClass = text(first, src);
          locals.push({ scopeTmpId: fileScopeId, name: 'described_class', type_name: describedClass });
        }
      }

      // Receiver first, so foo.bar.baz can link baz back to bar.
      let receiverRefTmp = null;
      if (receiverNode) {
        walk(receiverNode, nest, scopeId, false, classScopeId);
        // The receiver's OWN ref, looked up by node -- not the last ref the
        // subtree produced. Arguments are walked after the call they belong
        // to, so `expect(response).to` used to link `.to` back to `response`
        // and lose the chain entirely.
        receiverRefTmp = callRefByNode.get(receiverNode.id) ?? null;
      }

      if (methodName) {
        callRefByNode.set(node.id, refs.length);
        refs.push({
          fromTmpId: scopeId,
          name: methodName,
          receiver: receiverNode ? text(receiverNode, src) : null,
          receiverRefTmp,
          arity: argNodes(node).length,
          str_args: stringArgs(node, src),
          line: node.startPosition.row + 1,
          kind: methodName === 'new' && receiverNode ? 'new' : 'call',
        });

        if ((methodName === 'require' || methodName === 'require_relative') && argNodes(node).length) {
          const arg = text(argNodes(node)[0], src).replace(/^['"]|['"]$/g, '');
          imports.push({ fqn: arg, simple: arg.split('/').pop(), is_wildcard: 0, is_static: 0 });
        }
      }

      // Arguments and any block still need walking; the receiver already was.
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (!c || c === receiverNode || c === methodNode) continue;
        if (receiverNode && c.startIndex === receiverNode.startIndex) continue;
        walk(c, nest, scopeId, false, classScopeId);
      }
      return;
    }

    // `each do |item|` binds a name this scope did not declare; recording it
    // keeps the "declared nowhere" proof from firing on a block variable.
    if ((node.type === 'block' || node.type === 'do_block') && scopeId != null) {
      let bp = childByField(node, 'parameters');
      if (!bp) {
        for (let i = 0; i < node.namedChildCount; i++) {
          if (node.namedChild(i)?.type === 'block_parameters') {
            bp = node.namedChild(i);
            break;
          }
        }
      }
      if (bp) {
        for (let i = 0; i < bp.namedChildCount; i++) {
          const name = text(bp.namedChild(i), src).split(/[:=]/)[0].trim();
          if (/^[a-z_][\w]*$/.test(name)) {
            locals.push({ scopeTmpId: scopeId, name, type_name: null, init_kind: 'block-param' });
          }
        }
      }
    }

    if (node.type === 'assignment') {
      const left = childByField(node, 'left');
      const right = childByField(node, 'right');
      // `@rubygem = Rubygem.find(id)` is how a Rails controller says what the
      // ivar holds, and nothing else in the file ever will.
      if (left && right) {
        const model = modelTypeOf(right, src, childByField, argNodes, text);
        const name = text(left, src);
        if (/^@?[a-z_][\w]*$/.test(name)) {
          locals.push({
            // An ivar outlives the method, so it belongs to the class scope.
            scopeTmpId: left.type === 'instance_variable' ? classScopeId : scopeId,
            name,
            type_name: model?.name ?? null,
            init_kind: model?.via ?? 'assigned',
          });
        }
      }
    }

    // A bare identifier in a method body is usually an implicit-self call.
    // These are noisy by nature, so the resolver drops the ones that match
    // nothing rather than reporting them as unresolved.
    if (node.type === 'identifier' && scopeId != null && !inClassBody) {
      const p = node.parent;
      const sameNode = (a, b) => a && b && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
      const isCallMethod = p?.type === 'call' && sameNode(childByField(p, 'method'), node);
      const isAssignTarget = p?.type === 'assignment' && sameNode(childByField(p, 'left'), node);
      const isParam = p?.type === 'method_parameters' || p?.type === 'block_parameters';
      if (!isCallMethod && !isAssignTarget && !isParam) {
        refs.push({
          fromTmpId: scopeId,
          name: text(node, src),
          receiver: null,
          arity: 0,
          line: node.startPosition.row + 1,
          kind: 'ident_call',
        });
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) walk(c, nest, scopeId, inClassBody && node.type === 'body_statement', classScopeId);
    }
  }

  walk(tree.rootNode, [], fileScopeId, false, null);

  return { package: null, imports, symbols, refs, locals };
}
