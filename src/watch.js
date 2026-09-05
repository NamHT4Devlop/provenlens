/**
 * Auto-sync: re-index shortly after files stop changing.
 *
 * fs.watch is recursive on macOS and Windows; on Linux it is not, so the
 * fallback there is a periodic sync rather than pretending to watch.
 */
import { watch, realpathSync } from 'node:fs';
import { platform } from 'node:os';
import { langForPath } from './lang.js';
import { indexProject } from './indexer.js';
import { buildIgnoreFilter } from './project.js';

const DEBOUNCE_MS = 400;
const POLL_MS = 5000;

export function watchProject(db, root, { onSync } = {}) {
  let timer = null;
  let running = false;
  let pending = false;

  async function sync(reason) {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      const stats = await indexProject(db, root, { full: false });
      if (stats.parsed || stats.removed) onSync?.(stats, reason);
    } catch (err) {
      process.stderr.write(`provenlens: sync failed: ${err.message}\n`);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule('queued change');
      }
    }
  }

  function schedule(reason) {
    clearTimeout(timer);
    timer = setTimeout(() => sync(reason), DEBOUNCE_MS);
  }

  const recursive = platform() === 'darwin' || platform() === 'win32';
  const isIgnored = buildIgnoreFilter(root);

  if (recursive) {
    // fs.watch keeps the path it was handed and compares it against the one
    // Windows reports for every event. Hand it a path holding an 8.3 short
    // name -- `C:\Users\RUNNER~1\AppData\Local\Temp\...`, which is what
    // os.tmpdir() gives on a GitHub runner and what any account with a long
    // name gives -- and the two never match. libuv does not report that as an
    // error a caller could catch: it aborts the process on
    // `!_wcsnicmp(filename, dir, dirlen)` in src/win/fs-event.c, taking the
    // whole run with it. realpath resolves the short form away.
    //
    // Only the watcher gets the resolved path. Everything else keeps the root
    // it was given, because the paths in the index are relative to that one.
    let watched = root;
    try {
      watched = realpathSync.native(root);
    } catch {
      /* an unresolvable root is one fs.watch is about to refuse anyway */
    }
    const watcher = watch(watched, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = String(filename).split('\\').join('/');
      if (isIgnored(rel)) return;
      if (!langForPath(rel)) return;
      schedule(rel);
    });
    return { close: () => (clearTimeout(timer), watcher.close()), mode: 'watch' };
  }

  const interval = setInterval(() => schedule('poll'), POLL_MS);
  return { close: () => (clearTimeout(timer), clearInterval(interval)), mode: 'poll' };
}
