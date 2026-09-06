/**
 * The binding defects a full review found, each pinned by the probe that
 * found it: a Spring prefix never applied, a verb read as a string it never
 * was, a Kafka send wired to an SQS listener, a statement inside an XML
 * comment, a schema description read as a field, a service cut off at its
 * first option body, a routes.rb read without its nesting.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from './helpers.js';
import { railsRoutes } from '../src/bindings/http.js';
import { projectStats } from '../src/query.js';

let db;
let stats;

before(async () => {
  const built = await buildIndex('bindings2');
  db = built.db;
  stats = built.stats;
});

const keys = (plugin, role) =>
  db
    .prepare('SELECT DISTINCT key FROM bindings WHERE plugin = ? AND role = ? ORDER BY key')
    .all(plugin, role)
    .map((r) => r.key);

const wired = (plugin, fromFqn) =>
  db
    .prepare(
      `SELECT t.fqn FROM edges e JOIN symbols s ON s.id = e.from_symbol_id
         JOIN symbols t ON t.id = e.to_symbol_id
        WHERE e.via = ? AND s.fqn = ? ORDER BY t.fqn`,
    )
    .all(`binding:${plugin}`, fromFqn)
    .map((r) => r.fqn);

describe('Spring routes carry the class prefix and read their attributes by name', () => {
  test('every route is keyed under the class-level @RequestMapping', () => {
    const provided = keys('http', 'provider');
    for (const key of [
      'GET /api/orders/{}',
      'POST /api/orders',
      'POST /api/orders/bulk',
      'GET /api/orders/list',
      'GET /api/orders/a',
      'GET /api/orders/b',
    ]) {
      assert.ok(provided.includes(key), `expected ${key}, got ${provided}`);
    }
    // The shapes the bugs produced: a route without its prefix, a verb the
    // enum never became, a `produces` value served as a path.
    assert.ok(!provided.includes('GET /{}'), 'the prefix must be applied');
    // `ANY /api/orders/bulk` also exists, on purpose: every handler answers
    // under ANY for a caller whose verb could not be read. `ANY /bulk` -- the
    // unprefixed key the bug produced -- must not.
    assert.ok(!provided.includes('ANY /bulk'), 'method = POST is a verb, under the prefix');
    assert.ok(!provided.includes('GET /application/json'), 'produces is not a path');
  });

  test('the clients are wired to the handlers', () => {
    assert.deepEqual(wired('http', 'com.p.OrderClient#a'), ['com.p.OrderController#get']);
    assert.deepEqual(wired('http', 'com.p.OrderClient#b'), ['com.p.OrderController#bulk']);
    assert.deepEqual(wired('http', 'com.p.OrderClient#c'), ['com.p.OrderController#list']);
    assert.ok(stats.bindings.http.wired >= 3, `expected wired routes, got ${JSON.stringify(stats.bindings.http)}`);
  });

  test('a Map.put with a slash in it is not a request', () => {
    assert.deepEqual(wired('http', 'com.p.OrderClient#mapPut'), []);
  });

  test('this.http.get is a client; api.get with options is not a route', () => {
    assert.deepEqual(wired('http', 'src/client/api:OrdersService#list'), ['com.p.OrderController#get']);
    const provided = keys('http', 'provider');
    assert.ok(!provided.includes('GET /items'), `an axios call served nothing, got ${provided}`);
  });
});

describe('SQS wires only what talks to a queue', () => {
  test('a Kafka send is not an SQS producer, and a factory is not a queue', () => {
    assert.deepEqual(wired('sqs', 'com.p.Producer#a'), []);
    assert.deepEqual(keys('sqs', 'provider'), ['orders']);
    assert.deepEqual(wired('sqs', 'com.p.SqsBits#enqueue'), ['com.p.SqsBits#onOrder']);
  });
});

describe('MyBatis reads what MyBatis reads', () => {
  test('a statement inside an XML comment does not exist', () => {
    const statements = db
      .prepare("SELECT fqn FROM symbols WHERE kind = 'sql-statement' ORDER BY fqn")
      .all()
      .map((r) => r.fqn);
    assert.deepEqual(statements, ['sql:com.p.UserDao#findById']);
  });
});

describe('Flyway reads a quoted, schema-qualified table', () => {
  test('"public"."comments" names comments', () => {
    assert.ok(keys('flyway', 'provider').includes('table:comments'));
    const touched = db
      .prepare(
        `SELECT s.fqn FROM edges e JOIN symbols s ON s.id = e.from_symbol_id
          WHERE e.via = 'binding:flyway' ORDER BY s.fqn`,
      )
      .all()
      .map((r) => r.fqn);
    assert.ok(touched.includes('com.p.Comment'), `expected the Comment class wired, got ${touched}`);
  });
});

describe('GraphQL reads the schema as a schema', () => {
  test('descriptions and multi-line argument lists are not fields', () => {
    const asked = keys('graphql', 'consumer');
    assert.deepEqual(asked, ['Customer.id', 'Order.customer', 'Order.id', 'Query.orderById', 'Query.orders']);
  });

  test('an annotation before @QueryMapping does not hide its override', () => {
    const provided = keys('graphql', 'provider');
    assert.ok(provided.includes('Query.orderById'), `got ${provided}`);
    assert.ok(!provided.includes('Query.byId'));
    assert.ok(provided.includes('Order.customer'), 'field= and typeName= are read by name');
    assert.ok(!provided.includes('customer.Order'));
  });
});

describe('gRPC reads a service to its closing brace', () => {
  test('rpcs after an option body still exist', () => {
    const rpcs = db
      .prepare("SELECT fqn FROM symbols WHERE kind = 'rpc-method' ORDER BY fqn")
      .all()
      .map((r) => r.fqn);
    assert.deepEqual(rpcs, ['rpc:OrderService/CancelOrder', 'rpc:OrderService/GetOrder', 'rpc:OrderService/ListOrders']);
  });

  test('an imported ImplBase still names its service', () => {
    const provided = keys('grpc', 'provider');
    assert.deepEqual(provided, ['OrderService/CancelOrder', 'OrderService/GetOrder', 'OrderService/ListOrders']);
  });
});

describe('Kafka reads the whole annotation', () => {
  test('topics on a later line, and an array spanning lines', () => {
    const provided = keys('kafka', 'provider');
    for (const t of ['late-topic', 'multi-a', 'multi-b', 'multi-c']) {
      assert.ok(provided.includes(t), `expected ${t}, got ${provided}`);
    }
    assert.ok(!provided.includes('late') && !provided.includes('factory'), 'a group id is not a topic');
  });
});

describe('Rails routes are read as the DSL nests', () => {
  test('namespace, only:, member and to: all land on the action', () => {
    const rows = db
      .prepare(
        `SELECT b.key, s.fqn FROM bindings b LEFT JOIN symbols s ON s.id = b.symbol_id
          WHERE b.plugin = 'http' AND b.role = 'provider' AND b.detail LIKE '%Controller%' ORDER BY b.key`,
      )
      .all();
    const byKey = new Map(rows.map((r) => [r.key, r.fqn]));
    assert.equal(byKey.get('GET /api/things/{}'), 'Api::ThingsController#show');
    assert.equal(byKey.get('POST /api/things/{}/archive'), 'Api::ThingsController#archive');
    assert.equal(byKey.get('POST /api/things/{}/restore'), 'Api::ThingsController#restore');
    // only: [:show] -- no index, create, update or destroy.
    assert.ok(!byKey.has('GET /api/things'), `index was excluded by only:, got ${[...byKey.keys()]}`);
    assert.ok(!byKey.has('POST /api/things'));
    assert.ok(!byKey.has('DELETE /api/things/{}'));
    // scope with a path and a module; a legacy arrow; root.
    assert.ok(byKey.has('GET /v1/status'));
    assert.ok(byKey.has('GET /legacy'));
    assert.ok(byKey.has('GET /'));
  });

  test('the parser itself, on the shapes that matter', () => {
    const routes = railsRoutes(
      [
        'Rails.application.routes.draw do',
        '  resources :users, except: [:destroy] do',
        '    resources :comments, only: %i[index create]',
        '    collection do',
        '      get :search',
        '    end',
        '  end',
        '  resource :profile, only: [:show]',
        "  match 'ping', to: 'health#ping', via: [:get, :post]",
        'end',
      ].join('\n'),
    );
    const as = routes.map((r) => `${r.verb} ${r.path} -> ${r.controller}#${r.action}`);
    assert.ok(as.includes('GET /users/{}/comments -> Comments#index'));
    assert.ok(as.includes('POST /users/{}/comments -> Comments#create'));
    assert.ok(!as.some((r) => r.startsWith('DELETE /users/{} ')));
    assert.ok(as.includes('GET /users/search -> Users#search'), `collection route, got ${as}`);
    assert.ok(as.includes('GET /profile -> Profiles#show'));
    assert.ok(as.includes('GET /ping -> Health#ping') && as.includes('POST /ping -> Health#ping'));
  });
});

describe('an annotation is not a call', () => {
  test('projectStats counts call sites, and the route annotations are not among them', () => {
    const calls = db.prepare("SELECT COUNT(*) AS n FROM refs WHERE kind != 'annotation'").get().n;
    const annotations = db.prepare("SELECT COUNT(*) AS n FROM refs WHERE kind = 'annotation'").get().n;
    assert.ok(annotations > 0, 'the fixture is full of annotations');
    assert.equal(projectStats(db).refs, calls);
  });
});
