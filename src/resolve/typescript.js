/**
 * TypeScript / JavaScript resolver.
 *
 * The work here is mostly module resolution: a call only becomes an edge once
 * `import { X } from '@domain/donation'` has been turned into a real file, and
 * barrel files mean that can take several hops.
 *
 *   1.0  direct           -- receiver typed by an annotation, `new`, or a field
 *   0.9  interface->impl  -- receiver was an interface; linked to implementations
 *   0.5  unique-name      -- no type info, exactly one match in the project
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, normalize, relative } from 'node:path';

const TS_LANGS = ['typescript', 'tsx', 'javascript'];
const LANG_LIST = TS_LANGS.map((l) => `'${l}'`).join(', ');

const EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

/**
 * Methods every value carries because the language gives them, not because a
 * package does. There is no import to follow and no ancestor to walk, so they
 * cannot be proven external the way a library call can -- this is a strong
 * assumption, and it is recorded under its own owner so it stays separable
 * from the proofs.
 *
 * Only consulted when the receiver has no known type. A receiver typed to a
 * class in this project resolves against that class first, so a project method
 * named `get` or `map` is never shadowed by this list.
 */
const JS_RUNTIME = new Set([
  // Array
  'map', 'filter', 'forEach', 'reduce', 'reduceRight', 'find', 'findIndex', 'findLast',
  'some', 'every', 'includes', 'indexOf', 'lastIndexOf', 'join', 'slice', 'splice',
  'concat', 'sort', 'reverse', 'flat', 'flatMap', 'push', 'pop', 'shift', 'unshift',
  'fill', 'at', 'keys', 'values', 'entries', 'isArray', 'from', 'of',
  // Map and Set
  'get', 'set', 'has', 'delete', 'clear', 'add',
  // Promise
  'then', 'catch', 'finally', 'all', 'allSettled', 'race', 'resolve', 'reject',
  // String
  'split', 'trim', 'trimStart', 'trimEnd', 'replace', 'replaceAll', 'toLowerCase',
  'toUpperCase', 'startsWith', 'endsWith', 'padStart', 'padEnd', 'substring', 'substr',
  'charAt', 'charCodeAt', 'codePointAt', 'match', 'matchAll', 'repeat', 'normalize',
  'localeCompare', 'search',
  // Object, Number, JSON and friends
  'hasOwnProperty', 'toString', 'valueOf', 'toFixed', 'toPrecision', 'stringify',
  'parse', 'assign', 'freeze', 'bind', 'call', 'apply', 'toISOString', 'getTime',
]);

/**
 * Members every value has, because the prototype chain ends there.
 *
 * `Function.prototype` gives `bind`, `call` and `apply` to every function and
 * every class; `Object.prototype` gives the rest to everything. A type that
 * does not declare one is not missing it -- n8n writes `const Template:
 * StoryFn = ...` then `Template.bind({})` 128 times, and reporting those as
 * members `Template` lacks blames the repository for the language.
 *
 * Kept deliberately short. The wider runtime list is consulted only for a
 * receiver that could not be typed, because a name like `get` or `map` is one
 * a project class really may declare, and excusing those would hide the misses
 * this tool exists to report.
 */
const UNIVERSAL_MEMBERS = new Set([
  'bind', 'call', 'apply',
  'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
  'propertyIsEnumerable', 'constructor',
]);

/**
 * Functions the language provides with no receiver at all.
 *
 * The list above is prototype methods and is deliberately not consulted for a
 * bare call -- `get()` alone is not `Map.get`. These are the opposite case:
 * they are *called* bare, by everyone, and a project that happens to have a
 * method somewhere named `clearTimeout` is not what `clearTimeout(handle)`
 * reaches. A module-level function or import of the same name is tried first
 * and wins, so shadowing still resolves the way the file wrote it.
 */
const GLOBAL_FUNCTIONS = new Set([
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'setImmediate', 'clearImmediate', 'queueMicrotask', 'structuredClone',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'btoa', 'atob',
]);

/** Constructors the runtime provides, for `new Set()` and the like. */
const JS_GLOBALS = new Set([
  'Set', 'Map', 'WeakMap', 'WeakSet', 'Promise', 'Date', 'RegExp', 'Error', 'TypeError',
  'RangeError', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Proxy', 'URL',
  'URLSearchParams', 'AbortController', 'TextEncoder', 'TextDecoder', 'Intl', 'Blob',
  'FormData', 'Headers', 'Request', 'Response', 'Event', 'EventTarget',
]);

/**
 * Every tsconfig in the tree, with the paths each one declares.
 *
 * A workspace declares its aliases in its own tsconfig, not the one at the
 * top -- immich answers `src/decorators` from `server/tsconfig.json`, and
 * there is no tsconfig at its root at all. Reading only the root meant every
 * such import resolved to nothing, so an ordinary call to an imported
 * function was mistaken for a method on `this` and reported as missing from a
 * class that had never declared it.
 *
 * Each config's `paths` are anchored to the directory that declares them,
 * which is what the compiler does and the only reading that can be right when
 * two workspaces both map `src/*` to different places.
 */
export function readTsconfigScopes(root, maxDepth = 2) {
  const scopes = [];
  const visit = (dir, depth) => {
    const config = readTsconfigPaths(dir);
    if (Object.keys(config.paths).length) {
      const prefix = relative(root, dir).replace(/\\/g, '/');
      scopes.push({ ...config, dir: prefix });
    }
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      visit(join(dir, e.name), depth + 1);
    }
  };
  visit(root, 0);
  return scopes;
}

/**
 * The packages this repository publishes, by the name it publishes them under.
 *
 * A workspace refers to its own packages by name, not by path: zod's tests
 * `import { z } from 'zod'` and mean `packages/zod/src`, and an enterprise
 * monorepo does the same with `@myorg/core`. Without this those imports
 * resolve to nothing, and the repository's own code is booked as a library --
 * 12,177 calls in zod, attributed to a dependency that is the repository.
 */
