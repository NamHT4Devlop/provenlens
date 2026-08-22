/**
 * SQS: a producer names a queue as a string, a consumer declares the same
 * string in an annotation or a worker option. The two are frequently in
 * different repositories, so this links whatever ends are present here and
 * leaves the rest visible as unmatched endpoints.
 */

const JAVA_LISTENERS = new Set(['@SqsListener', '@SqsHandler', '@JmsListener', '@RabbitListener']);
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
        for (const arg of ref.strArgs) {
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

      for (const [, name] of content.matchAll(SHORYUKEN_QUEUE)) {
        ctx.emit({ role: 'provider', key: name, symbolId: classSymbol.id, fileId: file.id, detail: name });
      }
      for (const [, name] of content.matchAll(RUBY_SEND)) {
        const clean = queueName(name);
        if (clean) {
          ctx.emit({ role: 'consumer', key: clean, symbolId: classSymbol.id, fileId: file.id, detail: clean });
        }
      }
    }
  },
};
