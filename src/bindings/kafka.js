/**
 * Kafka: a producer names a topic as a string, a consumer declares the same
 * string in an annotation, a decorator or a client call.
 *
 * The two ends are usually in different services, so this links whichever are
 * present here and leaves the rest visible as unmatched endpoints -- the same
 * arrangement the SQS plugin uses, for the same reason.
 *
 * Which end is the "provider" is worth stating, because the words invert. The
 * *consumer* of a topic is where the work happens, so it is the provider of
 * this binding; the *producer* points at it. That matches `sends-to`: an edge
 * runs from whoever sends to whoever handles.
 */

/** Spring Kafka, and the Spring Cloud Stream spelling of the same contract. */
const JAVA_LISTENERS = new Set(['@KafkaListener', '@StreamListener', '@KafkaHandler']);
/** NestJS microservices: the Kafka transport reads these off a controller. */
const TS_LISTENERS = new Set(['@MessagePattern', '@EventPattern']);

/**
 * A topic name, or null when the string names something else.
 *
 * `${kafka.topic}` and `#{...}` name a configuration key; the value lives in a
 * file this plugin cannot read, and guessing the key is the topic would wire
 * two services together on a coincidence of spelling.
 */
export function topicName(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (/^\$\{.*\}$/.test(trimmed) || trimmed.includes('#{')) return null;
  // A pattern subscribes to many topics and names none of them.
  if (/[*?]|^\/.*\/$/.test(trimmed)) return null;
  // Group ids, client ids and the like arrive in the same argument list.
  return trimmed;
}

/**
 * KafkaJS passes everything in an object -- `send({ topic: 'orders', ... })` --
 * and the extractors record only string literals that are arguments in their
 * own right, so `str_args` never sees it. A narrow regex over the source is
 * what the SQS plugin already does for Ruby, and for the same reason: the AST
 * here would have to be taught what a topic is.
 */
