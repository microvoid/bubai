import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import {
  loadCliConfig, resolvePiModel,
  saveCliConfig,
  type CliId,
  type DirectCliAgentConfig,
  type PermissionMode,
} from './config';

type Flags = Record<string, string | boolean>;
const supported: CliId[] = ['claude', 'codex'];
export type RuntimeMode = 'botmux' | 'direct' | 'hybrid' | 'pi';

function installed(cli: CliId) {
  return (process.env.PATH || '').split(path.delimiter).some((dir) => {
    try {
      const file = path.join(dir, cli + (process.platform === 'win32' ? '.exe' : ''));
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

export function configuredAgents(selection?: string[]) {
  const agents = loadCliConfig().localAgents ?? [];
  return agents
    .filter((agent) => !selection || selection.includes(agent.externalId))
    .map((agent) => {
      const permissionMode = agent.permissionMode ?? 'workspace-write';
      if (!supported.includes(agent.cliId) || !installed(agent.cliId))
        throw new Error(`Install ${agent.cliId} or remove local agent ${agent.externalId}`);
      if (!['read-only', 'workspace-write', 'full-access'].includes(permissionMode))
        throw new Error(`Invalid permission mode for ${agent.name}`);
      if (!path.isAbsolute(agent.workingDir) || !fs.statSync(agent.workingDir).isDirectory())
        throw new Error(`Invalid working directory for ${agent.name}`);
      return { ...agent, permissionMode };
    });
}

export function configureAgents(flags: Flags) {
  const agents = loadCliConfig().localAgents ?? [];
  const workingDir = fs.realpathSync(path.resolve(String(flags.cwd ?? '.')));
  if (!fs.statSync(workingDir).isDirectory()) throw new Error('Expected a working directory');
  const permission = flags.permission;
  if (
    permission !== undefined &&
    !['workspace-write', 'read-only', 'full-access'].includes(String(permission))
  )
    throw new Error('Unknown permission mode');
  const selected: DirectCliAgentConfig[] = [];
  for (const item of new Set(String(flags.cli ?? '').split(','))) {
    const cliId = supported.find((id) => id === item.trim());
    if (!cliId || !installed(cliId))
      throw new Error(`Expected an installed claude or codex CLI, got "${item}"`);
    const existing = agents.find(
      (a) => a.cliId === cliId && a.workingDir === workingDir && (!flags.name || a.name === flags.name),
    );
    const agent: DirectCliAgentConfig = {
      externalId: existing?.externalId ?? `direct-${cliId}-${randomUUID()}`,
      cliId,
      workingDir,
      name: String(flags.name || existing?.name || `${cliId} (${os.hostname()})`),
      permissionMode: (permission || existing?.permissionMode || 'workspace-write') as PermissionMode,
    };
    if (existing) agents[agents.indexOf(existing)] = agent;
    else agents.push(agent);
    selected.push(agent);
  }
  saveCliConfig({ localAgents: agents });
  return selected;
}

export async function selectRuntime(flags: Flags, endpoint: string): Promise<{ mode: RuntimeMode; selectedAgents?: string[] }> {
  const mode = flags.mode ?? 'auto';
  if (mode === 'pi') { resolvePiModel(); return { mode }; }
  if (!['auto', 'direct', 'botmux'].includes(String(mode)))
    throw new Error('Expected --mode auto|direct|botmux|pi');
  if (mode === 'botmux' || (mode === 'auto' && flags.bots)) return { mode: 'botmux' };
  if (flags.cli) {
    return { mode: 'direct', selectedAgents: configureAgents(flags).map(agent => agent.externalId) };
  }
  const configured = loadCliConfig().localAgents?.length;
  if (mode === 'auto') {
    const reachable = await fetch(endpoint.replace(/\/+$/, '') + '/api/bots', {
      signal: AbortSignal.timeout(2000),
    })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) {
          await res.body?.cancel();
          return true;
        }
        return res.ok && Array.isArray((await res.json()).bots);
      })
      .catch(() => false);
    if (reachable) return { mode: configured ? 'hybrid' : 'botmux' };
  }
  if (!configured) {
    const available = supported.filter(installed);
    if (mode === 'auto' && loadCliConfig().piAgents?.length) { resolvePiModel(); return {mode:'pi'}; }
    if (!available.length && mode === 'auto') { resolvePiModel(); return { mode: 'pi' }; }
    if (!available.length)
      throw new Error(
        'No local runtime available. Start Botmux or install and sign in to Claude Code or Codex.',
      );
    if (!process.stdin.isTTY)
      throw new Error(`Choose a local CLI: bub start --cli ${available.join(',')} --cwd <directory>`);
    const tty = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const cli = (await tty.question(`Local CLI(s) [${available.join(',')}]: `)) || available.join(',');
      const cwd = (await tty.question(`Working directory [${process.cwd()}]: `)) || process.cwd();
      const name = await tty.question('Bot name [automatic]: ');
      const permission = await tty.question(
        'Permission: read-only / workspace-write / full-access [workspace-write]: ',
      );
      configureAgents({ cli, cwd, name, permission: permission || 'workspace-write' });
    } finally {
      tty.close();
    }
  }
  return { mode: 'direct' };
}
