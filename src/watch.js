/**
 * Auto-sync: re-index shortly after files stop changing.
 *
 * A recursive fs.watch is asked for everywhere. This file used to say Linux
 * had none and polled there instead -- rehashing the whole tree every five
 * seconds -- which was true of Node 18 and has not been since 20; the floor
 * this package declares is 22. Polling stays as the fallback for a platform
 * that actually refuses the watch, which is now none of the three tested.
 */
import { watch, realpathSync } from 'node:fs';
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

  const isIgnored = buildIgnoreFilter(root);

  try {
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
  } catch (err) {
    // ERR_FEATURE_UNAVAILABLE_ON_PLATFORM is the one to expect; anything else
    // fs.watch throws here is equally a reason to fall back rather than die.
    process.stderr.write(`provenlens: recursive watch unavailable (${err.code ?? err.message}); polling\n`);
  }

  const interval = setInterval(() => schedule('poll'), POLL_MS);
  return { close: () => (clearTimeout(timer), clearInterval(interval)), mode: 'poll' };
}
