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
 * single service the providers alone are worth having: `codelens routes` then
 * answers "which method serves POST /orders", which is otherwise a grep
 * through annotations that may not even be on the method.
 */

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
const EXPRESS_RECEIVERS = /^(app|router|api|server|r)$/i;

/** Java and TypeScript clients that name a path as their first string. */
const JAVA_CLIENT = new Set([
  'getForObject', 'getForEntity', 'postForObject', 'postForEntity', 'put', 'delete',
  'exchange', 'uri', 'patchForObject',
]);
const TS_CLIENT = new Set(['get', 'post', 'put', 'delete', 'patch', 'fetch', 'request']);
const TS_CLIENT_RECEIVERS = /^(axios|http|client|api|fetch|request|superagent|got)$/i;

const RUBY_ROUTE =
  /^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"](?:\s*,\s*(?:to:|=>)\s*['"]([^'"]+)['"])?/gm;
const RUBY_RESOURCES = /^\s*resources?\s+:([a-z_0-9]+)/gm;

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

    for (const ref of ctx.refs("r.kind = 'annotation' AND r.str_args IS NOT NULL")) {
      const owner = symbolById.get(ref.from_symbol_id);
      if (!owner || !['class', 'interface'].includes(owner.kind)) continue;
      if (ref.name !== '@RequestMapping' && ref.name !== '@Controller') continue;
      const first = ref.strArgs.find((a) => typeof a === 'string' && a.trim());
      const p = first ? normalizePath(first) : null;
      if (p) prefixes.set(owner.fqn, p);
    }

    // --- providers: the handler that serves a path ---
    for (const ref of ctx.refs("r.kind = 'annotation' AND r.str_args IS NOT NULL")) {
      const verb = SPRING_VERBS[ref.name] ?? NEST_VERBS[ref.name] ?? null;
      const isRequestMapping = ref.name === '@RequestMapping';
      if (!verb && !isRequestMapping) continue;
      const owner = symbolById.get(ref.from_symbol_id);
      if (!owner || ['class', 'interface'].includes(owner.kind)) continue;

      // `@RequestMapping(method = RequestMethod.POST)` names its verb inline;
      // with none it answers every verb, and ANY says so rather than guessing.
      let method = verb;
      if (isRequestMapping) {
        const named = ref.strArgs.find((a) => /^(GET|POST|PUT|DELETE|PATCH)$/i.test(String(a)));
        method = named ? String(named).toUpperCase() : 'ANY';
      }
      // A verb decorator with no argument serves the class prefix itself.
      const raw = ref.strArgs.find((a) => typeof a === 'string' && a.trim()) ?? '';
      const prefix = prefixes.get(owner.container_fqn) ?? null;
      const key = routeKey(method, joinPaths(prefix, raw || '/'));
      if (!key) continue;
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
        const anyKey = key.replace(/^\S+/, 'ANY');
        ctx.emit({
          role: 'provider',
          key: anyKey,
          symbolId: ref.from_symbol_id,
          fileId: ref.file_id,
          line: ref.line,
          detail: `${ref.name} ${key}`,
        });
      }
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
    for (const file of ctx.files.length ? ctx.files : []) void file;
    for (const row of ctx.db
      .prepare("SELECT id, path FROM files WHERE lang = 'ruby' AND path LIKE '%config/routes.rb'")
      .all()) {
      let text;
      try {
        text = ctx.readSource(row.path);
      } catch {
        continue;
      }
      for (const m of text.matchAll(RUBY_ROUTE)) {
        const key = routeKey(m[1].toUpperCase(), m[2]);
        if (!key) continue;
        const line = text.slice(0, m.index).split('\n').length;
        ctx.emit({
          role: 'provider',
          key,
          symbolId: null,
          fileId: row.id,
          line,
          detail: m[3] ? `${key} -> ${m[3]}` : key,
        });
      }
      // `resources :orders` is seven routes written as one line.
      for (const m of text.matchAll(RUBY_RESOURCES)) {
        const name = m[1];
        const line = text.slice(0, m.index).split('\n').length;
        for (const [verb, path] of [
          ['GET', `/${name}`], ['POST', `/${name}`], ['GET', `/${name}/{}`],
          ['PUT', `/${name}/{}`], ['PATCH', `/${name}/{}`], ['DELETE', `/${name}/{}`],
        ]) {
          const key = routeKey(verb, path);
          if (!key) continue;
          ctx.emit({
            role: 'provider', key, symbolId: null, fileId: row.id, line,
            detail: `resources :${name}`,
          });
        }
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
