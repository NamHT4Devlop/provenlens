/**
 * HTTP routes: a URL is the other kind of string two pieces of code share.
 *
 * A controller declares `@GetMapping("/orders/{id}")` and something,
 * frequently in another repository, calls `GET /orders/42`. No call graph can
 * cross that gap -- it is a string on one side and a string on the other --
 * which is the same shape as an SQS queue name or a Camel URI, so it is the
 * same kind of plugin.
 *
 * Providers are the handlers. Consumers are the clients that name a path. In a
 * single service the providers alone are worth having: `provenlens routes` then
 * answers "which method serves POST /orders", which is otherwise a grep
 * through annotations that may not even be on the method.
 */
import { attributeStrings, attributeIdentifiers, lineIndex } from './text.js';

/** Path shapes differ per framework and mean the same thing. */
export function normalizePath(raw) {
  if (typeof raw !== 'string') return null;
  let p = raw.trim();
  if (!p || /\s/.test(p)) return null;
  // A path built from a config placeholder names a key, not a route. Checked
  // before the fragment is cut, or `#{base}/x` becomes the empty string and
  // then, worse, the root route.
  if (/^\$\{.*\}$/.test(p) || p.includes('#{')) return null;
  // A full URL still identifies the route by its path.
  if (/^https?:\/\//i.test(p)) {
    const at = p.indexOf('/', p.indexOf('://') + 3);
    p = at === -1 ? '/' : p.slice(at);
  }
  p = p.split('?')[0].split('#')[0];
  if (!p.startsWith('/')) p = `/${p}`;
  // `{id}`, `:id` and `<int:id>` are one parameter written three ways, and a
  // caller writing `/orders/42` means the same route as `/orders/{id}`.
  p = p
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/<[^>]*>/g, '{}')
    .replace(/:[A-Za-z_][\w]*/g, '{}')
    .replace(/\$\{[^}]*\}/g, '{}')
    // A caller writes the id it actually has. `/orders/42` is the same route
    // as `/orders/{id}`, and leaving them apart would file every call to a
    // route under its own key and match nothing.
    .replace(/\/\d+(?=\/|$)/g, '/{}')
    .replace(/\/+/g, '/');
  if (p.length > 1) p = p.replace(/\/$/, '');
  return p || '/';
}

/** `GET /orders/{}` -- the pair that identifies a route. */
function routeKey(method, path) {
  const p = normalizePath(path);
  return p ? `${method} ${p}` : null;
}

