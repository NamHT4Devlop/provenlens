/**
 * Spring application events: a publisher constructs an event, a listener
 * declares the same type as its parameter, and nothing calls anything.
 *
 * Unlike the other plugins here the shared token is not a string in the source
 * -- it is a *type name*. That changes where it is read from, not what the
 * binding is: two pieces of code named the same thing and a generic pass joins
 * them.
 *
 * As everywhere else, the listener is the provider: it is where the work
 * happens, and the publisher points at it.
 */

/** Spring's four spellings of "call me when this event is published". */
const LISTENER_ANNOTATIONS = new Set([
  'EventListener',
  'TransactionalEventListener',
  'ApplicationModuleListener',
]);

/** The publisher side, on ApplicationEventPublisher or the context itself. */
const PUBLISH_METHODS = new Set(['publishEvent', 'publish']);

/**
 * An event type, or null when the name says nothing worth matching on.
 *
 * A generic parameter (`T`), a primitive, and `Object` are all names two
 * unrelated pieces of code would share by accident, and joining on one would
 * invent a link rather than find it.
 */
export function eventType(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // `com.shop.OrderPlaced` and `OrderPlaced` are the same event; a listener
  // usually imports it and a publisher usually constructs it unqualified.
  const simple = raw.trim().replace(/<.*>$/, '').split('.').pop() ?? '';
  if (!/^[A-Z][\w$]*$/.test(simple)) return null;
  if (simple.length < 3) return null; // a type variable, not an event
  if (['Object', 'String', 'Event', 'Exception', 'Throwable'].includes(simple)) return null;
  return simple;
}

export default {
  name: 'spring-event',
  edgeKind: 'publishes-to',
  confidence: 0.8,

  collect(ctx) {
    // --- Listeners: an annotated method whose parameter names the event -----
    const listeners = ctx.db
      .prepare(
        `SELECT id, name, file_id, params, annotations, start_line
           FROM symbols
          WHERE kind = 'method' AND annotations IS NOT NULL AND annotations != '[]'`,
      )
      .all();

    for (const method of listeners) {
      let annotations = [];
      let params = [];
      try {
        annotations = JSON.parse(method.annotations || '[]');
        params = JSON.parse(method.params || '[]');
      } catch {
        continue;
      }
      if (!annotations.some((a) => LISTENER_ANNOTATIONS.has(String(a).replace(/^@/, '')))) continue;

      // `@EventListener void on(OrderPlaced e)` -- the first parameter is the
      // event. A listener with none takes its type from the annotation's
      // `classes` attribute, which str_args does not keep, so it is left alone
      // rather than guessed at.
      const key = eventType(params[0]);
      if (!key) continue;
      ctx.emit({
        role: 'provider',
        key,
        symbolId: method.id,
        fileId: method.file_id,
        line: method.start_line,
        detail: `@EventListener(${key})`,
      });
    }

    // --- Publishers: publishEvent(new OrderPlaced(...)) --------------------
    // The call itself carries no type -- arg_types is [null] for a constructed
    // argument -- but the `new` is its own ref, on the same line and inside the
    // same method. That is the only place the event's name appears.
    const constructedAt = new Map(); // `symbolId:line` -> outermost type name
    for (const ref of ctx.refs("r.kind = 'new' AND r.from_symbol_id IS NOT NULL")) {
      // First wins, not last. `publishEvent(new ApplicationFailedEvent(new
      // SpringApplication(this), ...))` puts two constructors on one line, and
      // the event is the outer one -- which the walk reaches first. Keeping the
      // last made SpringApplication an event five times over in spring-boot.
      //
      // Refs carry a line and no column, so a line holding a publish and an
      // unrelated `new` before it would still read the wrong type. That is a
      // narrower mistake than the one it replaces, and it is the limit of what
      // this can know.
      const at = `${ref.from_symbol_id}:${ref.line}`;
      if (!constructedAt.has(at)) constructedAt.set(at, ref.name);
    }

    for (const ref of ctx.refs("f.lang = 'java' AND r.kind = 'call' AND r.from_symbol_id IS NOT NULL")) {
      if (!PUBLISH_METHODS.has(ref.name)) continue;
      // `publish` alone is a common method name; only a publisher-ish receiver
      // keeps it from claiming every unrelated call in the repository.
      if (ref.name === 'publish' && !/publisher|event|context/i.test(ref.receiver ?? '')) continue;

      const built = constructedAt.get(`${ref.from_symbol_id}:${ref.line}`);
      const key = eventType(built);
      if (!key) continue;
      ctx.emit({
        role: 'consumer',
        key,
        symbolId: ref.from_symbol_id,
        fileId: ref.file_id,
        line: ref.line,
        detail: `${ref.name}(new ${key}(...))`,
      });
    }
  },
};
