/**
 * Apache Camel: routes are joined by endpoint URI, not by calls. `from("...")`
 * declares where a route starts; `to("...")` and friends send work to one. A
 * call graph sees two unrelated string literals.
 *
 * Every route in a RouteBuilder lives in the same `configure()` method, so the
 * method is too coarse to be the unit: linking it to itself says nothing. Each
 * `from(...)` therefore becomes its own symbol, and the sends below it -- up to
 * the next `from(...)` -- belong to that route.
 */

/** Consumers: everything that dispatches to another endpoint. */
const SENDERS = new Set([
  'to', 'toD', 'toF', 'wireTap', 'enrich', 'pollEnrich', 'recipientList', 'inOut', 'inOnly',
]);

/**
 * `seda:orders?concurrentConsumers=5` -> `seda:orders`.
 * Options change how an endpoint behaves, not which endpoint it is.
 */
export function normalizeUri(uri) {
  if (!uri) return null;
  const clean = uri.split('?')[0].trim();
  if (!clean || !clean.includes(':')) return null;
  const [scheme, ...rest] = clean.split(':');
  return `${scheme.toLowerCase()}:${rest.join(':')}`;
}

/** Only schemes naming an in-application destination are worth linking. */
const ROUTABLE = /^(direct|seda|vm|direct-vm|activemq|jms|rabbitmq|kafka|sqs|aws2-sqs|stream):/;

export default {
  name: 'camel',
  edgeKind: 'routes-to',
  confidence: 0.9,

  collect(ctx) {
    const refs = ctx
      .refs("f.lang = 'java' AND r.str_args IS NOT NULL AND r.from_symbol_id IS NOT NULL")
      .filter((r) => r.name === 'from' || SENDERS.has(r.name))
      .map((r) => ({ ...r, uri: normalizeUri(r.strArgs?.[0]) }))
      .filter((r) => r.uri && ROUTABLE.test(r.uri));

    if (!refs.length) return;

    // Group by enclosing method, then split on each from(...).
    const byMethod = new Map();
    for (const ref of refs) {
      if (!byMethod.has(ref.from_symbol_id)) byMethod.set(ref.from_symbol_id, []);
      byMethod.get(ref.from_symbol_id).push(ref);
    }

    for (const [methodId, group] of byMethod) {
      group.sort((a, b) => a.line - b.line);
      const method = ctx.db
        .prepare('SELECT container_fqn, end_line FROM symbols WHERE id = ?')
        .get(methodId);

      let route = null; // { symbolId, uri }

      for (const ref of group) {
        if (ref.name === 'from') {
          const symbolId = ctx.addSymbol({
            fileId: ref.file_id,
            name: ref.uri,
            fqn: `${method?.container_fqn ?? ''}#route:${ref.uri}`,
            kind: 'camel-route',
            containerFqn: method?.container_fqn ?? null,
            signature: `from("${ref.uri}")`,
            startLine: ref.line,
            endLine: method?.end_line ?? ref.line,
            annotations: ['camel'],
          });
          route = { symbolId, uri: ref.uri };
          ctx.emit({
            role: 'provider',
            key: ref.uri,
            symbolId,
            fileId: ref.file_id,
            line: ref.line,
            detail: ref.uri,
          });
          continue;
        }

        // A send before any from(...) is not part of a route we can name.
        if (!route) continue;
        ctx.emit({
          role: 'consumer',
          key: ref.uri,
          symbolId: route.symbolId,
          fileId: ref.file_id,
          line: ref.line,
          detail: `${route.uri} -> ${ref.uri}`,
        });
      }
    }
  },
};
