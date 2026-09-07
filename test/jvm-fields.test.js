/**
 * Two things javap knows that the index did not read.
 *
 * A static field is a hop in a receiver chain: `System.out.println` steps from
 * a class through a field to another class, and without the field it stopped
 * at `out` as "complex". And a java.lang name the project also uses as a type
 * was asked for twice, printed twice, and the second copy threw on the UNIQUE
 * path column -- silently, taking every class after it with it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from '../src/db.js';
import { indexProject } from '../src/indexer.js';
import { readSignatures, unresolvedImports } from '../src/jvm.js';

const hasJavap = (() => {
  try {
    execFileSync('javap', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const write = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

describe('javap fields', () => {
  test('a static field is read with its type', () => {
    const run = () =>
      [
        'Compiled from "System.java"',
        'public final class java.lang.System {',
        '  public static final java.io.InputStream in;',
        '  public static final java.io.PrintStream out;',
        '  public static void setOut(java.io.PrintStream);',
        '  public static java.lang.String getProperty(java.lang.String);',
        '  static {};',
        '}',
      ].join('\n');
    const [system] = readSignatures(['java.lang.System'], '', { run });
    assert.deepEqual(
      system.fields,
      [
        { name: 'in', type: 'java.io.InputStream' },
        { name: 'out', type: 'java.io.PrintStream' },
      ],
    );
    assert.deepEqual(system.members.map((m) => m.name), ['setOut', 'getProperty']);
  });

  test('a name is asked for once, however many lists it is on', async () => {
    const root = mkdtempSync(join(tmpdir(), 'provenlens-jvm-'));
    const db = openDb(join(root, 'index.db'), { create: true });
    try {
      // `String` and `Thread` are declared local types AND on the java.lang
      // list: each used to be asked for twice.
      write(root, 'Main.java', [
        'package p;',
        'public class Main {',
        '  public static void main(String[] args) {',
        '    String s = "x";',
        '    Thread t = Thread.currentThread();',
        '    System.out.println(s + t.getName());',
        '  }',
        '}',
      ].join('\n'));
      await indexProject(db, root, { full: true });
      const asked = unresolvedImports(db);
      assert.equal(new Set(asked).size, asked.length, 'no name is asked for twice');
      assert.ok(asked.includes('java.lang.System'));

      if (!hasJavap) return;
      // The classes after the former duplicate are present, and the field is
      // a typed symbol the receiver chain can step through.
      const jvm = db.prepare("SELECT path FROM files WHERE path LIKE 'jvm:java.lang.%'").all().map((r) => r.path);
      assert.ok(jvm.includes('jvm:java.lang.System'), `System is indexed: ${jvm.join(' ')}`);
      assert.ok(jvm.includes('jvm:java.lang.Math'));
      const out = db.prepare("SELECT type_name FROM symbols WHERE fqn = 'java.lang.System#out'").get();
      assert.equal(out?.type_name, 'java.io.PrintStream');
      const println = db
        .prepare(
          `SELECT u.external, u.owner FROM unresolved u JOIN refs r ON r.id = u.ref_id
            WHERE r.name = 'println'`,
        )
        .get();
      assert.equal(println.external, 1, 'println is a library call, not a miss');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