export function readWorkspacePackages(root, maxDepth = 3) {
  const found = [];
  const visit = (dir, depth) => {
    try {
      const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (meta.name) {
        const rel = relative(root, dir).replace(/\\/g, '/');
        const entry = meta.types ?? meta.typings ?? meta.module ?? meta.main ?? null;
        found.push({ name: meta.name, dir: rel, entry });
      }
    } catch {
      /* no manifest here, or an unreadable one */
    }
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      visit(join(dir, e.name), depth + 1);
    }
  };
  visit(root, 0);
  // The longest name wins when two could match, so `@scope/a-b` is not read as
  // `@scope/a` with a stray suffix.
  return found.sort((a, b) => b.name.length - a.name.length);
}

/** Reads `compilerOptions.paths` so alias imports resolve like the compiler does. */
export function readTsconfigPaths(root) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    try {
      const raw = readFileSync(join(root, name), 'utf8');
      // Strip comments and trailing commas: tsconfig is JSONC in practice.
      const cleaned = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
        .replace(/,(\s*[}\]])/g, '$1');
      const config = JSON.parse(cleaned);
      const opts = config.compilerOptions ?? {};
      if (!opts.paths) continue;
      return { baseUrl: opts.baseUrl ?? '.', paths: opts.paths };
    } catch {
      /* missing or unparseable config just means no aliases */
    }
  }
  return { baseUrl: '.', paths: {} };
}

