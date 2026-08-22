import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { openDb } from '../src/db.js';
import { dbPathFor, discoverProjects } from '../src/project.js';
import { indexProject } from '../src/indexer.js';
import { startServer } from '../src/server.js';

/**
 * Three services that only ever meet through a queue name — the shape a
 * microservice codebase actually has, and the reason one index is not enough.
 */
const SERVICES = {
  'order-service/src/main/java/com/shop/OrderPublisher.java': [
    'package com.shop;',
    'import io.awspring.cloud.sqs.operations.SqsTemplate;',
    'public class OrderPublisher {',
    '  private final SqsTemplate sqsTemplate;',
    '  public OrderPublisher(SqsTemplate sqsTemplate) { this.sqsTemplate = sqsTemplate; }',
    '  public void publishOrder(String payload) { sqsTemplate.send("order-events", payload); }',
    '}',
  ].join('\n'),
  'notify-service/src/main/java/com/shop/OrderNotifier.java': [
    'package com.shop;',
    'import io.awspring.cloud.sqs.annotation.SqsListener;',
    'public class OrderNotifier {',
    '  @SqsListener("order-events")',
    '  public void onOrder(String payload) { sendEmail(payload); }',
    '  private void sendEmail(String payload) {}',
    '}',
  ].join('\n'),
  'audit-service/app/workers/order_audit_worker.rb': [
    'class OrderAuditWorker',
    '  include Shoryuken::Worker',
    "  shoryuken_options queue: 'order-events', auto_delete: true",
    '  def perform(sqs_msg, body)',
    '    record(body)',
    '  end',
    '  def record(body); body; end',
    'end',
  ].join('\n'),
};

let workspace;
let handle;

before(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'codelens-ws-'));
  for (const [path, content] of Object.entries(SERVICES)) {
    const full = join(workspace, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  for (const service of ['order-service', 'notify-service', 'audit-service']) {
    const root = join(workspace, service);
    const db = openDb(dbPathFor(root), { create: true });
    await indexProject(db, root, { full: true });
    db.close();
  }
  handle = await startServer([workspace], { port: 0 });
});

after(() => {
  handle?.close();
  rmSync(workspace, { recursive: true, force: true });
});

const get = (path) =>
  new Promise((done, fail) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: handle.server.address().port,
        path,
        headers: { 'x-codelens-token': handle.token },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => done({ status: res.statusCode, json: () => JSON.parse(body) }));
      },
    );
    req.on('error', fail);
    req.end();
  });

describe('discovery', () => {
  test('finds every indexed repository one level below a workspace', () => {
    const found = discoverProjects(workspace).map((p) => p.split('/').pop()).sort();
    assert.deepEqual(found, ['audit-service', 'notify-service', 'order-service']);
  });

  test('a path that is itself a repository resolves to just that one', () => {
    const found = discoverProjects(join(workspace, 'order-service'));
    assert.equal(found.length, 1);
    assert.ok(found[0].endsWith('order-service'));
  });
});

describe('scoping', () => {
  test('lists every repository with its own numbers', async () => {
    const repos = (await get('/api/repos')).json();
    assert.equal(repos.length, 3);
    assert.deepEqual(repos.map((r) => r.name).sort(), [
      'audit-service',
      'notify-service',
      'order-service',
    ]);
    assert.ok(repos.every((r) => r.symbols > 0));
  });

  test('searches across all repositories by default', async () => {
    const hits = (await get('/api/search?q=Order&limit=30')).json();
    const seen = new Set(hits.map((h) => h.repoName));
    assert.ok(seen.size > 1, `expected several repos, saw ${[...seen]}`);
  });

  test('narrows to one repository when asked', async () => {
    const repos = (await get('/api/repos')).json();
    const order = repos.find((r) => r.name === 'order-service');
    const hits = (await get(`/api/search?q=Order&limit=30&repo=${order.id}`)).json();
    assert.ok(hits.length > 0);
    assert.deepEqual([...new Set(hits.map((h) => h.repoName))], ['order-service']);
  });

  test('an unknown repository returns nothing rather than everything', async () => {
    assert.deepEqual((await get('/api/search?q=Order&repo=99')).json(), []);
  });
});

