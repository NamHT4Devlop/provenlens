/**
 * SQS: a producer names a queue as a string, a consumer declares the same
 * string in an annotation or a worker option. The two are frequently in
 * different repositories, so this links whatever ends are present here and
 * leaves the rest visible as unmatched endpoints.
 */

import { attributeStrings, lineIndex } from './text.js';

const JAVA_LISTENERS = new Set(['@SqsListener', '@SqsHandler', '@JmsListener', '@RabbitListener']);
/** The attributes that name a queue; `factory`, `id` and `containerFactory` do not. */
const QUEUE_ATTRIBUTES = ['value', 'queueNames', 'queues', 'destination'];
/**
 * `send` is the most common method name in a Spring service, and every
 * messaging template has one: `kafkaTemplate.send("orders", ...)` was wired
 * to an `@SqsListener("orders")` two files over, and `mailSender.send(...)`
 * became a queue. Only a receiver that looks like a queue client sends here.
 */
const QUEUE_RECEIVER = /sqs|queue|jms|rabbit|amqp|messag/i;
// NestJS (@ssut/nestjs-sqs) spells the same contract as a decorator.
const TS_LISTENERS = new Set(['@SqsMessageHandler', '@SqsConsumerEventHandler']);
const TS_SENDERS = new Set(['sendMessage', 'sendMessageBatch']);
const JAVA_SENDERS = new Set(['send', 'sendMessage', 'convertAndSend', 'sendMessageBatch']);
const CAMEL_SENDERS = new Set(['to', 'toD', 'wireTap', 'enrich', 'inOnly', 'inOut']);

/** A queue URL still identifies the queue by its last path segment. */
export function queueName(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (/^https?:\/\//.test(trimmed)) return trimmed.split('/').filter(Boolean).pop() ?? null;
  // Placeholders like ${queue.name} name a config key, not a queue.
  if (/^\$\{.*\}$/.test(trimmed) || trimmed.includes('#{')) return null;
  return trimmed;
}

const SHORYUKEN_QUEUE = /shoryuken_options[^\n]*queue:\s*['"]([^'"]+)['"]/g;
const RUBY_SEND = /send_message\s*\(?[^)\n]*queue(?:_url|_name)?:\s*['"]([^'"]+)['"]/g;

export default {
  name: 'sqs',
  edgeKind: 'sends-to',
  confidence: 0.85,

  collect(ctx) {
    // --- Java: annotations declare consumers, send calls declare producers ---
    for (const ref of ctx.refs("f.lang = 'java' AND r.str_args IS NOT NULL")) {
      if (ref.from_symbol_id == null) continue;

      if (ref.kind === 'annotation' && JAVA_LISTENERS.has(ref.name)) {
        const named = ref.raw != null ? attributeStrings(ref.raw, QUEUE_ATTRIBUTES) : ref.strArgs;
        for (const arg of named) {
          const name = queueName(arg);
          if (!name) continue;
          ctx.emit({
            role: 'provider',
            key: name,
            symbolId: ref.from_symbol_id,
            fileId: ref.file_id,
            line: ref.line,
            detail: `${ref.name}("${name}")`,
          });
        }
        continue;
      }

      if (JAVA_SENDERS.has(ref.name)) {
        const generic = ref.name === 'send' || ref.name === 'convertAndSend';
        if (generic && !QUEUE_RECEIVER.test(ref.receiver ?? '')) continue;
        const name = queueName(ref.strArgs?.[0]);
        if (!name) continue;
        ctx.emit({
          role: 'consumer',
          key: name,
          symbolId: ref.from_symbol_id,
          fileId: ref.file_id,
          line: ref.line,
          detail: `${ref.name}("${name}")`,
        });
      }
    }

    // --- TypeScript / NestJS: decorators declare consumers, SDK calls send ---
    for (const ref of ctx.refs(
      "f.lang IN ('typescript', 'tsx', 'javascript') AND r.str_args IS NOT NULL",
    )) {
      if (ref.from_symbol_id == null) continue;

      if (ref.kind === 'annotation' && TS_LISTENERS.has(ref.name)) {
        const name = queueName(ref.strArgs.find(Boolean));
        if (!name) continue;
        ctx.emit({
          role: 'provider',
          key: name,
          symbolId: ref.from_symbol_id,
          fileId: ref.file_id,
          line: ref.line,
          detail: `${ref.name}("${name}")`,
        });
        continue;
      }

      // `send` alone is the most common method name in JS; only an SQS-ish
      // receiver keeps it from flooding the graph with false producers.
      const sends =
        TS_SENDERS.has(ref.name) || (ref.name === 'send' && /sqs/i.test(ref.receiver ?? ''));
      if (ref.kind === 'call' && sends) {
        const name = queueName(ref.strArgs.find(Boolean));
        if (!name) continue;
        ctx.emit({
          role: 'consumer',
          key: name,
          symbolId: ref.from_symbol_id,
          fileId: ref.file_id,
          line: ref.line,
          detail: `${ref.receiver ?? ''}.${ref.name}("${name}")`,
        });
      }
    }

    // --- Camel endpoints naming an SQS queue ---
    // A route that sends to aws2-sqs:orders is a producer for the same queue a
    // @SqsListener consumes, so the two frameworks join up here.
    for (const ref of ctx.refs(
      "f.lang = 'java' AND r.str_args IS NOT NULL AND r.from_symbol_id IS NOT NULL",
    )) {
      const uri = ref.strArgs?.[0];
      const match = /^(?:aws2-)?sqs:\/{0,2}([^?]+)/.exec(uri ?? '');
      if (!match) continue;
      const name = queueName(match[1]);
      if (!name) continue;

      const role = ref.name === 'from' ? 'provider' : 'consumer';
      if (role === 'consumer' && !CAMEL_SENDERS.has(ref.name)) continue;
      ctx.emit({
        role,
        key: name,
        symbolId: ref.from_symbol_id,
        fileId: ref.file_id,
        line: ref.line,
        detail: `camel ${uri}`,
      });
    }

    // --- Ruby: Shoryuken workers, read from the source text ---
    // Ruby offers no types here, so a narrow regex over the file beats
    // pretending the AST knows what a queue is.
    const rubyFiles = ctx.db
      .prepare("SELECT id, path FROM files WHERE lang = 'ruby'")
      .all();

    for (const file of rubyFiles) {
      let content;
      try {
        content = ctx.readSource(file.path);
      } catch {
        continue;
      }
      if (!content || !/shoryuken|send_message/.test(content)) continue;

      const classSymbol = ctx.db
        .prepare(
          `SELECT id FROM symbols WHERE file_id = ? AND kind = 'class' ORDER BY start_line LIMIT 1`,
        )
        .get(file.id);
      if (!classSymbol) continue;

      // With a line: an edge keyed on a NULL line never matches another, so
      // two sends to one queue from one class used to insert the same edge
      // twice, and the listener read as having two callers.
      const lineAt = lineIndex(content);
      for (const m of content.matchAll(SHORYUKEN_QUEUE)) {
        ctx.emit({ role: 'provider', key: m[1], symbolId: classSymbol.id, fileId: file.id, line: lineAt(m.index), detail: m[1] });
      }
      for (const m of content.matchAll(RUBY_SEND)) {
        const clean = queueName(m[1]);
        if (clean) {
          ctx.emit({ role: 'consumer', key: clean, symbolId: classSymbol.id, fileId: file.id, line: lineAt(m.index), detail: clean });
        }
      }
    }
  },
};
