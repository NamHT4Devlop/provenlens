import { test, before, after, describe } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { request } from 'node:http';
import { openDb } from '../src/db.js';
import { dbPathFor, discoverProjects } from '../src/project.js';
import { indexProject } from '../src/indexer.js';
import { startServer } from '../src/server.js';

const HERE2 = dirname(fileURLToPath(import.meta.url));

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
  // The server persists its UI token, so keep that inside the workspace rather
  // than writing into the state directory the real UI reads.
  workspace = mkdtempSync(join(tmpdir(), 'provenlens-ws-'));
  process.env.XDG_STATE_HOME = join(workspace, '.state');
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
  delete process.env.XDG_STATE_HOME;
});

const get = (path) =>
  new Promise((done, fail) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: handle.server.address().port,
        path,
        headers: { 'x-provenlens-token': handle.token },
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
    // basename, not a split on '/': discoverProjects returns native paths, and
    // on Windows every one of them came back whole because the separator is \.
    const found = discoverProjects(workspace).map((p) => basename(p)).sort();
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

describe('a path across the repository boundary', () => {
  test('walks from the publisher to the worker through the queue', async () => {
    const res = await get('/api/path?from=OrderPublisher%23publishOrder&to=OrderAuditWorker%23record');
    assert.equal(res.status, 200);
    const g = res.json();
    assert.equal(g.found, true, 'the queue is the bridge, and it exists');

    const cross = g.edges.find((e) => e.crossRepo);
    assert.ok(cross, 'one hop must be the cross-repo binding');
    assert.match(cross.label, /order-events/);

    // The chain starts where asked, ends where asked, and stays connected.
    assert.match(g.nodes[0].fqn, /publishOrder/);
    assert.match(g.nodes.at(-1).fqn ?? g.nodes.at(-1).name, /record/);
    for (const e of g.edges) {
      assert.ok(g.nodes.some((n) => n.id === e.from), `dangling from ${e.from}`);
      assert.ok(g.nodes.some((n) => n.id === e.to), `dangling to ${e.to}`);
    }
  });

  test('reports not-found rather than inventing a bridge that is not there', async () => {
    // Nothing links the notifier back to the publisher in that direction.
    const res = await get('/api/path?from=OrderNotifier%23sendEmail&to=OrderPublisher%23publishOrder');
    assert.equal(res.status, 200);
    assert.equal(res.json().found, false);
  });

  test('an unknown endpoint answers 404, not an empty chain', async () => {
    assert.equal((await get('/api/path?from=NoSuchThing&to=OrderPublisher')).status, 404);
  });
});

describe('the same workspace through the CLI', () => {
  const CLI = join(HERE2, '..', 'bin', 'provenlens.js');

  const run = (args, cwd = workspace) =>
    new Promise((done) => {
      const child = spawn(process.execPath, ['--no-warnings', CLI, ...args], { cwd });
      let out = '';
      let errOut = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (errOut += c));
      child.on('close', (code) => done({ code, out, errOut }));
    });

  test('query searches every repository and says which one answered', async () => {
    const r = await run(['query', 'publishOrder']);
    assert.equal(r.code, 0, r.errOut);
    assert.match(r.out, /order-service · /);
  });

  test('status reports each repository under its own heading', async () => {
    const r = await run(['status']);
    assert.equal(r.code, 0, r.errOut);
    for (const name of ['order-service', 'notify-service', 'audit-service']) {
      assert.match(r.out, new RegExp(`# repository: ${name}`));
    }
  });

  test('path crosses repositories through the queue binding', async () => {
    const r = await run(['path', 'publishOrder', 'OrderAuditWorker#record']);
    assert.equal(r.code, 0, r.errOut);
    assert.match(r.out, /sqs: order-events/);
    assert.match(r.out, /crosses into audit-service/);
    assert.match(r.out, /across two repositories/);
  });

  test('impact finds the symbol in whichever repository holds it', async () => {
    const r = await run(['impact', 'OrderAuditWorker#record']);
    assert.equal(r.code, 0, r.errOut);
    assert.match(r.out, /perform/);
  });
});

describe('the same workspace through MCP', () => {
  test('provenlens_status covers every repository in one call', async () => {
    const CLI = join(HERE2, '..', 'bin', 'provenlens.js');
    const child = spawn(process.execPath, ['--no-warnings', CLI, 'mcp', workspace]);
    const replies = [];
    let buffer = '';
    child.stdout.on('data', (c) => {
      buffer += c;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) replies.push(JSON.parse(line));
      }
    });

    const ask = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
    ask({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    ask({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'provenlens_status', arguments: {} } });

    const until = async (pred, ms = 15000) => {
      const start = Date.now();
      while (!pred()) {
        if (Date.now() - start > ms) throw new Error('timed out waiting for MCP reply');
        await new Promise((s) => setTimeout(s, 50));
      }
    };
    try {
      await until(() => replies.some((r) => r.id === 2));
      const status = replies.find((r) => r.id === 2);
      const text = status.result.content[0].text;
      for (const name of ['order-service', 'notify-service', 'audit-service']) {
        assert.match(text, new RegExp(name));
      }
    } finally {
      // Waiting for the exit, not just asking for it. kill() only sends the
      // signal, and the child still holds a handle on every index in the
      // workspace until it is gone -- which on Windows is why the directory
      // could not be removed afterwards and the whole file failed in teardown,
      // with no individual test to point at.
      const gone = new Promise((done) => child.once('exit', done));
      child.kill();
      await gone;
    }
  });
});
