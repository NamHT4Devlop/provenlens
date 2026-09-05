import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from './helpers.js';
import { calleesOf, callersOf } from '../src/query.js';
import { normalizeUri } from '../src/bindings/camel.js';
import { queueName } from '../src/bindings/sqs.js';
import { topicName } from '../src/bindings/kafka.js';
import { eventType } from '../src/bindings/springevent.js';
import { tablesIn, tablesReferenced } from '../src/bindings/flyway.js';

let db;
let one;
let stats;

before(async () => {
  ({ db, one, stats } = await buildIndex('bindings'));
});

/** Endpoints a plugin recorded, with the symbol each is attached to. */
const endpointsOf = (plugin) =>
  db
    .prepare(
      `SELECT b.role, b.key, s.fqn FROM bindings b JOIN symbols s ON s.id = b.symbol_id
        WHERE b.plugin = ?`,
    )
    .all(plugin);

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
    // `provenlens node OrderMapper#findById` could not resolve at all.
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

describe('sqs across TypeScript', () => {
  test('records decorators as annotations, the way Java annotations are', () => {
    const handler = one('OrderEventsHandler#handle');
    assert.ok(JSON.parse(handler.annotations).includes('@SqsMessageHandler'));
  });


  test('a NestJS decorator declares a consumer for the same queue', () => {
    // @SqsMessageHandler('order-events') is the TS spelling of @SqsListener.
    assert.ok(
      wiredBy('sqs').includes('com.shop.messaging.OrderPublisher#publish -> src/order_events_handler:OrderEventsHandler#handle'),
      `saw: ${wiredBy('sqs').join(' | ')}`,
    );
  });

  test('an SDK send with a queue name is a producer, cross-language both ways', () => {
    const wired = wiredBy('sqs');
    assert.ok(
      wired.includes('src/order_events_handler:ShipmentPublisher#notifyShipped -> OrderWorker'),
      `the TS producer must reach the Ruby worker; saw: ${wired.join(' | ')}`,
    );
  });
});