function joinPaths(prefix, path) {
  if (!prefix) return path;
  if (!path || path === '/') return prefix;
  return `${prefix.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

const VERBS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

/** @GetMapping -> GET. @RequestMapping declares its method in an argument. */
const SPRING_VERBS = {
  '@GetMapping': 'GET', '@PostMapping': 'POST', '@PutMapping': 'PUT',
  '@DeleteMapping': 'DELETE', '@PatchMapping': 'PATCH',
};
const NEST_VERBS = {
  '@Get': 'GET', '@Post': 'POST', '@Put': 'PUT',
  '@Delete': 'DELETE', '@Patch': 'PATCH', '@All': 'ANY',
};
const EXPRESS_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all', 'head', 'options']);
// `api` is not here: `api.get('/items', { params })` is an axios call, and
// listing it as a route served by the caller made every client its own server.
const EXPRESS_RECEIVERS = /^(app|router|server|r)$/i;

/** Java and TypeScript clients that name a path as their first string. */
const JAVA_CLIENT = new Set([
  'getForObject', 'getForEntity', 'postForObject', 'postForEntity', 'put', 'delete',
  'exchange', 'uri', 'patchForObject',
]);
/** The generic names among them, which `Map.put("/x", v)` also answers to. */
const JAVA_CLIENT_GENERIC = new Set(['put', 'delete', 'exchange', 'uri']);
const JAVA_CLIENT_RECEIVER = /rest|template|client|http|web|feign|request/i;
const TS_CLIENT = new Set(['get', 'post', 'put', 'delete', 'patch', 'fetch', 'request']);
// Anchored at the last segment: `this.http.get(...)` is how Angular and Nest
// spell the commonest client call, and an anchor on the whole receiver read
// none of them.
const TS_CLIENT_RECEIVERS = /(^|\.)(axios|https?|client|api|fetch|request|superagent|got|httpService|httpClient|\$http)$/i;

export default {
  name: 'http',
  edgeKind: 'calls-route',
  confidence: 0.8,

  collect(ctx) {
    // A class-level prefix belongs to every route the class declares, so the
    // annotations are read before the methods that need them.
    const prefixes = new Map(); // container fqn -> '/api/orders'
    const symbolById = new Map();
    for (const row of ctx.db
      .prepare(
        `SELECT s.id, s.fqn, s.kind, s.container_fqn FROM symbols s
           JOIN files f ON f.id = s.file_id WHERE f.external = 0`,
      )
      .all()) {
      symbolById.set(row.id, row);
    }

    const annotationRefs = ctx.refs("r.kind = 'annotation'");

    for (const ref of annotationRefs) {
      const owner = symbolById.get(ref.from_symbol_id);
      if (!owner || !['class', 'interface'].includes(owner.kind)) continue;
      // Spring's `@Controller("name")` names a bean, not a path; only
      // `@RequestMapping` carries a prefix there. NestJS puts the prefix on
      // `@Controller('cats')` itself.
      let first = null;
      if (ref.lang === 'java' && ref.name === '@RequestMapping') {
        first = attributeStrings(ref.raw, ['value', 'path'])[0] ?? null;
      } else if (ref.lang !== 'java' && ref.name === '@Controller') {
        first = ref.strArgs.find((a) => typeof a === 'string' && a.trim()) ?? null;
      }
      const p = first ? normalizePath(first) : null;
      if (p) prefixes.set(owner.fqn, p);
    }

    const provide = (ref, method, path) => {
      const key = routeKey(method, path);
      if (!key) return;
      ctx.emit({
        role: 'provider',
        key,
        symbolId: ref.from_symbol_id,
        fileId: ref.file_id,
        line: ref.line,
        detail: `${ref.name} ${key}`,
      });
      // A caller whose verb could not be read still reaches this handler if
      // the path matches, so the handler answers under ANY as well. Without
      // it a route served by GET and called through a client the verb could
      // not be recovered from stays unwired, which reads as "nobody calls
      // this" -- the one wrong answer this plugin must not give.
      if (method !== 'ANY') {
        ctx.emit({
          role: 'provider',
          key: key.replace(/^\S+/, 'ANY'),
          symbolId: ref.from_symbol_id,
          fileId: ref.file_id,
          line: ref.line,
          detail: `${ref.name} ${key}`,
        });
      }
    };

    // --- providers: the handler that serves a path ---
    for (const ref of annotationRefs) {
      const verb = SPRING_VERBS[ref.name] ?? NEST_VERBS[ref.name] ?? null;
      const isRequestMapping = ref.name === '@RequestMapping';
      if (!verb && !isRequestMapping) continue;
      const owner = symbolById.get(ref.from_symbol_id);
      if (!owner || ['class', 'interface'].includes(owner.kind)) continue;
      const prefix = prefixes.get(owner.container_fqn) ?? null;

      if (ref.lang === 'java') {
        // Attributes by name, not by position: `@GetMapping(produces =
        // "application/json", value = "/list")` served `/application/json`
        // when the first string was taken as the path. An array names several
        // paths, and each is a route. A verb annotation with no path at all
        // serves the class prefix itself.
        const paths = attributeStrings(ref.raw, ['value', 'path']);
        // `@RequestMapping(method = RequestMethod.POST)` names its verb as an
        // enum, which is never a string literal; with none it answers every
        // verb, and ANY says so rather than guessing.
        const methods = isRequestMapping
          ? attributeIdentifiers(ref.raw, 'method').filter((m) => VERBS.has(m))
          : [verb];
        for (const method of methods.length ? methods : ['ANY']) {
          for (const path of paths.length ? paths : ['/']) provide(ref, method, joinPaths(prefix, path));
        }
        continue;
      }

      const raw = ref.strArgs.find((a) => typeof a === 'string' && a.trim()) ?? '';
      provide(ref, verb ?? 'ANY', joinPaths(prefix, raw || '/'));
    }

    // --- Express: `app.get('/orders/:id', handler)` ---
    for (const ref of ctx.refs(
      "f.lang IN ('javascript', 'typescript', 'tsx') AND r.str_args IS NOT NULL AND r.kind = 'call'",
    )) {
      if (ref.from_symbol_id == null || !ref.receiver) continue;
      if (!EXPRESS_VERBS.has(ref.name) || !EXPRESS_RECEIVERS.test(ref.receiver)) continue;
      const first = ref.strArgs[0];
      // A route registers a handler; a one-argument call is reading a value.
      if (typeof first !== 'string' || !first.startsWith('/') || (ref.arity ?? 0) < 2) continue;
      const key = routeKey(ref.name.toUpperCase(), first);
      if (!key) continue;
      ctx.emit({
        role: 'provider',
        key,
        symbolId: ref.from_symbol_id,
        fileId: ref.file_id,
        line: ref.line,
        detail: `${ref.receiver}.${ref.name}("${first}")`,
      });
    }

    // --- Rails: config/routes.rb is the whole routing table ---
    const action = ctx.db.prepare(
      `SELECT s.id FROM symbols s WHERE s.fqn = ? AND s.kind IN ('method', 'class_method') LIMIT 1`,
    );
    for (const row of ctx.db
      .prepare("SELECT id, path FROM files WHERE lang = 'ruby' AND path LIKE '%config/routes.rb'")
      .all()) {
      let text;
      try {
        text = ctx.readSource(row.path);
      } catch {
        continue;
      }
      for (const route of railsRoutes(text)) {
        const key = routeKey(route.verb, route.path);
        if (!key) continue;
        // `things#archive` names `ThingsController#archive`; with the method
        // found, the route has a handler and the controller has a caller.
        // Every Rails route used to carry no symbol at all, so no client was
        // ever wired to an action and every action looked dead.
        const fqn = route.controller ? `${route.controller}Controller#${route.action}` : null;
        const symbolId = fqn ? (action.get(fqn)?.id ?? null) : null;
        ctx.emit({
          role: 'provider',
          key,
          symbolId,
          fileId: row.id,
          line: route.line,
          detail: fqn ? `${key} -> ${fqn}` : key,
        });
      }
    }

    // `webClient.get().uri("/orders")` says GET one hop before it says where.
    // Reading only the call that carries the string files every WebClient and
    // WebTestClient request under ANY, which then matches no provider at all.
    const refById = new Map();
    for (const ref of ctx.refs('1 = 1')) refById.set(ref.id, ref);
    const verbFromChain = (ref, depth = 0) => {
      if (!ref || depth > 4) return null;
      const name = String(ref.name || '').toLowerCase();
      if (['get', 'post', 'put', 'delete', 'patch', 'head', 'options'].includes(name)) {
        return name.toUpperCase();
      }
      return verbFromChain(refById.get(ref.receiver_ref_id), depth + 1);
    };

    // --- consumers: a client that names a path ---
    for (const ref of ctx.refs("r.str_args IS NOT NULL AND r.kind = 'call'")) {
      if (ref.from_symbol_id == null) continue;
      const first = ref.strArgs.find((a) => typeof a === 'string' && a.trim());
      if (!first) continue;

      let method = null;
      if (ref.lang === 'java' && JAVA_CLIENT.has(ref.name)) {
        // `put` and `delete` are also what a Map answers to; only a receiver
        // that looks like a client makes them a request.
        if (JAVA_CLIENT_GENERIC.has(ref.name) && !JAVA_CLIENT_RECEIVER.test(ref.receiver ?? '')) {
          continue;
        }
        method = /^get/i.test(ref.name) ? 'GET'
          : /^post/i.test(ref.name) ? 'POST'
          : /^patch/i.test(ref.name) ? 'PATCH'
          : ref.name === 'put' ? 'PUT'
          : ref.name === 'delete' ? 'DELETE'
          : ref.name === 'uri' || ref.name === 'exchange'
            ? (verbFromChain(refById.get(ref.receiver_ref_id)) ?? 'ANY')
            : 'ANY';
      } else if (
        ['javascript', 'typescript', 'tsx'].includes(ref.lang) &&
        TS_CLIENT.has(ref.name) &&
        (ref.receiver == null ? ref.name === 'fetch' : TS_CLIENT_RECEIVERS.test(ref.receiver))
      ) {
        // `fetch(url)` with no options is a GET; the standard says so.
        method =
          ref.name === 'fetch'
            ? 'GET'
            : ref.name === 'request'
              ? (verbFromChain(refById.get(ref.receiver_ref_id)) ?? 'ANY')
              : ref.name.toUpperCase();
      }
      if (!method) continue;
      // A path is what this is about; anything else is some other string.
      if (!/^(https?:\/\/|\/)/.test(first)) continue;
      const key = routeKey(method, first);
      if (!key) continue;
      ctx.emit({
        role: 'consumer',
        key,
        symbolId: ref.from_symbol_id,
        fileId: ref.file_id,
        line: ref.line,
        detail: `${ref.receiver ? `${ref.receiver}.` : ''}${ref.name}("${first}")`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// Rails routing, read as the DSL nests.

const RESOURCE_ACTIONS = [
  ['index', 'GET', ''], ['create', 'POST', ''], ['new', 'GET', '/new'],
  ['show', 'GET', '/{}'], ['edit', 'GET', '/{}/edit'], ['update', 'PUT', '/{}'],
  ['update', 'PATCH', '/{}'], ['destroy', 'DELETE', '/{}'],
];
const SINGULAR_ACTIONS = [
  ['show', 'GET', ''], ['create', 'POST', ''], ['new', 'GET', '/new'],
  ['edit', 'GET', '/edit'], ['update', 'PUT', ''], ['update', 'PATCH', ''],
  ['destroy', 'DELETE', ''],
];

/** `things` -> `Things`, `api/v1` -> `Api::V1`. */
const camel = (s) =>
  s
    .split('/')
    .map((part) => part.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(''))
    .join('::');

/** A Ruby line with its comment gone -- the `#` inside `'things#show'` is not one. */
function withoutComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

/** `[:show, :index]`, `%i[show index]` or `:show` -> the names. */
function symbolList(text) {
  if (!text) return null;
  return [...text.matchAll(/[A-Za-z_]\w*/g)].map((m) => m[0]).filter((w) => w !== 'i');
}

/** The value of `key:` in a DSL line: a string, a symbol or a list. */
function option(line, key) {
  const m = new RegExp(`\\b${key}:\\s*(%i\\[[^\\]]*\\]|\\[[^\\]]*\\]|'[^']*'|"[^"]*"|:[A-Za-z_]\\w*)`).exec(line);
  if (!m) return null;
  return m[1].replace(/^['":]|['"]$/g, '');
}

/**
 * Every route a routes.rb declares, with the controller action it names.
 *
 * Read line by line with a stack of the blocks that are open, because that
 * is what the DSL is: `namespace :api do` prefixes both the path and the
 * controller module of everything inside it, `resources :things do` nests
 * what follows under `/things/{}`, and `only:` narrows the routes a resource
 * would otherwise declare. All three were ignored, so a route table came back
 * at the wrong paths and with actions that did not exist.
 */
export function railsRoutes(text) {
  const routes = [];
  const stack = [];
  const lineAt = lineIndex(text);
  const state = () => ({
    path: stack.map((f) => f.path).join(''),
    module: stack.map((f) => f.module).filter(Boolean).join('::'),
    resource: [...stack].reverse().find((f) => f.resource)?.resource ?? null,
  });
  const push = (frame, opens) => {
    if (opens) stack.push({ path: '', module: '', resource: null, ...frame });
  };
  const emit = (verb, path, controller, action, line) => {
    routes.push({ verb, path: path || '/', controller, action, line });
  };
  const controllerOf = (name, module) => {
    const base = camel(name);
    return module ? `${module}::${base}` : base;
  };
  const target = (spec, module) => {
    const m = /^([\w/]+)#(\w+)$/.exec(spec ?? '');
    return m ? { controller: controllerOf(m[1], module), action: m[2] } : null;
  };

  let offset = 0;
  for (const rawLine of text.split('\n')) {
    const line = withoutComment(rawLine).trim();
    const lineNo = lineAt(offset);
    offset += rawLine.length + 1;
    if (!line) continue;
    const opens = /\bdo(\s*\|[^|]*\|)?\s*$/.test(line);
    const s = state();

    if (/^end\b/.test(line)) {
      stack.pop();
      continue;
    }

    let m;
    if ((m = /^namespace\s+:(\w+)/.exec(line))) {
      push({ path: `/${option(line, 'path') ?? m[1]}`, module: camel(m[1]) }, opens);
      continue;
    }
    if (/^scope\b/.test(line)) {
      const bare = /^scope\s+(?:'([^']+)'|"([^"]+)"|:(\w+))/.exec(line);
      const path = option(line, 'path') ?? bare?.[1] ?? bare?.[2] ?? bare?.[3] ?? '';
      const mod = option(line, 'module');
      push({ path: path ? `/${path.replace(/^\//, '')}` : '', module: mod ? camel(mod) : '' }, opens);
      continue;
    }
    if ((m = /^(resources|resource)\s+:(\w+)/.exec(line))) {
      const singular = m[1] === 'resource';
      const name = m[2];
      const controller = controllerOf(option(line, 'controller') ?? (singular ? `${name}s` : name), s.module);
      const own = `/${option(line, 'path') ?? name}`;
      const only = symbolList(option(line, 'only'));
      const except = symbolList(option(line, 'except')) ?? [];
      for (const [act, verb, suffix] of singular ? SINGULAR_ACTIONS : RESOURCE_ACTIONS) {
        if (only && !only.includes(act)) continue;
        if (except.includes(act)) continue;
        emit(verb, `${s.path}${own}${suffix}`, controller, act, lineNo);
      }
      // The frame carries only its own segment; the frames above already
      // carry theirs, and the two together are the path.
      push({ path: singular ? own : `${own}/{}`, resource: { controller, singular } }, opens);
      continue;
    }
    if ((m = /^(member|collection)\b/.exec(line))) {
      // Inside a resources block, which already sits at `/things/{}`: member
      // routes stay there, collection routes step back up to `/things`.
      const frame = { path: '' };
      if (m[1] === 'collection' && s.resource && !s.resource.singular) {
        frame.path = '';
        // The enclosing resource frame contributed `/things/{}`; a collection
        // route wants `/things`, so the id segment is taken back.
        frame.collection = true;
      }
      push(frame, opens);
      continue;
    }
    if (/^root\b/.test(line)) {
      const spec = option(line, 'to') ?? /^root\s+(?:'([^']+)'|"([^"]+)")/.exec(line)?.slice(1).find(Boolean);
      const t = target(spec, s.module);
      emit('GET', s.path, t?.controller ?? null, t?.action ?? null, lineNo);
      continue;
    }
    if ((m = /^(get|post|put|patch|delete|match)\s+(?:'([^']+)'|"([^"]+)"|:(\w+))/.exec(line))) {
      const verbWord = m[1];
      const spoken = m[2] ?? m[3] ?? m[4];
      const bySymbol = m[4] != null;
      let spec = option(line, 'to');
      // `get 'legacy' => 'legacy#index'`
      const arrow = /=>\s*(?:'([^']+)'|"([^"]+)")/.exec(line);
      if (!spec && arrow) spec = arrow[1] ?? arrow[2];
      let t = target(spec, s.module);
      // `get :archive` inside `member do` names an action on the resource.
      if (!t && bySymbol && s.resource) t = { controller: s.resource.controller, action: spoken };
      // `get 'profile', controller: 'users', action: 'show'`
      if (!t && option(line, 'controller') && option(line, 'action')) {
        t = { controller: controllerOf(option(line, 'controller'), s.module), action: option(line, 'action') };
      }
      // A collection block sits inside the resource's `/things/{}` frame and
      // wants `/things`: strip the trailing id segment for it.
      const inCollection = stack.length && stack[stack.length - 1].collection;
      const basePath = inCollection ? s.path.replace(/\/\{\}$/, '') : s.path;
      const path = spoken.startsWith('/') && !basePath ? spoken : `${basePath}/${spoken.replace(/^\//, '')}`;
      const verbs =
        verbWord === 'match'
          ? (symbolList(option(line, 'via')) ?? ['ANY']).map((v) => (v === 'all' ? 'ANY' : v.toUpperCase()))
          : [verbWord.toUpperCase()];
      for (const verb of verbs) emit(verb, path, t?.controller ?? null, t?.action ?? null, lineNo);
      // A route can open a block too (`get 'x' do ... end` is rare); keep the stack honest.
      push({}, opens);
      continue;
    }
    // Any other block -- `constraints`, `concern`, `draw`, `devise_scope` --
    // changes nothing about paths, but its `end` must still pop.
    push({}, opens);
  }
  return routes;
}