const JS_TOPIC = /\b(subscribe|send|sendBatch|produce|publish)\s*\(\s*\{[^}]{0,200}?\btopic\s*:\s*['"`]([^'"`]+)['"`]/g;
/** `topic :orders do ... end` inside a Karafka routing block. */
const RUBY_KARAFKA_TOPIC = /^\s*topic\s+[:'"]([\w.-]+)['"]?\s*do/gm;
/** `produce_async(topic: 'orders', ...)` and its sync sibling. */
const RUBY_KARAFKA_PRODUCE = /produce_(?:async|sync|many_async|many_sync)\s*\(?[^)\n]*topic:\s*['"]([^'"]+)['"]/g;

/** The innermost symbol whose line span contains `line`. */
function enclosingSymbol(db, fileId, line) {
  return db
    .prepare(
      `SELECT id FROM symbols
        WHERE file_id = ? AND kind != 'file' AND start_line <= ? AND end_line >= ?
        ORDER BY (end_line - start_line) ASC LIMIT 1`,
    )
    .get(fileId, line, line);
}

/** Failing that, the file's first class -- enough to name the service. */
function fileAnchor(db, fileId) {
  return db
    .prepare(
      `SELECT id FROM symbols WHERE file_id = ? AND kind IN ('class', 'module', 'function')
        ORDER BY start_line LIMIT 1`,
    )
    .get(fileId);
}

export default {
  name: 'kafka',
  edgeKind: 'sends-to',
  confidence: 0.85,

  collect(ctx) {
    // --- Java: annotations declare the handler, send calls declare the sender -
    for (const ref of ctx.refs("f.lang = 'java' AND r.str_args IS NOT NULL")) {
      if (ref.from_symbol_id == null) continue;

      if (ref.kind === 'annotation' && JAVA_LISTENERS.has(ref.name)) {
        // @KafkaListener(topics = {"a", "b"}, groupId = "g") puts the group id
        // in the same list. Only the values named by `topics` are topics, and
        // the extractor does not keep the attribute names -- so a group id
        // would be indistinguishable if the annotation text were not re-read.
        for (const topic of topicsFromAnnotation(ctx, ref)) {
          ctx.emit({
            role: 'provider',
            key: topic,
            symbolId: ref.from_symbol_id,
            fileId: ref.file_id,
            line: ref.line,
            detail: `${ref.name}("${topic}")`,
          });
        }
        continue;
      }

      // kafkaTemplate.send("orders", key, value). `send` alone is far too
      // common a name, so the receiver has to look like a Kafka client -- and
      // specifically like one: `template` alone caught `sqsTemplate.send` in
      // the fixture next door, which is another plugin's endpoint entirely.
      // Missing an ambiguously named field costs one link; claiming it wires
      // two services together that never spoke.
      const looksKafka = /kafka|stream/i.test(ref.receiver ?? '');
      if (ref.kind === 'call' && (ref.name === 'send' || ref.name === 'sendDefault') && looksKafka) {
        const topic = topicName(ref.strArgs?.[0]);
        if (!topic) continue;
        ctx.emit({
          role: 'consumer',
          key: topic,
          symbolId: ref.from_symbol_id,
          fileId: ref.file_id,
          line: ref.line,
          detail: `${ref.receiver ?? ''}.${ref.name}("${topic}")`,
        });
      }

      // @SendTo("replies") on a listener names where its return value goes.
      if (ref.kind === 'annotation' && ref.name === '@SendTo') {
        const topic = topicName(ref.strArgs?.[0]);
        if (!topic) continue;
        ctx.emit({
          role: 'consumer',
          key: topic,
          symbolId: ref.from_symbol_id,
          fileId: ref.file_id,
          line: ref.line,
          detail: `@SendTo("${topic}")`,
        });
      }
    }

    // --- NestJS: a decorated handler is where a topic's work happens --------
    for (const ref of ctx.refs(
      "f.lang IN ('typescript', 'tsx', 'javascript') AND r.kind = 'annotation' AND r.str_args IS NOT NULL",
    )) {
      if (ref.from_symbol_id == null || !TS_LISTENERS.has(ref.name)) continue;
      const topic = topicName(ref.strArgs.find(Boolean));
      if (!topic) continue;
      ctx.emit({
        role: 'provider',
        key: topic,
        symbolId: ref.from_symbol_id,
        fileId: ref.file_id,
        line: ref.line,
        detail: `${ref.name}("${topic}")`,
      });
    }

    // --- KafkaJS and Karafka: read from the source, anchored by line --------
    const sourceFiles = ctx.db
      .prepare("SELECT id, path, lang FROM files WHERE lang IN ('typescript','tsx','javascript','ruby') AND external = 0")
      .all();

    for (const file of sourceFiles) {
      let content;
      try {
        content = ctx.readSource(file.path);
      } catch {
        continue;
      }
      if (!/kafka|karafka|topic/i.test(content)) continue;

      const at = (index) => content.slice(0, index).split('\n').length;
      const anchor = (line) =>
        enclosingSymbol(ctx.db, file.id, line)?.id ?? fileAnchor(ctx.db, file.id)?.id ?? null;

      if (file.lang === 'ruby') {
        for (const m of content.matchAll(RUBY_KARAFKA_TOPIC)) {
          const topic = topicName(m[1]);
          const line = at(m.index);
          const symbolId = anchor(line);
          if (!topic || symbolId == null) continue;
          ctx.emit({ role: 'provider', key: topic, symbolId, fileId: file.id, line, detail: `topic :${topic}` });
        }
        for (const m of content.matchAll(RUBY_KARAFKA_PRODUCE)) {
          const topic = topicName(m[1]);
          const line = at(m.index);
          const symbolId = anchor(line);
          if (!topic || symbolId == null) continue;
          ctx.emit({ role: 'consumer', key: topic, symbolId, fileId: file.id, line, detail: `produce(topic: "${topic}")` });
        }
        continue;
      }

      for (const m of content.matchAll(JS_TOPIC)) {
        const [, method, raw] = m;
        const topic = topicName(raw);
        const line = at(m.index);
        const symbolId = anchor(line);
        if (!topic || symbolId == null) continue;
        // subscribe() is where a consumer starts handling a topic; the rest send.
        const role = method === 'subscribe' ? 'provider' : 'consumer';
        ctx.emit({ role, key: topic, symbolId, fileId: file.id, line, detail: `${method}({ topic: "${topic}" })` });
      }
    }
  },
};

/**
 * The topics named by a `@KafkaListener`, without the group id sitting beside
 * them in the same string list.
 *
 * `str_args` keeps the values and drops the attribute names, so the annotation
 * text is read again from the file. Guessing that the first value is a topic
 * would be right most of the time, and wiring two services together on "most
 * of the time" is exactly the kind of link the floor exists to strike off.
 */
function topicsFromAnnotation(ctx, ref) {
  const file = ctx.db.prepare('SELECT path FROM files WHERE id = ?').get(ref.file_id);
  let text = '';
  try {
    const lines = ctx.readSource(file.path).split('\n');
    text = lines.slice(Math.max(0, (ref.line ?? 1) - 1), (ref.line ?? 1) + 2).join(' ');
  } catch {
    return [];
  }
  const attr = /\btopics?\s*=\s*(\{[^}]*\}|"[^"]*")/.exec(text);
  if (!attr) return [];
  return [...attr[1].matchAll(/"([^"]+)"/g)].map((m) => topicName(m[1])).filter(Boolean);
}
