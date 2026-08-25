/**
 * Registers the MCP server with agents that read a JSON config.
 *
 * Every write is shown before it happens and the previous file is kept as
 * .bak -- this edits config the user owns, so it should never be a surprise.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = resolve(fileURLToPath(import.meta.url), '..', '..', 'bin', 'codelens.js');

export const TARGETS = {
  'claude-user': {
    label: 'Claude Code (user scope)',
    file: join(homedir(), '.claude.json'),
    key: 'mcpServers',
  },
  'claude-project': {
    label: 'Claude Code (this project)',
    file: join(process.cwd(), '.mcp.json'),
    key: 'mcpServers',
  },
  cursor: {
    label: 'Cursor',
    file: join(homedir(), '.cursor', 'mcp.json'),
    key: 'mcpServers',
  },
};

export function serverEntry() {
  // The bin has a `#!/usr/bin/env -S node` shebang and the executable bit, so it can be the
  // command itself. Writing process.execPath instead pinned the exact interpreter that happened
  // to be running the install -- under nvm that is a version-stamped path like
  // .../versions/node/v24.13.0/bin/node -- and the server then died the next time the user
  // switched Node versions, in a config file nobody would think to look at. The README already
  // gives this same warning about `npm link` for the CLI; the installer was doing it to itself.
  return { command: BIN, args: ['mcp'] };
}

function readJson(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}). Fix or move it, then retry.`);
  }
}

/**
 * @returns {{target: string, file: string, action: 'create'|'update'|'unchanged'}}
 */
export function planInstall(targetName) {
  const target = TARGETS[targetName];
  if (!target) throw new Error(`unknown target: ${targetName}`);

  const config = readJson(target.file);
  const existing = config[target.key]?.codelens;
  const wanted = serverEntry();
  const same = JSON.stringify(existing) === JSON.stringify(wanted);

  return {
    target: targetName,
    label: target.label,
    file: target.file,
    action: !existsSync(target.file) ? 'create' : same ? 'unchanged' : 'update',
    entry: wanted,
  };
}

export function applyInstall(targetName) {
  const target = TARGETS[targetName];
  const plan = planInstall(targetName);
  if (plan.action === 'unchanged') return plan;

  const config = readJson(target.file);
  config[target.key] ??= {};
  config[target.key].codelens = serverEntry();

  mkdirSync(dirname(target.file), { recursive: true });
  if (existsSync(target.file)) copyFileSync(target.file, `${target.file}.bak`);
  writeFileSync(target.file, `${JSON.stringify(config, null, 2)}\n`);
  return plan;
}

/**
 * Targets to configure when none is named: only agents whose config file is
 * already there.
 *
 * A project-scoped target is deliberately never auto-detected. Its path is
 * whatever directory the command runs in, so detecting it would drop a .mcp.json
 * into an unrelated repository. Ask for it by name to get it.
 */
export function detectTargets() {
  return Object.entries(TARGETS)
    .filter(([name, t]) => !name.endsWith('-project') && existsSync(t.file))
    .map(([name]) => name);
}
