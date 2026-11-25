import { useEffect, useState } from 'react';
import { Button } from '../../design-system/ui/Button';
import { Dialog } from '../../design-system/ui/Dialog';
import { Input } from '../../design-system/ui/Input';
import { Textarea } from '../../design-system/ui/Textarea';
import styles from './AgentProfilePanel.module.css';
import type { AgentDetail, AgentUpdateInput } from './types';

const MAX_DESCRIPTION_LEN = 280;

export function EditAgentDialog({
  open,
  agent,
  saving,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  agent: AgentDetail;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (input: AgentUpdateInput) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [avatarUrl, setAvatarUrl] = useState(agent.avatarUrl);
  const [systemPrompt, setSystemPrompt] = useState(agent.systemPrompt);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDisplayName(agent.name);
    setDescription(agent.description);
    setAvatarUrl(agent.avatarUrl);
    setSystemPrompt(agent.systemPrompt);
    setError(null);
  }, [open, agent.id, agent.name, agent.description, agent.avatarUrl, agent.systemPrompt]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await onSave({
        displayName: displayName.trim() || null,
        description: description.trim().slice(0, MAX_DESCRIPTION_LEN) || null,
        avatarUrl: avatarUrl.trim() || null,
        systemPrompt,
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit agent"
      description={`配置 ${agent.botName} 的展示资料与系统指令`}
      size="default"
      preventClose={saving}
      actions={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button
            variant="quiet"
            size="sm"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={saving}
            onClick={() => void handleSubmit({ preventDefault() {} } as React.FormEvent)}
          >
            Save changes
          </Button>
        </div>
      }
    >
      <form className={styles.formStack} onSubmit={(e) => void handleSubmit(e)}>
        <div className={styles.fieldGroup}>
          <div className={styles.fieldLabelRow}>
            <label htmlFor="agent-edit-name">Display name</label>
            <span className={styles.fieldHint}>留空则回退为 Botmux 名称 ({agent.botName})</span>
          </div>
          <Input
            id="agent-edit-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={agent.botName}
            disabled={saving}
          />
        </div>

        <div className={styles.fieldGroup}>
          <div className={styles.fieldLabelRow}>
            <label htmlFor="agent-edit-description">Description</label>
            <span className={styles.fieldHint}>
              {description.length}/{MAX_DESCRIPTION_LEN}
            </span>
          </div>
          <Input
            id="agent-edit-description"
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, MAX_DESCRIPTION_LEN))}
            placeholder="简短介绍这个 Agent 负责什么…"
            disabled={saving}
          />
        </div>

        <div className={styles.fieldGroup}>
          <div className={styles.fieldLabelRow}>
            <label htmlFor="agent-edit-avatar">Avatar URL</label>
            <span className={styles.fieldHint}>可选图片链接</span>
          </div>
          <Input
            id="agent-edit-avatar"
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
            placeholder="https://..."
            disabled={saving}
          />
        </div>

        <div className={styles.fieldGroup}>
          <div className={styles.fieldLabelRow}>
            <label htmlFor="agent-edit-prompt">Agent instructions</label>
            <span className={styles.fieldHint}>Markdown / System Prompt</span>
          </div>
          <Textarea
            id="agent-edit-prompt"
            variant="code"
            rows={7}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="描述该 Agent 的角色、工作规范、输出风格等…"
            disabled={saving}
          />
        </div>

        {error && (
          <div className={styles.destructiveText} style={{ fontSize: 12.5 }}>
            {error}
          </div>
        )}
      </form>
    </Dialog>
  );
}
