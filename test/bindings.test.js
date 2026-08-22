import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from './helpers.js';
import { calleesOf, callersOf } from '../src/query.js';
import { normalizeUri } from '../src/bindings/camel.js';
import { queueName } from '../src/bindings/sqs.js';
import { tablesIn, tablesReferenced } from '../src/bindings/flyway.js';

let db;
let one;
let stats;

before(async () => {
  ({ db, one, stats } = await buildIndex('bindings'));
});

/** Edges a plugin created, as "from -> to" pairs. */
const wiredBy = (plugin) =>
  db
    .prepare(
      `SELECT sf.fqn AS f, st.fqn AS t FROM edges e
         JOIN symbols sf ON sf.id = e.from_symbol_id
         JOIN symbols st ON st.id = e.to_symbol_id
        WHERE e.via = ?`,
    )
    .all(`binding:${plugin}`)
    .map((r) => `${r.f} -> ${r.t}`)
    .sort();

describe('uri and name normalisation', () => {
  test('drops Camel endpoint options but keeps the endpoint', () => {
    assert.equal(normalizeUri('seda:persistOrder?concurrentConsumers=5'), 'seda:persistOrder');
    assert.equal(normalizeUri('DIRECT:orders'), 'direct:orders');
    assert.equal(normalizeUri('notauri'), null);
  });

  test('reduces a queue URL to the queue name', () => {
    assert.equal(queueName('https://sqs.eu-west-1.amazonaws.com/1234/order-events'), 'order-events');
    assert.equal(queueName('order-events'), 'order-events');
  });

  test('refuses a config placeholder, which names a key and not a queue', () => {
    assert.equal(queueName('${app.queue.orders}'), null);
  });

  test('separates tables a migration changes from tables a query reads', () => {
    assert.deepEqual(tablesIn('CREATE TABLE orders (id INT); ALTER TABLE items ADD c INT;').sort(), [
      'items',
      'orders',
    ]);
    assert.deepEqual(tablesReferenced('SELECT * FROM orders JOIN items ON 1=1').sort(), [
      'items',
      'orders',
    ]);
  });
});

describe('mybatis', () => {
  test('makes each XML statement a readable symbol', () => {
    const statement = db
      .prepare("SELECT * FROM symbols WHERE kind = 'sql-statement' AND name = 'findById'")
      .get();
    assert.ok(statement, 'expected the XML statement to be indexed');
    assert.equal(statement.container_fqn, 'com.shop.mapper.OrderMapper');
    assert.match(statement.signature, /<select id="findById">/);
  });

  test('links a mapper method to the SQL that actually runs', () => {
    // The interface has no implementation anywhere in the source.
    const method = db
      .prepare(
        `SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id
          WHERE s.fqn = 'com.shop.mapper.OrderMapper#findById' AND f.lang = 'java'`,
      )
      .get();
    const targets = calleesOf(db, method.id).filter((c) => c.edge_kind === 'implemented-by');
    assert.equal(targets.length, 1);
    assert.equal(targets[0].lang, 'xml');
  });

  test('wires every statement in the mapper', () => {
    assert.equal(stats.bindings.mybatis.wired, 3);
  });

  test('does not take over the FQN of the method it implements', () => {
    // Both symbols sharing one FQN made every mapper method ambiguous, so
    // `codelens node OrderMapper#findById` could not resolve at all.
    const fqns = db
      .prepare("SELECT s.fqn FROM symbols s WHERE s.name = 'findById' ORDER BY s.fqn")
      .all()
      .map((r) => r.fqn);
    assert.deepEqual(fqns, [
      'com.shop.mapper.OrderMapper#findById',
      'sql:com.shop.mapper.OrderMapper#findById',
    ]);
  });

  test('resolves the written method ahead of the derived statement', () => {
    const top = one('OrderMapper#findById');
    assert.equal(top.lang, 'java', 'the Java method is what the name refers to');
  });
});

describe('camel', () => {
  test('gives each route its own symbol rather than the enclosing method', () => {
    // All three routes live in one configure(), so the method cannot be the unit.
    const routes = db
      .prepare("SELECT name FROM symbols WHERE kind = 'camel-route' ORDER BY name")
      .all()
      .map((r) => r.name);
    assert.deepEqual(routes, ['direct:receiveOrder', 'direct:validateOrder', 'seda:persistOrder']);
  });

  test('follows a route chain across separate from() declarations', () => {
    assert.deepEqual(wiredBy('camel'), [
      'com.shop.route.OrderRoute#route:direct:receiveOrder -> com.shop.route.OrderRoute#route:direct:validateOrder',
      'com.shop.route.OrderRoute#route:direct:validateOrder -> com.shop.route.OrderRoute#route:seda:persistOrder',
    ]);
  });

  test('ignores endpoint options when matching', () => {
    // The route declares seda:persistOrder; the sender writes it with options.
    const target = one('seda:persistOrder');
    assert.ok(callersOf(db, target.id).length > 0);
  });
});

describe('sqs', () => {
  test('links a producer to a listener on the same queue', () => {
    assert.ok(
      wiredBy('sqs').includes(
        'com.shop.messaging.OrderPublisher#publish -> com.shop.messaging.OrderListener#handleOrder',
      ),
    );
  });

  test('crosses languages: a Java producer reaches a Ruby worker', () => {
    assert.ok(wiredBy('sqs').includes('com.shop.messaging.OrderPublisher#publish -> OrderWorker'));
  });

  test('treats a Camel sqs endpoint as a producer for the same queue', () => {
    assert.ok(
      wiredBy('sqs').some((e) => e.startsWith('com.shop.route.OrderRoute#configure ->')),
      'a route sending to aws2-sqs:order-events must reach that queue listener',
    );
  });
});

describe('flyway', () => {
  test('indexes each migration as a symbol naming the tables it touches', () => {
    const migrations = db
      .prepare("SELECT name, annotations FROM symbols WHERE kind = 'migration' ORDER BY name")
      .all();
    assert.equal(migrations.length, 2);
    assert.deepEqual(JSON.parse(migrations[0].annotations), ['orders']);
  });

  test('links a migration to the queries that read the table', () => {
    // The SQL statement is what reads the table, not the Java method that
    // declares it, so the edge starts from the statement symbol.
    assert.ok(
      wiredBy('flyway').some((e) => e.startsWith('sql:com.shop.mapper.OrderMapper#findById ->')),
      'a query selecting from orders must reach the migration that created it',
    );
  });

  test('links a migration to the entity named after the table', () => {
    assert.ok(wiredBy('flyway').some((e) => e.startsWith('com.shop.mapper.Order ->')));
  });

  test('keeps convention-based links at lower confidence than observed calls', () => {
    const row = db.prepare("SELECT confidence FROM edges WHERE via = 'binding:flyway' LIMIT 1").get();
    assert.ok(row.confidence < 0.9, 'a naming-convention guess must not look like a real call');
  });
});
