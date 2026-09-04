/**
 * Auto-sync: re-index shortly after files stop changing.
 *
 * fs.watch is recursive on macOS and Windows; on Linux it is not, so the
 * fallback there is a periodic sync rather than pretending to watch.
 */
import { watch } from 'node:fs';
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
    const watcher = watch(root, { recursive: true }, (_event, filename) => {
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
