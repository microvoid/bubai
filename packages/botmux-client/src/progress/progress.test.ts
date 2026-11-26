import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  finalizeProgressSnapshot,
  normalizeProgressSnapshot,
  parseAntigravityProgress,
  parseClaudeProgress,
  parseCodexProgress,
  progressSnapshotEquals,
} from './index.js';

function makeHeadlessRequest(triggerId: string, botId: string, channelId: string): string {
  const payload = {
    triggerId,
    source: { type: 'headless', connectorId: 'buzz-botmux' },
    envelope: {
      format: 'json',
      trusted: false,
      payload: {
        conversation: {
          channel: { id: channelId },
          outboundApi: { channelId, botId },
        },
      },
    },
    options: { asyncReturnSessionId: true },
  };
  return `<USER_REQUEST>\n<botmux_headless_request>\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n</botmux_headless_request>\n</user_message>\n</USER_REQUEST>`;
}

describe('AgentProgressSnapshot contract & adapters', () => {
  it('normalizes external payloads into the fixed server contract', () => {
    const normalized = normalizeProgressSnapshot({
      activeLabel: '  Async tasks running  ',
      toolCount: 2,
      steps: [
        { id: 's1', kind: 'read', label: '读取 SKILL.md', status: 'done' },
        { id: 's2', kind: 'unknown_kind', label: '查看目录', status: 'running' },
        { label: '   ' }, // dropped
      ],
    });

    assert.ok(normalized);
    assert.equal(normalized.activeLabel, 'Async tasks running');
    assert.equal(normalized.toolCount, 2);
    assert.deepEqual(normalized.steps, [
      { id: 's1', kind: 'read', label: '读取 SKILL.md', status: 'done' },
      { id: 's2', kind: 'tool', label: '查看目录', status: 'running' },
    ]);

    const settled = finalizeProgressSnapshot(normalized, 'completed');
    assert.equal(settled?.activeLabel, undefined);
    assert.equal(settled?.steps[1]?.status, 'done');
    assert.equal(progressSnapshotEquals(normalized, settled), false);
  });

  it('extracts Antigravity tool steps and Async tasks running state', () => {
    const now = new Date();
    const triggerId = 'trg-agy-001';
    const botId = 'cli_bot_1';
    const channelId = 'ch-1';

    const lines = [
      JSON.stringify({
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        status: 'DONE',
        created_at: now.toISOString(),
        content: makeHeadlessRequest(triggerId, botId, channelId),
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [
          {
            id: 'c1',
            name: 'default_api:read_file',
            arguments: { Path: '/repo/skills/SKILL.md' },
          },
          {
            id: 'c2',
            name: 'default_api:run_command',
            arguments: { toolSummary: '查看本话题工作目录与项目目录', CommandLine: 'pwd && ls' },
          },
          {
            id: 'c3',
            name: 'default_api:invoke_subagent',
            arguments: { Role: '查前端技能列表截断逻辑' },
          },
        ],
      }),
      JSON.stringify({
        type: 'GENERIC',
        status: 'RUNNING',
        content: 'Subagent running as a background task',
      }),
    ].join('\n');

    const progress = parseAntigravityProgress(lines, {
      cliId: 'antigravity',
      triggerId,
      botId,
      channelId,
      createdAt: new Date(now.getTime() - 1000),
    });

    assert.ok(progress);
    assert.equal(progress.activeLabel, 'Async tasks running');
    assert.equal(progress.toolCount, 4);
    assert.deepEqual(
      progress.steps.map((s) => [s.kind, s.label, s.status]),
      [
        ['read', '读取 SKILL.md', 'done'],
        ['shell', '查看本话题工作目录与项目目录', 'done'],
        ['task', '查前端技能列表截断逻辑', 'done'],
        ['task', 'Async tasks running', 'running'],
      ],
    );
  });

  it('extracts Codex rollout function_call steps and output completion', () => {
    const triggerId = 'trg-codex-002';
    const lines = [
      JSON.stringify({
        payload: { type: 'message', role: 'user', content: `triggerId=${triggerId}` },
      }),
      JSON.stringify({
        payload: {
          type: 'function_call',
          call_id: 'call_1',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'git status -sb' }),
        },
      }),
      JSON.stringify({
        payload: { type: 'function_call_output', call_id: 'call_1', output: 'clean' },
      }),
      JSON.stringify({
        payload: {
          type: 'custom_tool_call',
          call_id: 'call_2',
          name: 'apply_patch',
          input: '*** Begin Patch',
        },
      }),
    ].join('\n');

    const progress = parseCodexProgress(lines, {
      cliId: 'codex',
      triggerId,
      botId: 'bot-2',
      channelId: 'ch-2',
      createdAt: new Date(),
    });

    assert.equal(progress?.toolCount, 2);
    assert.equal(progress?.activeLabel, '修改代码补丁');
    assert.deepEqual(progress?.steps, [
      { id: 'call_1', kind: 'shell', label: 'git status -sb', status: 'done' },
      { id: 'call_2', kind: 'edit', label: '修改代码补丁', status: 'running' },
    ]);
  });

  it('extracts Claude tool_use blocks and tool_result settlement', () => {
    const triggerId = 'trg-claude-003';
    const lines = [
      JSON.stringify({
        message: { role: 'user', content: `run ${triggerId}` },
      }),
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/app/SKILL.md' } },
            { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { description: '查看该 Codex 座位可用模型', command: 'codex models' } },
          ],
        },
      }),
      JSON.stringify({
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }],
        },
      }),
    ].join('\n');

    const progress = parseClaudeProgress(lines, {
      cliId: 'claude',
      triggerId,
      botId: 'bot-3',
      channelId: 'ch-3',
      createdAt: new Date(),
    });

    assert.equal(progress?.toolCount, 2);
    assert.equal(progress?.activeLabel, '查看该 Codex 座位可用模型');
    assert.deepEqual(progress?.steps, [
      { id: 'tu_1', kind: 'read', label: '读取 SKILL.md', status: 'done' },
      { id: 'tu_2', kind: 'shell', label: '查看该 Codex 座位可用模型', status: 'running' },
    ]);
  });
});
