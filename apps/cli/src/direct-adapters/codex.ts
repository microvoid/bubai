import type { CliAdapter } from './types';
export const codex: CliAdapter = {
  args(permission, session) {
    const perms =
      permission === 'full-access'
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['--sandbox', permission];
    return [
      'exec',
      '--json',
      '--skip-git-repo-check',
      ...perms,
      ...(session ? ['resume', session] : []),
      '-',
    ];
  },
  parse(record) {
    if (record.type === 'thread.started') return { session: record.thread_id };
    if (record.type === 'turn.failed') return { error: record.error?.message || 'Codex turn failed' };
    const item = record.item;
    if (!item || !['item.started', 'item.updated', 'item.completed'].includes(record.type)) return {};
    if (item.type === 'agent_message') return { result: item.text };
    if (item.type === 'reasoning') return {};
    const kind = item.type === 'command_execution' ? 'shell' : item.type === 'file_change' ? 'edit' : 'tool';
    return {
      steps: [
        {
          id: item.id,
          kind,
          label: item.command || item.tool || item.type,
          status:
            item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0)
              ? 'failed'
              : record.type === 'item.completed'
                ? 'done'
                : 'running',
        },
      ],
    };
  },
};
