/**
 * What `node --no-warnings` did, without needing a flag in the shebang.
 *
 * `node:sqlite` announces itself as experimental on every start, and the
 * only way to carry `--no-warnings` in a shebang is `#!/usr/bin/env -S`,
 * which needs coreutils 8.30: Ubuntu 18.04 and CentOS 7 have older ones and
 * fail with `env: 'node --no-warnings': No such file or directory` the first
 * time the symlink is used. So the entry points import this module FIRST --
 * ES modules evaluate their imports in order, and this runs before the module
 * that loads sqlite -- and the shebang is the plain `#!/usr/bin/env node`
 * that every machine understands.
 *
 * Node prints a warning through a default listener on the process 'warning'
 * event; removing the listeners removes the printing. Everything that is not
 * an ExperimentalWarning is still written out, so a deprecation or a leak
 * warning is not lost with it.
 */
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning') return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});
