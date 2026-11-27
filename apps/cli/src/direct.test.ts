import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveCliConfig, loadCliConfig } from './config';
import { openSessions } from './direct-sessions';
import { claude } from './direct-adapters/claude';
import { codex } from './direct-adapters/codex';

test('old profiles keep login and new agents and bindings survive reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-config-'));
  try {
    saveCliConfig({ token: 'fixture' }, dir);
    expect(loadCliConfig(dir).localAgents).toBeUndefined();
    saveCliConfig(
      {
        localAgents: [
          {
            cliId: 'codex',
            externalId: 'stable',
            name: 'Dev',
            workingDir: dir,
            permissionMode: 'workspace-write',
          },
        ],
      },
      dir,
    );
    expect(loadCliConfig(dir).token).toBe('fixture');
    expect(loadCliConfig(dir).localAgents?.[0].externalId).toBe('stable');
    const sessions = openSessions(dir);
    sessions.set('thread-one', 'one');
    sessions.set('thread-two', 'two');
    expect(openSessions(dir).get('thread-one')).toBe('one');
    sessions.set('thread-one');
    expect(openSessions(dir).get('thread-one')).toBeUndefined();
    expect(openSessions(dir).get('thread-two')).toBe('two');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resume retains chosen permission settings and reads prompt from stdin', () => {
  expect(codex.args('workspace-write', 'abc')).toContain('workspace-write');
  expect(codex.args('read-only', 'abc')).toContain('read-only');
  expect(claude.args('workspace-write', 'abc')).toContain('acceptEdits');
  expect(claude.args('read-only', 'abc')).toContain('Read,Glob,Grep');
});

test('the adapter streams native events, resumes a session and reports a CLI exit error', async () => {
  const { executeCli } = await import('./direct-adapters');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-cli-test-'));
  const originalPath = process.env.PATH;
  try {
    fs.writeFileSync(
      path.join(dir, 'codex'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const prompt = fs.readFileSync(0, 'utf8');
if (prompt === 'fail') { console.error('sign in first'); process.exit(7); }
console.log(JSON.stringify({type:'thread.started', thread_id:'unit-session'}));
console.log(JSON.stringify({type:'item.started',item:{id:'cmd',type:'command_execution',command:'pwd'}}));
const resumed = process.argv.includes('unit-session');
console.log(JSON.stringify({type:'item.completed',item:{id:'msg',type:'agent_message',text:resumed ? 'continued' : 'first'}}));
`,
      { mode: 0o700 },
    );
    process.env.PATH = dir + path.delimiter + originalPath;
    const agent = {
      externalId: 'local',
      name: 'Local',
      cliId: 'codex',
      workingDir: dir,
      permissionMode: 'read-only',
    } as const;
    const steps: string[] = [];
    const invoke = (prompt: string, session?: string) =>
      executeCli(agent, prompt, session, AbortSignal.timeout(5000), async (snapshot) => {
        steps.push(snapshot.steps[0].label);
      });
    const first = await invoke('begin');
    expect(first).toEqual({ sessionId: 'unit-session', content: 'first' });
    expect(steps).toEqual(['pwd']);
    expect((await invoke('continue', first.sessionId)).content).toBe('continued');
    await expect(invoke('fail')).rejects.toThrow('sign in first');
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