export function resolveTypeScript(db, root) {
  const scopes = readTsconfigScopes(root);
  const workspaces = readWorkspacePackages(root);

  const files = db
    .prepare(`SELECT id, path, pkg FROM files WHERE lang IN (${LANG_LIST})`)
    .all();
  const moduleToFile = new Map(); // 'src/domain/donation' -> file row
  for (const f of files) moduleToFile.set(f.pkg, f);

  /** Probes the extensions and the `/index` form, like a bundler would. */
  function probe(candidate) {
    const clean = candidate.replace(/\\/g, '/').replace(/^\.\//, '');
    if (moduleToFile.has(clean)) return clean;
    for (const ext of EXTENSIONS) {
      const stripped = clean.endsWith(ext) ? clean.slice(0, -ext.length) : null;
      if (stripped && moduleToFile.has(stripped)) return stripped;
    }
    const asIndex = `${clean}/index`;
    if (moduleToFile.has(asIndex)) return asIndex;
    return null;
  }

  function resolveModule(fromModule, specifier) {
    if (!specifier) return null;

    if (specifier.startsWith('.')) {
      const joined = normalize(join(dirname(fromModule), specifier)).replace(/\\/g, '/');
      return probe(joined);
    }

    // The importing file's own workspace answers first: two workspaces may
    // each map `src/*`, and the nearer one is the one that meant it.
    const ordered = [...scopes].sort(
      (a, b) =>
        (fromModule.startsWith(b.dir) ? b.dir.length : -1) -
        (fromModule.startsWith(a.dir) ? a.dir.length : -1),
    );
    for (const scope of ordered) {
      const base = join(scope.dir, scope.baseUrl);
      for (const [pattern, targets] of Object.entries(scope.paths)) {
        const prefix = pattern.replace(/\*$/, '');
        if (!pattern.endsWith('*')) {
          if (specifier !== pattern) continue;
          for (const target of targets) {
            const hit = probe(normalize(join(base, target)).replace(/\\/g, '/'));
            if (hit) return hit;
          }
          continue;
        }
        if (!specifier.startsWith(prefix)) continue;
        const rest = specifier.slice(prefix.length);
        for (const target of targets) {
          const candidate = normalize(join(base, target.replace(/\*$/, rest))).replace(/\\/g, '/');
          const hit = probe(candidate);
          if (hit) return hit;
        }
      }
    }

    // A name this repository publishes is this repository, not a dependency.
    for (const pkg of workspaces) {
      if (specifier !== pkg.name && !specifier.startsWith(`${pkg.name}/`)) continue;
      const rest = specifier.slice(pkg.name.length).replace(/^\//, '');
      const candidates = rest
        ? [join(pkg.dir, rest), join(pkg.dir, 'src', rest)]
        : [
            pkg.entry ? join(pkg.dir, pkg.entry) : null,
            join(pkg.dir, 'src', 'index'),
            join(pkg.dir, 'index'),
            join(pkg.dir, 'src'),
          ];
      for (const candidate of candidates) {
        if (!candidate) continue;
        const hit = probe(normalize(candidate).replace(/\\/g, '/'));
        if (hit) return hit;
      }
    }

    return null; // bare specifier: node_modules, deliberately out of scope
  }

  const importsByFile = new Map();
  for (const row of db
    .prepare(
      `SELECT i.* FROM imports i JOIN files f ON f.id = i.file_id
        WHERE f.lang IN (${LANG_LIST})`,
    )
    .all()) {
    if (!importsByFile.has(row.file_id)) importsByFile.set(row.file_id, []);
    importsByFile.get(row.file_id).push(row);
  }

  const types = new Map(); // fqn -> { fqn, symbol_id, kind, supertypes, file_id, module }
  for (const row of db
    .prepare(
      `SELECT t.fqn, t.symbol_id, t.kind, t.supertypes, s.file_id, s.name, f.pkg AS module,
              f.external AS isExternal, f.owner AS extOwner
         FROM types t
         JOIN symbols s ON s.id = t.symbol_id
         JOIN files f   ON f.id = s.file_id
        WHERE f.lang IN (${LANG_LIST})`,
    )
    .all()) {
    types.set(row.fqn, { ...row, supertypes: JSON.parse(row.supertypes || '[]') });
  }

  const symbolsByModule = new Map(); // module -> [top-level symbol rows]
  const membersByContainer = new Map();
  const allSymbols = db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.arity, s.fqn, s.container_fqn, s.type_name, s.type_args,
              s.modifiers, f.pkg AS module, s.file_id, f.external AS isExternal, f.owner AS extOwner
         FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE f.lang IN (${LANG_LIST})`,
    )
    .all();

  for (const row of allSymbols) {
    // `field` belongs here too: `export const initTRPC = new TRPCBuilder()` is
    // a value another module imports by name, and leaving it out meant the
    // importer found nothing and every chain through it stopped at one hop.
    if (
      ['class', 'interface', 'function', 'field'].includes(row.kind) &&
      row.container_fqn === row.module
    ) {
      if (!symbolsByModule.has(row.module)) symbolsByModule.set(row.module, []);
      symbolsByModule.get(row.module).push(row);
    }
    if (['method', 'constructor', 'field'].includes(row.kind) && row.container_fqn) {
      if (!membersByContainer.has(row.container_fqn)) membersByContainer.set(row.container_fqn, []);
      membersByContainer.get(row.container_fqn).push(row);
    }
  }

  // Both of these answer "does THIS repository declare that name?", which is
  // the proof that a call cannot land here. A dependency's declarations must
  // stay out of them: reading rxjs must not make `subscribe` look like ours.
  const callablesByName = new Map();
  for (const row of allSymbols) {
    if (row.isExternal) continue;
    if (!['method', 'function'].includes(row.kind)) continue;
    if (!callablesByName.has(row.name)) callablesByName.set(row.name, []);
    callablesByName.get(row.name).push(row);
  }

  /** Follows re-exports until it finds where a name is actually declared. */
  function resolveExport(module, name, seen = new Set()) {
    if (!module || seen.has(`${module}|${name}`)) return null;
    seen.add(`${module}|${name}`);

    const local = (symbolsByModule.get(module) ?? []).find((s) => s.name === name);
    if (local) return local;

    // `require('./view')` asks the module for its whole value, and CommonJS
    // says that value is whatever `module.exports =` named. ESM says it with
    // `export default`, which names the class rather than the export, so the
    // declaration has to carry the mark.
    if (name === '*' || name === 'default') {
      const marked = (symbolsByModule.get(module) ?? []).find((s) =>
        /\b(cjs|esm)-default\b/.test(s.modifiers ?? ''),
      );
      if (marked) return marked;
    }

    const file = moduleToFile.get(module);
    if (!file) return null;

    for (const imp of importsByFile.get(file.id) ?? []) {
      if (imp.kind === 'reexport' && imp.simple === name) {
        const target = resolveModule(module, imp.fqn);
        const hit = target && resolveExport(target, imp.orig ?? name, seen);
        if (hit) return hit;
      }
      if (imp.kind === 'reexport-all') {
        const target = resolveModule(module, imp.fqn);
        const hit = target && resolveExport(target, name, seen);
        if (hit) return hit;
      }
    }
    return null;
  }

  /**
   * A type name as written in a file -> the type symbol it denotes.
   * Returns `undefined` for an array type: the receiver is then an Array, whose
   * members live in the runtime, not in this project.
   */
  function resolveTypeName(name, fileId, module, depth = 0) {
    if (!name) return null;
    // A chain hands this an already-resolved type as often as a name: the
    // regex below coerced one to a string harmlessly, but nothing else here
    // can, so say plainly which of the two arrived.
    if (typeof name !== 'string') return name.fqn ? name : null;
    if (/\[\]$/.test(name)) return undefined;

    // Both forms below name a type by pointing at a declaration rather than
    // spelling one, so each costs a hop -- and `interface Cell { next:
    // Cell['next'] }` is a hop that never ends. The limit is there to end that
    // rather than to ration: a real annotation is one or two hops deep.
    if (depth > 4) return null;

    // `INodeExecutionData['json']` -- an indexed access. TypeScript is not
    // describing a type here, it is pointing at one this index already holds:
    // the `json` member of `INodeExecutionData`, whose own annotation is the
    // answer. Reading it is a declaration lookup, not an inference.
    //
    // Both forms are rare and this function runs millions of times, so each is
    // gated on a character test before its regex.
    const indexed = name.includes('[')
      ? /^([A-Za-z_$][\w$.]*)\s*\[\s*['"]([^'"]+)['"]\s*\]$/.exec(name)
      : null;
    if (indexed) {
      const owner = resolveTypeName(indexed[1], fileId, module, depth + 1);
      const member = owner?.fqn ? findMember(owner, indexed[2]) : null;
      if (!member?.type_name) return null;
      // Resolved where the member was DECLARED, then where the call was
      // written: the file naming `Config['db']` need never have imported the
      // type that `db` happens to hold.
      return (
        resolveTypeName(member.type_name, member.file_id, member.module, depth + 1) ??
        resolveTypeName(member.type_name, fileId, module, depth + 1)
      );
    }

    // `ReturnType<typeof buildRouter>` -- likewise a pointer at a declaration:
    // whatever `buildRouter` is annotated, or was inferred, to return.
    const returned = name.startsWith('ReturnType<')
      ? /^ReturnType<typeof ([A-Za-z_$][\w$]*)>$/.exec(name)
      : null;
    if (returned) {
      const fn = resolveValueName(returned[1], fileId, module);
      if (!fn?.type_name) return null;
      return (
        resolveTypeName(fn.type_name, fn.file_id, fn.module, depth + 1) ??
        resolveTypeName(fn.type_name, fileId, module, depth + 1)
      );
    }

    // `DirectusClient<unknown> & RestClient<unknown>`. An intersection is not
    // an ambiguity: TypeScript says the value has every one of these, which is
    // more than any single name states. Modelled as a type inheriting from all
    // of them, so the member walk already in place looks through each in turn
    // -- and 187 directus calls stop being blamed on the half that lacks them.
    if (name.includes('&')) {
      const parts = name.split('&').filter(Boolean);
      if (!parts.some((p) => resolveTypeName(p, fileId, module))) return null;
      return {
        fqn: `&(${parts.join('&')})@${module ?? ''}`,
        name,
        kind: 'interface',
        symbol_id: null,
        file_id: fileId,
        module,
        isExternal: 0,
        extOwner: null,
        supertypes: parts,
      };
    }
    // Already a fully qualified name -- the inference pass stores those, having
    // resolved them where they were written.
    if (types.has(name)) return types.get(name);

    const local = (symbolsByModule.get(module) ?? []).find(
      (s) => s.name === name && ['class', 'interface'].includes(s.kind),
    );
    if (local) return types.get(local.fqn) ?? null;

    for (const imp of importsByFile.get(fileId) ?? []) {
      if (imp.kind !== 'import' || imp.simple !== name) continue;
      const target = resolveModule(module, imp.fqn);
      // The file names which module this identifier comes from. If that module
      // is not one of ours, the answer is "not ours" -- falling through to a
      // same-named class elsewhere in the repo resolves wrong, not late.
      if (!target) return null;
      // The module IS ours but the export eluded us: that is a gap in barrel
      // resolution, not evidence about the type, so the search continues.
      const hit = resolveExport(target, imp.orig ?? name);
      if (!hit) continue;
      // A CommonJS module often exports a plain function used as a
      // constructor, which is not in the type table but is one all the same.
      return types.get(hit.fqn) ?? (hit.kind === 'function' ? asConstructible(name, fileId, module) : null);
    }

    // This project's own types answer first. A dependency's declarations are a
    // last resort -- they exist to prove a call leaves the project, never to
    // outvote a type the project declares, and letting them into this vote
    // turned resolutions into nothing by making the match ambiguous.
    const mine = [...types.values()].filter((t) => t.name === name && !t.isExternal);
    if (mine.length === 1) return mine[0];
    if (mine.length > 1) return null;

    const matches = [...types.values()].filter((t) => t.name === name);
    if (matches.length === 1) return matches[0];

    // Before classes, a constructor in JavaScript was a function, and plenty
    // of Node code still is: `function User(...)` then `new User(...)`. Such a
    // function is a type for every purpose this resolver has.
    return asConstructible(name, fileId, module);
  }

  /** A module-level function usable as a constructor, local or imported. */
  function asConstructible(name, fileId, module) {
    const asType = (row) => ({
      fqn: row.fqn,
      name: row.name,
      kind: 'class',
      module: row.module,
      file_id: row.file_id,
      symbol_id: row.id,
      supertypes: [],
    });

    const here = (symbolsByModule.get(module) ?? []).find(
      (s) => s.name === name && s.kind === 'function',
    );
    if (here) return asType(here);

    for (const imp of importsByFile.get(fileId) ?? []) {
      if (imp.kind !== 'import' || imp.simple !== name) continue;
      const target = resolveModule(module, imp.fqn);
      const hit = target && resolveExport(target, imp.orig ?? name);
      if (hit?.kind === 'function') return asType(hit);
    }
    return null;
  }

  /**
   * The module-level VALUE a bare identifier denotes -- the declaration row
   * itself, not a type built from it. `asConstructible` above answers the
   * neighbouring question and cannot serve: it reports the name as a class,
   * which is what `new f()` makes, whereas `typeof f` wants what `f` returns.
   */
  function resolveValueName(name, fileId, module) {
    const here = (symbolsByModule.get(module) ?? []).find(
      (s) => s.name === name && ['function', 'field'].includes(s.kind),
    );
    if (here) return here;

    for (const imp of importsByFile.get(fileId) ?? []) {
      if (imp.kind !== 'import' || imp.simple !== name) continue;
      const target = resolveModule(module, imp.fqn);
      // Named a module outside this project: the answer is "not ours", and
      // falling through to a same-named function elsewhere resolves wrong.
      if (!target) return null;
      return resolveExport(target, imp.orig ?? name);
    }
    return null;
  }

  function typeChain(type, seen = new Set()) {
    if (!type || seen.has(type.fqn)) return [];
    seen.add(type.fqn);
    const chain = [type];
    for (const raw of type.supertypes ?? []) {
      const superType = resolveTypeName(raw, type.file_id, type.module);
      if (superType) chain.push(...typeChain(superType, seen));
    }
    return chain;
  }

  const subtypesOf = new Map();
  for (const t of types.values()) {
    for (const raw of t.supertypes) {
      const superType = resolveTypeName(raw, t.file_id, t.module);
      if (!superType) continue;
      if (!subtypesOf.has(superType.fqn)) subtypesOf.set(superType.fqn, []);
      subtypesOf.get(superType.fqn).push(t.fqn);
    }
  }

  function findMember(type, name) {
    for (const t of typeChain(type)) {
      const hit = (membersByContainer.get(t.fqn) ?? []).find((m) => m.name === name);
      if (hit) return hit;
    }
    return null;
  }

  /** 'react' | '@tanstack/react-query' | null for a relative path. */
  function packageOf(specifier) {
    if (!specifier || specifier.startsWith('.')) return null;
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  }

  /**
   * Names the package a type or value comes from, or null if it could be local.
   * An import that resolves to no file in the tree is a node_modules import,
   * which needs no list of known libraries to recognise.
   */
  function externalOwner(name, fileId, module) {
    if (!name) return null;
    if (/\[\]$/.test(name)) return 'Array';
    for (const imp of importsByFile.get(fileId) ?? []) {
      if (imp.kind !== 'import' || imp.simple !== name) continue;
      if (resolveModule(module, imp.fqn)) return null;
      return packageOf(imp.fqn) ?? 'unresolved-module';
    }
    return null;
  }

  /** The first ancestor that is not indexed -- where an unknown member lives. */
  function externalAncestor(type) {
    for (const t of typeChain(type)) {
      for (const raw of t.supertypes) {
        if (resolveTypeName(raw, t.file_id, t.module)) continue;
        return externalOwner(raw, t.file_id, t.module) ?? raw;
      }
    }
    return null;
  }

  const localsByScope = new Map();
  for (const row of db.prepare('SELECT scope_symbol_id, name, type_name, type_args, owner_ref_id FROM locals').all()) {
    if (row.scope_symbol_id == null) continue;
    if (!localsByScope.has(row.scope_symbol_id)) localsByScope.set(row.scope_symbol_id, new Map());
    localsByScope.get(row.scope_symbol_id).set(row.name, {
      type: row.type_name,
      args: row.type_args,
      ownerRef: row.owner_ref_id,
    });
  }

  const symbolById = new Map(allSymbols.map((s) => [s.id, s]));
  const fileById = new Map(files.map((f) => [f.id, f]));

  // A function sees the module's variables. Without this, every module-level
  // const was invisible from inside the functions that use it.
  const fileScopeSymbol = new Map(); // file id -> the file-scope symbol id
  for (const row of db
    .prepare(
      `SELECT s.id, s.file_id FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE s.kind = 'file' AND f.lang IN (${LANG_LIST})`,
    )
    .all()) {
    fileScopeSymbol.set(row.file_id, row.id);
  }

  /** The declared type of `name` in this scope or the module around it. */
  function lookupLocal(ref, name) {
    const own = localsByScope.get(ref.from_symbol_id);
    if (own?.has(name)) return { found: true, ...own.get(name) };
    const moduleScope = localsByScope.get(fileScopeSymbol.get(ref.file_id));
    if (moduleScope?.has(name)) return { found: true, ...moduleScope.get(name) };
    return { found: false, type: null };
  }

  const refById = new Map();
  const chainMemo = new Map();

  /** The module path a file belongs to, which type lookup is relative to. */
  const moduleOf = (fileId) => fileById.get(fileId)?.pkg ?? null;

  /**
   * What one element of this call's result is: from the callee's declared
   * container type, `Promise<User>` or `User[]` alike.
   */
  function elementTypeOfRef(ref, depth) {
    if (!ref || depth > 6) return null;
    const from = symbolById.get(ref.from_symbol_id);
    const recv = receiverType(ref, from, depth + 1);
    if (!recv?.fqn) return null;
    const target = findMember(recv, ref.name);
    if (!target?.type_args) return null;
    return resolveTypeName(target.type_args, ref.file_id, moduleOf(ref.file_id));
  }

  /**
   * The type of an arrow parameter, from the call the arrow was handed to.
   * `users.forEach(u => ...)` gives it an element of `users`, so the answer is
   * the element type of that call's RECEIVER, not of the call itself.
   */
  function lambdaParamType(ownerRefId, depth) {
    if (depth > 6) return null;
    const owner = refById.get(ownerRefId);
    if (!owner) return null;

    if (owner.receiver_ref_id != null) {
      const fromChain = elementTypeOfRef(refById.get(owner.receiver_ref_id), depth + 1);
      if (fromChain) return resolveTypeName(fromChain, owner.file_id, moduleOf(owner.file_id)) ?? fromChain;
    }
    const holder = owner.receiver ? lookupLocal(owner, owner.receiver) : null;
    if (holder?.args) {
      const hit = resolveTypeName(holder.args, owner.file_id, moduleOf(owner.file_id));
      if (hit) return hit;
    }
    return null;
  }

  /** Resolves an inner call in a chain so its return type can type the next. */
  function chainTarget(ref, depth) {
    if (!ref || depth > 8) return null;
    if (chainMemo.has(ref.id)) return chainMemo.get(ref.id);
    chainMemo.set(ref.id, null);

    const fromSymbol = symbolById.get(ref.from_symbol_id);
    const recv = receiverType(ref, fromSymbol, depth + 1);
    const result = recv?.fqn ? findMember(recv, ref.name) : null;
    chainMemo.set(ref.id, result);
    return result;
  }

  function receiverType(ref, fromSymbol, depth = 0) {
    const file = fileById.get(ref.file_id);
    const module = file?.pkg;
    const enclosingType = fromSymbol?.container_fqn ? types.get(fromSymbol.container_fqn) : null;
    // `table!.findColumnByName` and `table?.findColumnByName` are both calls on
    // `table`. The assertion and the optional-chain say something about null,
    // nothing about the type, and leaving them in the text meant the receiver
    // matched no identifier at all: 1,061 calls in typeorm alone.
    const raw = (ref.receiver ?? '').replace(/!(?=\.|$)/g, '').replace(/\?\./g, '.');

    if (!raw || raw === 'this') return enclosingType;

    // `svc.load().render()` -- carry the inner call's return type forward.
    if (ref.receiver_ref_id != null) {
      const target = chainTarget(refById.get(ref.receiver_ref_id), depth);
      if (target?.type_name) {
        // Resolved where the method was DECLARED first. A caller need not
        // import the type it is handed back: a nest spec imports `Test` and
        // receives a TestingModuleBuilder from it, and looking that name up in
        // the spec's own imports finds nothing -- which killed the chain at its
        // first hop, and with it every call downstream.
        const hit =
          resolveTypeName(target.type_name, target.file_id, target.module) ??
          resolveTypeName(target.type_name, ref.file_id, module);
        if (hit) return hit;
        const owner =
          externalOwner(target.type_name, target.file_id, target.module) ??
          externalOwner(target.type_name, ref.file_id, module);
        if (owner) return { external: owner };
      }
    }

    // `this.repository.save(...)` -- the dominant shape in class-based TS.
    const thisField = /^this\.([A-Za-z_$][\w$]*)$/.exec(raw);
    if (thisField) {
      const field = enclosingType ? findMember(enclosingType, thisField[1]) : null;
      if (!field?.type_name) return { complex: true };
      const hit = resolveTypeName(field.type_name, ref.file_id, module);
      if (hit) return hit;
      return { external: externalOwner(field.type_name, ref.file_id, module) };
    }

    // `dataSource.manager.save(...)` -- a property PATH rather than a call
    // chain. Every segment is a declared field, so walking it reads types
    // rather than guessing at them, and each hop is resolved where it was
    // declared: `DataSource.manager` is an `EntityManager` whether or not the
    // calling file has ever heard of that name.
    //
    // This was by a wide margin the largest bucket left. Anything that was not
    // a bare identifier or a single `this.x` fell through to "complex" -- in
    // typeorm, 9,729 calls, headed by 1,434 of `dataSource.manager.save`.
    if (depth < 8 && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(raw)) {
      const segments = raw.split('.');
      let current = receiverType(
        { ...ref, receiver: segments[0], receiver_ref_id: null },
        fromSymbol,
        depth + 1,
      );
      for (let i = 1; i < segments.length; i++) {
        if (!current?.fqn) break;
        const member = findMember(current, segments[i]);
        if (!member?.type_name) {
          current = { complex: true };
          break;
        }
        if (member.isExternal) {
          current = { external: member.extOwner ?? 'unresolved-module' };
          break;
        }
        current =
          resolveTypeName(member.type_name, member.file_id, member.module) ??
          resolveTypeName(member.type_name, ref.file_id, module) ??
          (externalOwner(member.type_name, member.file_id, member.module)
            ? { external: externalOwner(member.type_name, member.file_id, member.module) }
            : { complex: true });
      }
      if (current) return current;
    }

    if (!/^[A-Za-z_$][\w$]*$/.test(raw)) {
      const head = /^([A-Za-z_$][\w$]*)/.exec(raw)?.[1];
      const owner = head ? externalOwner(head, ref.file_id, module) : null;
      return owner ? { external: owner } : { complex: true };
    }

    const scoped = lookupLocal(ref, raw);
    if (scoped.found) {
      if (!scoped.type) {
        // An arrow parameter: no annotation, but it holds one element of what
        // the call it was passed to is iterating over.
        const fromLambda = scoped.ownerRef != null ? lambdaParamType(scoped.ownerRef, depth) : null;
        if (fromLambda) return fromLambda;
        return { complex: true };
      }
      const hit = resolveTypeName(scoped.type, ref.file_id, module);
      if (hit) return hit;
      const owner = externalOwner(scoped.type, ref.file_id, module);
      return owner ? { external: owner } : { complex: true };
    }

    const field = enclosingType ? findMember(enclosingType, raw) : null;
    if (field?.type_name) {
      const hit = resolveTypeName(field.type_name, ref.file_id, module);
      if (hit) return hit;
      const owner = externalOwner(field.type_name, ref.file_id, module);
      return owner ? { external: owner } : { complex: true };
    }

    // A capitalised receiver is usually the class itself -- `Test.create(...)`,
    // a static call. Resolve it as a type before deciding it came from
    // outside: every such call on an imported in-repo class was being handed
    // to the module it was imported from, taking the whole chain with it.
    if (/^[A-Z]/.test(raw)) {
      const asType = resolveTypeName(raw, ref.file_id, module);
      if (asType?.fqn) return asType;
    }

    // `import { initTRPC } from '...'` then `initTRPC.create()`. The import
    // resolves to a value this project exports, and that value's declaration
    // says what it is -- `export const initTRPC = new TRPCBuilder()`. Without
    // this the name was known to be ours and still had no type, so the chain
    // ended at the first hop.
    for (const imp of importsByFile.get(ref.file_id) ?? []) {
      if (imp.kind !== 'import' || imp.simple !== raw) continue;
      const mod = resolveModule(module, imp.fqn);
      const exported = mod ? resolveExport(mod, imp.orig ?? raw) : null;
      if (!exported?.type_name) break;
      const hit = resolveTypeName(exported.type_name, exported.file_id, exported.module);
      if (hit) return hit;
      break;
    }

    // A bare receiver that was imported comes from wherever it was imported.
    const imported = externalOwner(raw, ref.file_id, module);
    if (imported) return { external: imported };

    if (/^[A-Z]/.test(raw)) {
      const hit = resolveTypeName(raw, ref.file_id, module);
      if (hit) return hit;
    }

    // Nothing in this module declares it, nothing imports it, and no indexed
    // type carries the name. A module cannot reach another module's exports
    // without importing them, so the identifier is ambient: a host global like
    // `console`, or one a test runner injects such as `vi` or `jest`.
    if (!(symbolsByModule.get(module) ?? []).some((sym) => sym.name === raw)) {
      return { ambient: true };
    }

    return null;
  }

  // Return-type inference: `const donation = this.service.record(...)` carries
  // no annotation, but the callee declares what it returns. Runs before the
  // main pass so those locals can type their own receivers.
  // Loaded before anything walks a chain: receiverType follows receiver_ref_id
  // through this map, so an empty one turns every chained receiver into
  // "complex" -- which is what used to happen to the inference pass below.
  const refs = db
    .prepare(
      `SELECT r.* FROM refs r JOIN files f ON f.id = r.file_id
        WHERE f.lang IN (${LANG_LIST}) AND f.external = 0 AND r.kind != 'annotation'`,
    )
    .all();
  for (const r of refs) refById.set(r.id, r);

  const updateLocal = db.prepare('UPDATE locals SET type_name = ? WHERE id = ?');

  // `const manager = connection.manager` names no type and calls nothing, so
  // there was never anything to infer from -- and every call on `manager`
  // went down with it. The path is the answer: walking it reads a declared
  // field per segment. Runs first, because a path usually starts from
  // something already annotated, and what it types can then carry a call.
  const pathLocals = db
    .prepare(
      `SELECT l.id, l.file_id, l.scope_symbol_id, l.name, l.init_path
         FROM locals l JOIN files f ON f.id = l.file_id
        WHERE f.lang IN (${LANG_LIST}) AND l.type_name IS NULL AND l.init_kind = 'path'`,
    )
    .all();
  for (const local of pathLocals) {
    if (!local.init_path || local.scope_symbol_id == null) continue;
    const scope = symbolById.get(local.scope_symbol_id);
    const type = receiverType(
      {
        file_id: local.file_id,
        from_symbol_id: local.scope_symbol_id,
        receiver: local.init_path,
        receiver_ref_id: null,
      },
      scope,
    );
    if (!type?.fqn) continue;
    updateLocal.run(type.fqn, local.id);
    if (!localsByScope.has(local.scope_symbol_id)) {
      localsByScope.set(local.scope_symbol_id, new Map());
    }
    localsByScope.get(local.scope_symbol_id).set(local.name, {
      type: type.fqn,
      args: null,
      ownerRef: null,
    });
  }

  const pendingLocals = db
    .prepare(
      `SELECT l.id, l.scope_symbol_id, l.name, l.line, l.init_kind, l.owner_ref_id
         FROM locals l JOIN files f ON f.id = l.file_id
        WHERE f.lang IN (${LANG_LIST}) AND l.type_name IS NULL
            AND l.init_kind IN ('call', 'await')`,
    )
    .all();
  for (const local of pendingLocals) {
    // The exact call the value came from, recorded at extraction. No line
    // matching: a chain spanning several lines used to find nothing.
    const ref = refById.get(local.owner_ref_id);
    if (!ref) continue;
    const type = receiverType(ref, symbolById.get(ref.from_symbol_id));
    // receiverType may report a library or an untypeable chain instead.
    if (!type?.fqn) continue;
    const target = findMember(type, ref.name);
    if (!target?.type_name) continue;
    // `await f()` on a `Promise<T>` holds the T, not the promise.
    const bare = local.init_kind === 'await' && target.type_args ? target.type_args : target.type_name;
    // Resolved where it was WRITTEN, not where the value ends up. A spec that
    // imports only `Test` still receives a TestingModule from it, and looking
    // that name up in the spec's own imports finds nothing.
    const held = resolveTypeName(bare, target.file_id, target.module)?.fqn ?? bare;
    updateLocal.run(held, local.id);
    if (!localsByScope.has(local.scope_symbol_id)) {
      localsByScope.set(local.scope_symbol_id, new Map());
    }
    localsByScope.get(local.scope_symbol_id).set(local.name, {
      type: held,
      args: held === target.type_name ? (target.type_args ?? null) : null,
      ownerRef: null,
    });
  }

  db.exec(`DELETE FROM edges WHERE from_symbol_id IN (
             SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id
              WHERE f.lang IN (${LANG_LIST}))`);
  db.exec(`DELETE FROM unresolved WHERE ref_id IN (
             SELECT r.id FROM refs r JOIN files f ON f.id = r.file_id
              WHERE f.lang IN (${LANG_LIST}))`);

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
    ambient: 0,
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
  /** A call into node_modules or the runtime: expected, not a miss. */
  const insertExternal = (refId, owner) => {
    insertRow.run(refId, owner ? `external:${owner}` : 'external', 1, owner ?? null);
    refOutcome.set(refId, { external: true, owner });
    stats.external++;
  };
  /**
   * The called name is declared nowhere in the index, so the call cannot target
   * this project. Weaker than naming the package, but a proof all the same.
   */
  /**
   * Every name these files declare, of any kind. A call to a name absent from
   * it provably cannot land in this repository -- the proof that outranks any
   * runtime guess.
   */
  const declaredNames = new Set(allSymbols.filter((row) => !row.isExternal).map((row) => row.name));

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
  /** An identifier the module neither declares nor imports: a host global. */
  const insertAmbient = (refId) => {
    insertRow.run(refId, 'external:ambient-global', 1, 'ambient-global');
    refOutcome.set(refId, { external: true, owner: 'ambient-global' });
    stats.external++;
    stats.ambient++;
  };
  /**
   * A language built-in on an untyped receiver.
   *
   * Assumed only when it has to be. `new Error(...)` and `new Map()` reach a
   * built-in for a reason nothing needs to assume: this repository declares no
   * `Error` and no `Map` anywhere, so the call cannot land here. Proof runs
   * before assumption everywhere else in this resolver, and skipping the check
   * here left 692 provable calls in nest sitting in the assumed bucket, which
   * the self-audit then charged for.
   */
  const insertRuntime = (refId, name) => {
    if (name && !declaredNames.has(name)) return insertNotInProject(refId);
    insertRow.run(refId, 'external:js-runtime', 1, 'js-runtime');
    refOutcome.set(refId, { external: true, owner: 'js-runtime' });
    stats.external++;
    stats.runtime++;
  };

  for (const t of types.values()) {
    for (const raw of t.supertypes) {
      const superType = resolveTypeName(raw, t.file_id, t.module);
      if (!superType) continue;
      insertEdge.run(
        t.symbol_id,
        superType.symbol_id,
        superType.kind === 'interface' ? 'implements' : 'extends',
        1.0,
        'declaration',
        null,
      );
      stats.inheritance++;
    }
  }


  for (const ref of refs) {
    if (ref.from_symbol_id == null) {
      insertUnresolved(ref.id, 'no-enclosing-symbol');
      continue;
    }
    const fromSymbol = symbolById.get(ref.from_symbol_id);
    const file = fileById.get(ref.file_id);

    if (ref.kind === 'new') {
      const type = resolveTypeName(ref.name, ref.file_id, file?.pkg);
      if (!type?.fqn) {
        const owner = externalOwner(ref.name, ref.file_id, file?.pkg);
        if (owner) insertExternal(ref.id, owner);
        else if (JS_GLOBALS.has(ref.name)) insertRuntime(ref.id, ref.name);
        else if (!callablesByName.has(ref.name)) insertNotInProject(ref.id);
        else insertUnresolved(ref.id, 'unknown-type');
        continue;
      }
      insertEdge.run(ref.from_symbol_id, type.symbol_id, 'instantiates', 1.0, 'direct', ref.line);
      const ctor = findMember(type, 'constructor');
      if (ctor) insertEdge.run(ref.from_symbol_id, ctor.id, 'calls', 1.0, 'constructor', ref.line);
      stats.direct++;
      continue;
    }

    // A bare call is either a local function or an imported one.
    if (!ref.receiver) {
      const module = file?.pkg;
      const localFn = (symbolsByModule.get(module) ?? []).find(
        (s) => s.name === ref.name && s.kind === 'function',
      );
      let target = localFn;
      if (!target) {
        for (const imp of importsByFile.get(ref.file_id) ?? []) {
          if (imp.kind !== 'import' || imp.simple !== ref.name) continue;
          const mod = resolveModule(module, imp.fqn);
          target = mod ? resolveExport(mod, imp.orig ?? ref.name) : null;
          if (target) break;
        }
      }
      if (target) {
        insertEdge.run(ref.from_symbol_id, target.id, 'calls', 1.0, 'direct', ref.line);
        stats.direct++;
        continue;
      }
      // An import that names this call and resolves to no file in the tree is
      // a dependency, which proves the call cannot land in this project. That
      // is `sql` from kysely -- a tagged template, imported and called by
      // name -- and without this it fell through to "maybe a method on this"
      // and was blamed on whichever class happened to enclose it.
      const fromPackage = externalOwner(ref.name, ref.file_id, module);
      if (fromPackage) {
        insertExternal(ref.id, fromPackage);
        continue;
      }
      // Otherwise it may be a method on `this` reached without the prefix.
    }

    // `import * as fmt from './format'` / `var fmt = require('./format')`
    // binds the module itself, so a call on it names one of its exports.
    if (ref.receiver && /^[A-Za-z_$][\w$]*$/.test(ref.receiver)) {
      const module = file?.pkg;
      let viaNamespace = null;
      for (const imp of importsByFile.get(ref.file_id) ?? []) {
        if (imp.kind !== 'import' || !imp.is_wildcard || imp.simple !== ref.receiver) continue;
        const mod = resolveModule(module, imp.fqn);
        viaNamespace = mod ? resolveExport(mod, ref.name) : null;
        if (viaNamespace) break;
      }
      if (viaNamespace) {
        insertEdge.run(ref.from_symbol_id, viaNamespace.id, 'calls', 1.0, 'direct', ref.line);
        stats.direct++;
        continue;
      }
    }

    const type = receiverType(ref, fromSymbol, 0);

    if (type && !type.fqn) {
      const carried = inheritedExternal(ref);
      if (type.ambient) insertAmbient(ref.id);
      else if (!type.complex) insertExternal(ref.id, type.external);
      else if (!callablesByName.has(ref.name)) insertNotInProject(ref.id);
      else if (carried !== undefined) insertExternal(ref.id, carried);
      // The receiver has no type we could work out; a language built-in is by
      // far the likeliest reading of `.map` or `.get` at that point.
      else if (JS_RUNTIME.has(ref.name)) insertRuntime(ref.id, ref.name);
      else insertUnresolved(ref.id, 'complex-receiver-chain');
      continue;
    }

    if (type) {
      // A receiver whose TYPE belongs to a dependency cannot be calling into
      // this project, whatever the member turns out to be. Reading the
      // declaration proves the whole call external -- and without this the
      // gaps in our own .d.ts reading would turn proofs into misses.
      if (type.isExternal) {
        insertExternal(ref.id, type.extOwner ?? null);
        continue;
      }
      const target = findMember(type, ref.name);
      if (target?.isExternal) {
        // Inherited into this project's type from a dependency's.
        insertExternal(ref.id, target.extOwner ?? null);
        continue;
      }
      if (target) {
        insertEdge.run(ref.from_symbol_id, target.id, 'calls', 1.0, 'direct', ref.line);
        stats.direct++;

        const declaring = symbolById.get(target.id)?.container_fqn;
        if (types.get(declaring)?.kind === 'interface') {
          for (const subFqn of subtypesOf.get(declaring) ?? []) {
            const impl = findMember(types.get(subFqn), ref.name);
            if (impl && impl.id !== target.id) {
              insertEdge.run(ref.from_symbol_id, impl.id, 'calls', 0.9, 'interface->impl', ref.line);
              stats.viaImpl++;
            }
          }
        }
        continue;
      }
      const inherited = externalAncestor(type);
      if (inherited) insertExternal(ref.id, inherited);
      // A receiver typed `Promise`, `Error` or `Map` is the runtime's, whatever
      // the index thinks it found. Calling a member of one is a call into the
      // language, not a miss in this repository -- reporting 21 of those in
      // prettier as unresolved blamed the repo for the standard library.
      else if (JS_GLOBALS.has(type.name)) insertRuntime(ref.id, type.name);
      // "declared nowhere in the project" is a proof and outranks both lists
      // below, which are only ever a better answer than reporting a miss.
      else if (!callablesByName.has(ref.name)) insertNotInProject(ref.id);
      // The prototype chain ends at Object, so a type not declaring `bind` or
      // `toString` is not missing it.
      else if (UNIVERSAL_MEMBERS.has(ref.name)) insertRuntime(ref.id, 'Object.prototype');
      // A bare call inside a method is given `this` as its receiver, so a
      // global arrives here looking like a member the class does not have.
      else if (!ref.receiver && GLOBAL_FUNCTIONS.has(ref.name)) insertRuntime(ref.id, ref.name);
      else insertUnresolved(ref.id, `no-such-member-on:${type.name}`);
      continue;
    }

    const byName = callablesByName.get(ref.name) ?? [];
    // A receiver we could not type, calling something the language provides:
    // linking that to whichever project method shares the name invents an edge.
    if (ref.receiver && JS_RUNTIME.has(ref.name)) {
      insertRuntime(ref.id, ref.name);
      continue;
    }
    // A bare call is a module function or an import. Both were tried above, so
    // a method on some unrelated class is not in scope here.
    //
    // The runtime list is deliberately not consulted: those are prototype
    // methods, which need a receiver. A bare `get()` is not `Map.get`, and
    // treating it as one would be an assumption with nothing behind it.
    if (!ref.receiver) {
      if (!callablesByName.has(ref.name)) insertNotInProject(ref.id);
      else insertOutOfScope(ref.id);
      continue;
    }
    if (byName.length === 1) {
      insertEdge.run(ref.from_symbol_id, byName[0].id, 'calls', 0.5, 'unique-name', ref.line);
      stats.uniqueName++;
    } else if (byName.length) {
      insertUnresolved(ref.id, 'ambiguous-name');
    } else {
      // A bare call to something imported from a package.
      const owner = !ref.receiver
        ? externalOwner(ref.name, ref.file_id, fileById.get(ref.file_id)?.pkg)
        : null;
      if (owner) insertExternal(ref.id, owner);
      else if (!callablesByName.has(ref.name)) insertNotInProject(ref.id);
      else insertUnresolved(ref.id, 'unknown-method');
    }
  }

  return stats;
}
