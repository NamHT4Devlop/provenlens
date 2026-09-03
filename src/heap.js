import { totalmem } from 'node:os';
import { spawnSync } from 'node:child_process';

/** Below this there is nothing to gain: V8 already defaults near it. */
const MIN_MB = 4096;
/** Above this the win is theoretical and the swapping is not. */
const MAX_MB = 16384;
const GUARD = 'CODELENS_HEAP_SET';
/** The commands that hold a whole project in memory. */
const INDEXING = new Set(['init', 'index', 'sync']);
/** Enough of them to keep the shell's 128+n convention meaningful. */
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGABRT: 6, SIGALRM: 14 };

/**
 * Re-runs this process with a heap proportional to the machine.
 *
 * V8 caps its old space near 4 GB on 64-bit regardless of how much memory the
 * machine has, and the resolver is deliberately an in-memory algorithm: every
 * ref must be resident, because a chained call is answered by looking up the
 * ref its receiver came from. 31,023 Ruby files in google-cloud-ruby need 7.3
 * GB and died at the cap -- as a V8 stack trace thirty frames deep, which says
 * nothing a reader could act on.
 *
 * Half of physical memory, so the rest of the machine keeps working. Skipped
 * when the caller has already chosen a limit, and skipped silently if the
 * re-exec cannot be done, since a smaller heap still indexes most projects.
 */
export function ensureHeadroom(argv = process.argv) {
  if (process.env[GUARD]) return false;
  // Only the commands that build an index need the room, and only they can
  // afford the re-exec. `mcp` is a server: re-running it would leave the outer
  // process blocked on a child that never exits, which is how the test suite
  // caught this. Every other command reads a database that is already built.
  if (!INDEXING.has(argv[2])) return false;
  const chosen = [...process.execArgv, process.env.NODE_OPTIONS ?? ''].join(' ');
  if (chosen.includes('max-old-space-size')) return false;

  const want = Math.min(MAX_MB, Math.floor(totalmem() / 1024 / 1024 / 2));
  if (want <= MIN_MB) return false;

  const res = spawnSync(
    process.execPath,
    ['--no-warnings', `--max-old-space-size=${want}`, ...argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, [GUARD]: String(want) } },
  );
  // A child killed by a signal reports a null status, and exiting 0 on that
  // would tell every caller the run succeeded. The shell's convention for a
  // signal is 128 + n, and the harness that found this bug reads exit codes.
  if (res.signal) process.exit(128 + (SIGNALS[res.signal] ?? 0));
  process.exit(res.status ?? 1);
}
