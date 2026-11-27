import type { AgentProgressStepKind } from '@buzz-botmux/botmux-client';
import type { CliAdapter } from './types';
const toolKinds: Record<string, AgentProgressStepKind> = {
  Read: 'read',
  Bash: 'shell',
  Write: 'edit',
  Edit: 'edit',
  Grep: 'search',
  Glob: 'search',
};

export const claude: CliAdapter = {
  args(permission, session) {
    const perms =
      permission === 'read-only'
        ? ['--permission-mode', 'plan', '--tools', 'Read,Glob,Grep', '--strict-mcp-config']
        : permission === 'workspace-write'
          ? ['--permission-mode', 'acceptEdits']
          : ['--dangerously-skip-permissions'];
    return [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      ...perms,
      ...(session ? ['--resume', session] : []),
    ];
  },
  parse(record) {
    if (record.type === 'result') {
      if (record.is_error || record.subtype !== 'success')
        return { error: record.result || record.errors?.join('\n') || 'Claude turn failed' };
      return { result: record.result, session: record.session_id };
    }
    const blocks = record.message?.content;
    if (!Array.isArray(blocks)) return { session: record.session_id };
    return {
      session: record.session_id,
      steps: blocks.map((block) => {
        if (block.type === 'tool_result')
          return { id: block.tool_use_id, status: block.is_error ? 'failed' : 'done' };
        if (block.type !== 'tool_use') return {};
        return { id: block.id, label: block.name, kind: toolKinds[block.name] || 'tool', status: 'running' };
      }),
    };
  },
};
