import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, statSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { startServer, tokenFile } from '../src/server.js';
import { openDb } from '../src/db.js';
import { dbPathFor } from '../src/project.js';
import { indexProject } from '../src/indexer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', '__fixtures__', 'java');

let handle;
let stateDir;

before(async () => {
  // The token now persists to disk, so the tests get their own state directory
  // rather than reading -- or worse, replacing -- the one the real UI uses.
  stateDir = mkdtempSync(join(tmpdir(), 'codelens-state-'));
  process.env.XDG_STATE_HOME = stateDir;

  // Self-contained: the server needs an index, so build one rather than
  // depending on whatever happens to be on disk.
  const db = openDb(dbPathFor(FIXTURE), { create: true });
  await indexProject(db, FIXTURE, { full: true });
  db.close();

  handle = await startServer(FIXTURE, { port: 0 });
});

after(() => {
  handle?.close();
  rmSync(stateDir, { recursive: true, force: true });
  delete process.env.XDG_STATE_HOME;
  for (const s of ['', '-wal', '-shm']) {
    rmSync(join(FIXTURE, '.codelens', `index.db${s}`), { force: true });
  }
});

/**
 * Raw http.request rather than fetch: Host is a forbidden header for fetch, so
 * fetch silently rewrites it and the rebinding case could never be exercised.
 */
function ask(path, { token = handle.token, host } = {}) {
  return new Promise((done, fail) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: handle.server.address().port,
        path,
        headers: {
          ...(token ? { 'x-codelens-token': token } : {}),
          ...(host ? { Host: host } : {}),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () =>
          done({
            status: res.statusCode,
            headers: res.headers,
            text: async () => body,
            json: async () => JSON.parse(body),
          }),
        );
      },
    );
    req.on('error', fail);
    req.end();
  });
}

describe('the server answers only to loopback', () => {
  test('rejects a request whose Host is some other name', async () => {
    // DNS rebinding: evil.com resolves to 127.0.0.1, so the browser treats the
    // page as same-origin and would let it read the API. The Host header is
    // what still names the real origin.
    const res = await ask('/api/overview', { host: 'evil.example.com' });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /localhost/);
  });

  test('accepts localhost and 127.0.0.1 alike', async () => {
    for (const host of ['127.0.0.1', 'localhost', `127.0.0.1:${handle.server.address().port}`]) {
      assert.equal((await ask('/api/overview', { host })).status, 200, host);
    }
  });
});

describe('the API is gated by the startup token', () => {
  test('refuses a request that presents no token', async () => {
    assert.equal((await ask('/api/overview', { token: null })).status, 403);
  });

  test('refuses a wrong token of the same length', async () => {
    const wrong = 'f'.repeat(handle.token.length);
    assert.notEqual(wrong, handle.token);
    assert.equal((await ask('/api/overview', { token: wrong })).status, 403);
  });

  test('accepts the token in a query parameter too', async () => {
    const res = await ask(`/api/overview?token=${handle.token}`, { token: null });
    assert.equal(res.status, 200);
  });

  test('gates every data route, not only the first', async () => {
    for (const path of ['/api/overview', '/api/search?q=x', '/api/symbol?id=1', '/api/graph?ids=1']) {
      assert.equal((await ask(path, { token: null })).status, 403, path);
    }
  });

  test('serves the shell without a token, so the address can be bookmarked', async () => {
    const res = await ask('/', { token: null });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
  });

  test('the shell it serves carries no token and no data', async () => {
    const html = await (await ask('/', { token: null })).text();
    assert.ok(!html.includes(handle.token), 'the page must not embed the token');
    assert.ok(!html.includes('__CODELENS_TOKEN__'), 'no placeholder should survive');
    // A fixture symbol name would be the giveaway that data leaked into it.
    assert.ok(!html.includes('OrderService'), 'the shell must hold no repository data');
  });
});

describe('the token survives a restart', () => {
  test('is stored under the state directory, readable only by its owner', () => {
    const file = tokenFile();
    assert.ok(file.startsWith(stateDir), 'the test must not touch the real token file');
    assert.equal(readFileSync(file, 'utf8').trim(), handle.token);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  test('a second server reuses it, so a bookmarked URL keeps working', async () => {
    const second = await startServer(FIXTURE, { port: 0 });
    try {
      assert.equal(second.token, handle.token);
    } finally {
      second.close();
    }
  });

  test('--new-token retires the old one, which then stops being accepted', async () => {
    const previous = handle.token;
    const rotated = await startServer(FIXTURE, { port: 0, newToken: true });
    try {
      assert.notEqual(rotated.token, previous);
      assert.equal(readFileSync(tokenFile(), 'utf8').trim(), rotated.token);

      const refused = await new Promise((done, fail) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: rotated.server.address().port,
            path: '/api/overview',
            headers: { 'x-codelens-token': previous },
          },
          (res) => done(res.statusCode),
        );
        req.on('error', fail);
        req.end();
      });
      assert.equal(refused, 403);
    } finally {
      rotated.close();
    }
  });
});

describe('responses are hardened', () => {
  test('the page asks for its token by header, not from an injected constant', async () => {
    const html = await (await ask('/')).text();
    assert.match(html, /x-codelens-token/, 'fetches must present the token as a header');
    assert.match(html, /localStorage/, 'the token must be kept for the next visit');
  });

  test('sets the headers that stop framing and sniffing', async () => {
    const res = await ask('/api/overview');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
  });

  test('sends no CORS header, so a cross-origin page cannot read a response', async () => {
    const res = await ask('/api/overview');
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });
});

describe('the API stays read-only and bounded', () => {
  test('answers real data once authorised', async () => {
    const overview = await (await ask('/api/overview')).json();
    assert.ok(overview.symbols > 0);
    assert.equal(overview.repos.length, 1);
    assert.ok(overview.repos[0].root.endsWith('java'));
  });

  test('addresses a symbol by repository and id together', async () => {
    // Each index numbers its symbols from one, so an id alone is ambiguous
    // the moment a second repository is open.
    const hits = await (await ask('/api/search?q=Donation&limit=1')).json();
    assert.match(hits[0].id, /^\d+:\d+$/);
    assert.equal(hits[0].repo, 0);
    assert.equal((await ask(`/api/symbol?id=${hits[0].id}`)).status, 200);
    assert.equal((await ask('/api/symbol?id=99:1')).status, 404);
  });

  test('caps how much one request can pull', async () => {
    const many = await (await ask('/api/search?q=e&limit=9999')).json();
    assert.ok(many.length <= 200, 'search is capped');
    const graph = await (await ask('/api/graph?ids=1&depth=99&max=9999')).json();
    assert.ok(graph.nodes.length <= 400, 'graph is capped');
  });

  test('treats an unknown path as not found rather than guessing', async () => {
    assert.equal((await ask('/api/../etc/passwd')).status, 404);
    assert.equal((await ask('/nope')).status, 404);
  });
});