describe('the view you get before asking anything', () => {
  test('offers every repository and what is most central in each', async () => {
    // An empty canvas answers nothing about a codebase you have not seen.
    const landing = (await get('/api/landing?limit=5')).json();
    const repoNodes = landing.nodes.filter((n) => n.isRepo);
    assert.equal(repoNodes.length, 3);
    assert.deepEqual(repoNodes.map((n) => n.name).sort(), [
      'audit-service',
      'notify-service',
      'order-service',
    ]);
    assert.ok(landing.nodes.length > repoNodes.length, 'each repo should bring some content');
  });

  test('attaches the content to the repository it came from', async () => {
    const landing = (await get('/api/landing?limit=5')).json();
    for (const edge of landing.edges.filter((e) => e.kind === 'contains')) {
      const from = landing.nodes.find((n) => n.id === edge.from);
      const to = landing.nodes.find((n) => n.id === edge.to);
      assert.ok(from.isRepo, 'a contains edge starts at a repository');
      assert.equal(from.repo, to.repo, 'and stays inside it');
    }
  });

  test('narrows to one repository when scoped', async () => {
    const repos = (await get('/api/repos')).json();
    const order = repos.find((r) => r.name === 'order-service');
    const landing = (await get(`/api/landing?limit=5&repo=${order.id}`)).json();
    const repoNodes = landing.nodes.filter((n) => n.isRepo);
    assert.equal(repoNodes.length, 1);
    assert.equal(repoNodes[0].name, 'order-service');
  });

  test('shows the queue link between services without being asked', async () => {
    // The reason to open several repositories at once should be visible on
    // arrival, not only after a search.
    const landing = (await get('/api/landing?limit=10')).json();
    assert.ok(
      landing.edges.some((e) => e.crossRepo),
      'the producer/consumer link should be in the opening view',
    );
  });
});

describe('links that cross a repository boundary', () => {
  test('joins an SQS producer to the listener in another service', async () => {
    const hits = (await get('/api/search?q=publishOrder&limit=5')).json();
    const publisher = hits.find((h) => h.name === 'publishOrder');
    assert.ok(publisher, 'expected to find the publisher');

    const graph = (await get(`/api/graph?ids=${publisher.id}&depth=1`)).json();
    const crossing = graph.edges.filter((e) => e.crossRepo);
    assert.ok(crossing.length >= 2, 'both consumers should be reachable');

    const reached = crossing
      .map((e) => graph.nodes.find((n) => n.id === (e.from === publisher.id ? e.to : e.from)))
      .map((n) => n.repoName)
      .sort();
    assert.deepEqual(reached, ['audit-service', 'notify-service']);
  });

  test('crosses languages as well as repositories', async () => {
    // The Java publisher reaches a Ruby Shoryuken worker; nothing but the
    // queue name connects them.
    const hits = (await get('/api/search?q=publishOrder&limit=5')).json();
    const graph = (await get(`/api/graph?ids=${hits[0].id}&depth=1`)).json();
    const ruby = graph.nodes.find((n) => n.repoName === 'audit-service');
    assert.ok(ruby, 'the Ruby worker must appear in the graph');
    assert.equal(ruby.lang, 'ruby');
  });

  test('names the queue on the edge, so the link is explainable', async () => {
    const hits = (await get('/api/search?q=publishOrder&limit=5')).json();
    const graph = (await get(`/api/graph?ids=${hits[0].id}&depth=1`)).json();
    const edge = graph.edges.find((e) => e.crossRepo);
    assert.match(edge.label, /order-events/);
    assert.ok(edge.confidence < 1, 'a string match is not an observed call');
  });

  test('reports the other end in the detail payload too', async () => {
    const hits = (await get('/api/search?q=publishOrder&limit=5')).json();
    const detail = (await get(`/api/symbol?id=${hits[0].id}`)).json();
    assert.equal(detail.crossRepo.length, 2);
    assert.deepEqual(detail.crossRepo.map((c) => c.repoName).sort(), [
      'audit-service',
      'notify-service',
    ]);
  });

  test('keeps ids unambiguous once several indexes are open', async () => {
    const hits = (await get('/api/search?q=Order&limit=30')).json();
    const ids = hits.map((h) => h.id);
    assert.equal(new Set(ids).size, ids.length, 'composite ids must not collide');
    assert.ok(ids.every((id) => /^\d+:\d+$/.test(id)));
  });
});