describe('kafka', () => {
  test('a topic name is refused when it names a config key or a pattern', () => {
    assert.equal(topicName('orders'), 'orders');
    assert.equal(topicName('  orders  '), 'orders');
    // A placeholder names a key whose value lives in a file this cannot read.
    // Wiring two services on the spelling of the key would be an invention.
    assert.equal(topicName('${app.topic.audit}'), null);
    assert.equal(topicName('#{topicName}'), null);
    // A pattern subscribes to many topics and names none of them.
    assert.equal(topicName('orders.*'), null);
    assert.equal(topicName('/orders-.+/'), null);
    assert.equal(topicName('two words'), null);
    assert.equal(topicName(''), null);
  });

  test('a @KafkaListener declares the handler, and its group id is not a topic', () => {
    const endpoints = endpointsOf('kafka');
    const shipments = endpoints.filter((e) => e.key === 'shipments' && e.role === 'provider');
    assert.equal(shipments.length, 1);
    assert.match(shipments[0].fqn, /ShipmentListener#onShipment/);

    // topics = {"returns", "refunds"}, groupId = "returns-service" -- str_args
    // keeps the values and drops the attribute names, so all three arrive
    // together and only the annotation text can tell them apart.
    for (const topic of ['returns', 'refunds']) {
      assert.ok(
        endpoints.some((e) => e.key === topic && e.role === 'provider'),
        `${topic} is a topic`,
      );
    }
    for (const notATopic of ['shipping-service', 'returns-service']) {
      assert.ok(!endpoints.some((e) => e.key === notATopic), `${notATopic} is a group id`);
    }
  });

  test('a producer reaches the handler, across languages', () => {
    const wired = wiredBy('kafka');
    // Java -> Java, and the two that no call graph could see at all.
    assert.ok(
      wired.some((w) => /OrderProducer#ship -> .*ShipmentListener#onShipment/.test(w)),
      `java producer should reach the listener, saw ${JSON.stringify(wired)}`,
    );
    assert.ok(
      wired.some((w) => /AuditWorker#forward -> .*ShipmentListener#onShipment/.test(w)),
      'a Ruby producer reaches a Java listener',
    );
    assert.ok(
      wired.some((w) => /kafka_consumer:emitOrder -> .*ShipmentListener#onShipment/.test(w)),
      'a KafkaJS producer reaches a Java listener',
    );
  });

  test('KafkaJS and Karafka name the topic in a place str_args never sees', () => {
    // `send({ topic: 'x' })` is an object argument, and the extractors record
    // only string literals that are arguments in their own right. Without the
    // source-level read these three links do not exist at all.
    const endpoints = endpointsOf('kafka');
    assert.ok(
      endpoints.some((e) => e.key === 'audit-log' && /kafka_consumer:startAudit/.test(e.fqn)),
      'KafkaJS subscribe() declares a handler',
    );
    assert.ok(
      endpoints.some((e) => e.key === 'audit-log' && /AuditWorker/.test(e.fqn)),
      'Karafka `topic :x do` declares a handler',
    );
  });

  test('a topic named by configuration produces no endpoint at all', () => {
    // OrderProducer#configured sends to "${app.topic.audit}". Guessing that
    // the key is the topic would wire services together on a coincidence.
    const endpoints = endpointsOf('kafka');
    assert.ok(!endpoints.some((e) => /configured/.test(e.fqn)), 'the placeholder is refused');
  });

  test('it does not claim another plugin\'s endpoints', () => {
    // `sqsTemplate.send("order-events")` matched an earlier version of the
    // receiver test, which accepted any `template`. One plugin inventing links
    // out of another's fixture is the failure mode worth a test of its own.
    const endpoints = endpointsOf('kafka');
    assert.ok(!endpoints.some((e) => e.key === 'order-events'), 'order-events belongs to sqs');
    assert.ok(!endpoints.some((e) => /sqs/i.test(e.fqn)), 'no SQS symbol is a kafka endpoint');
  });
});

describe('spring events', () => {
  test('an event type is refused when the name is one anything could share', () => {
    assert.equal(eventType('OrderPlaced'), 'OrderPlaced');
    // A listener imports the event; a publisher usually constructs it
    // unqualified. Both spellings name the same event.
    assert.equal(eventType('com.shop.events.OrderPlaced'), 'OrderPlaced');
    assert.equal(eventType('OrderPlaced<String>'), 'OrderPlaced');
    // Names two unrelated methods share by accident. Joining on one of these
    // would invent a link rather than find it.
    assert.equal(eventType('Object'), null);
    assert.equal(eventType('String'), null);
    assert.equal(eventType('T'), null);
    assert.equal(eventType('int'), null);
    assert.equal(eventType(''), null);
  });

  test('a publisher reaches the listener that declares the same type', () => {
    const wired = wiredBy('spring-event');
    assert.ok(
      wired.some((w) => /OrderEvents#place -> .*OrderAudit#onPlaced/.test(w)),
      `the publisher should reach the listener, saw ${JSON.stringify(wired)}`,
    );
  });

  test('the event type comes from the constructor, not the call', () => {
    // publishEvent(new OrderPlaced(id)) carries no type on the call itself --
    // arg_types is [null] for a constructed argument. The `new` is its own ref
    // on the same line inside the same method, and is the only place the
    // event's name appears at all.
    const published = endpointsOf('spring-event').filter((e) => e.role === 'consumer');
    assert.ok(
      published.some((e) => /#place$/.test(e.fqn) && e.key === 'OrderPlaced'),
      `place() publishes OrderPlaced, saw ${JSON.stringify(published)}`,
    );
    // Every consumer read a type out of a constructor; none was invented.
    assert.ok(published.every((e) => e.key === 'OrderPlaced'), 'no other type was claimed');
  });

  test('a listener with no publisher is still an endpoint, and no edge', () => {
    // OrderShipped is declared and never published here. Half a binding is
    // worth recording: in a service split across repositories that is the
    // normal case, and the missing half is information.
    const endpoints = endpointsOf('spring-event');
    assert.ok(endpoints.some((e) => e.key === 'OrderShipped' && e.role === 'provider'));
    assert.ok(!endpoints.some((e) => e.key === 'OrderShipped' && e.role === 'consumer'));
    assert.ok(!wiredBy('spring-event').some((w) => /onShipped/.test(w)));
  });

  test('a publish on a receiver that is not a publisher is left alone', () => {
    // `bus.publish(new OrderPlaced("x"))` -- `publish` is a common method name,
    // and claiming every one of them would fill the graph with events that
    // were never Spring's.
    const endpoints = endpointsOf('spring-event');
    assert.ok(!endpoints.some((e) => /unrelated/.test(e.fqn)), 'bus.publish is not Spring');
    // And a listener typed Object matches anything, so it matches nothing.
    assert.ok(!endpoints.some((e) => /onAnything/.test(e.fqn)), 'Object is not an event');
  });
});

describe('an event published with a nested constructor', () => {
  test('the event is the outer type, not the one inside it', () => {
    // publishEvent(new ApplicationFailedEvent(new SpringApplication(this), ...))
    // puts two constructors on one line. Keeping the last made SpringApplication
    // an event five times over in spring-boot; the outer one is the argument,
    // and the walk reaches it first.
    const endpoints = endpointsOf('spring-event').filter((e) => /#nested/.test(e.fqn));
    assert.equal(endpoints.length, 1, `saw ${JSON.stringify(endpoints)}`);
    assert.equal(endpoints[0].key, 'OrderPlaced', 'the outer constructor is the event');
    assert.ok(
      !endpointsOf('spring-event').some((e) => e.key === 'OrderId'),
      'the nested constructor is an argument, not an event',
    );
  });
});
