import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Avatar } from '../../design-system/ui/Avatar';
import { Badge } from '../../design-system/ui/Badge';
import { Button } from '../../design-system/ui/Button';
import { Dialog } from '../../design-system/ui/Dialog';
import { Input } from '../../design-system/ui/Input';
import { writeClipboardText } from '../../shared/clipboard';
import type { AuthOrgSummary, AuthUserSummary } from './AuthGate';
import { AUTH_SERVER_HTTP, apiFetch, authClient } from './auth-client';
import styles from './IdentitySetup.module.css';

export function ProfileSettingsDialog({
  open,
  user,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  user: AuthUserSummary | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(user?.name || '');
  const [image, setImage] = useState(user?.image || '');
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open && user) {
      setName(user.name.trim() || user.email.split('@')[0] || '');
      setImage(user.image || '');
      setError(null);
    }
  }, [open, user]);

  const handleAvatarFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingAvatar(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await apiFetch(`${AUTH_SERVER_HTTP}/api/uploads`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        setError('头像上传失败');
        return;
      }
      const data = (await res.json()) as { attachment?: { url?: string } };
      const rawUrl = data.attachment?.url?.trim();
      if (!rawUrl) {
        setError('未获取到上传后的头像地址');
        return;
      }
      const resolvedUrl = rawUrl.startsWith('http')
        ? rawUrl
        : `${AUTH_SERVER_HTTP.replace(/\/+$/, '')}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
      setImage(resolvedUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : '头像上传失败');
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('显示名称不能为空');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.updateUser({
        name: trimmed,
        image: image.trim() || '',
      });
      if (res.error) {
        setError(res.error.message || '保存失败');
        return;
      }
      await onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="个人资料设置"
      size="default"
    >
      <form
        className={styles.form}
        data-profile-settings-dialog=""
        onSubmit={(e) => void handleSave(e)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Avatar
            src={image.trim() || undefined}
            alt={name || user?.name || ''}
            fallback={name || user?.name || '?'}
            size="large"
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="text-label text-standard">{name || user?.name}</div>
            <div className="text-caption text-subtle">{user?.email}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                data-auth-input="profile-avatar-file"
                onChange={(e) => void handleAvatarFileChange(e)}
              />
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={uploadingAvatar || busy}
                data-auth-action="upload-avatar"
                onClick={() => fileInputRef.current?.click()}
              >
                {uploadingAvatar ? '上传中…' : '上传头像'}
              </Button>
              {image.trim() && (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={uploadingAvatar || busy}
                  data-auth-action="remove-avatar"
                  onClick={() => setImage('')}
                >
                  移除
                </Button>
              )}
            </div>
          </div>
        </div>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>显示名称</span>
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="你的名称"
            data-auth-input="profile-name"
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>头像 URL（可选）</span>
          <Input
            type="url"
            value={image}
            onChange={(e) => setImage(e.target.value)}
            placeholder="https://... 或点击上方上传本地图片"
            data-auth-input="profile-avatar"
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>邮箱（只读）</span>
          <Input type="email" value={user?.email || ''} disabled />
        </label>

        {error && (
          <p className={styles.errorText} role="alert">
            {error}
          </p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy}
            data-auth-action="save-profile"
          >
            {busy ? '保存中…' : '保存'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

interface OrgMemberRow {
  id: string;
  role: string;
  userId: string;
  user?: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
    kind?: 'HUMAN' | 'BOT' | string;
  };
}

interface OrgInvitationRow {
  id: string;
  email: string;
  role?: string | null;
  status: string;
}

export function CommunityMembersDialog({
  open,
  activeOrg,
  currentUserId,
  onOpenChange,
}: {
  open: boolean;
  activeOrg: AuthOrgSummary | null;
  currentUserId?: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [tab, setTab] = useState<'members' | 'invites'>('members');
  const [members, setMembers] = useState<OrgMemberRow[]>([]);
  const [invitations, setInvitations] = useState<OrgInvitationRow[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member');
  const [lastInviteLink, setLastInviteLink] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRoster = async () => {
    if (!activeOrg) return;
    try {
      const res = await authClient.organization.getFullOrganization({
        query: { organizationId: activeOrg.id },
      });
      if (res.data) {
        const full = res.data as {
          members?: OrgMemberRow[];
          invitations?: OrgInvitationRow[];
        };
        setMembers(full.members || []);
        setInvitations((full.invitations || []).filter((i) => i.status === 'pending'));
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (open && activeOrg) {
      setError(null);
      setLastInviteLink(null);
      void loadRoster();
    }
  }, [open, activeOrg?.id]);

  const currentMember = members.find((m) => m.userId === currentUserId);
  const canManageMembers =
    currentMember?.role === 'owner' || currentMember?.role === 'admin';
  const isBotMember = (m: OrgMemberRow) =>
    m.user?.kind === 'BOT' || Boolean(m.user?.email?.endsWith('@bot.bubai.local'));
  const humanMembers = members.filter((m) => !isBotMember(m));
  const botMembers = members.filter((m) => isBotMember(m));

  const handleInvite = async (e: FormEvent) => {
    e.preventDefault();
    const email = inviteEmail.trim().toLowerCase();
    if (!activeOrg || !email || !email.includes('@')) {
      setError('请输入有效的受邀邮箱');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.organization.inviteMember({
        organizationId: activeOrg.id,
        email,
        role: inviteRole,
      });
      if (res.error || !res.data) {
        setError(res.error?.message || '发送邀请失败');
        return;
      }
      const id = (res.data as { id: string }).id;
      const link = `${window.location.origin}/invite/${encodeURIComponent(id)}`;
      setLastInviteLink(link);
      setInviteEmail('');
      await loadRoster();
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送邀请失败');
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateMemberRole = async (memberId: string, role: 'member' | 'admin') => {
    if (!activeOrg) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.organization.updateMemberRole({
        organizationId: activeOrg.id,
        memberId,
        role,
      });
      if (res.error) {
        setError(res.error.message || '更新角色失败');
        return;
      }
      await loadRoster();
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新角色失败');
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!activeOrg) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.organization.removeMember({
        organizationId: activeOrg.id,
        memberIdOrEmail: memberId,
      });
      if (res.error) {
        setError(res.error.message || '移除成员失败');
        return;
      }
      await loadRoster();
    } catch (err) {
      setError(err instanceof Error ? err.message : '移除成员失败');
    } finally {
      setBusy(false);
    }
  };

  const handleCancelInvite = async (invitationId: string) => {
    setBusy(true);
    try {
      await authClient.organization.cancelInvitation({ invitationId });
      await loadRoster();
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async (id: string) => {
    const link = `${window.location.origin}/invite/${encodeURIComponent(id)}`;
    await writeClipboardText(link).catch(() => undefined);
    setCopiedId(id);
    setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 2000);
  };

  const renderMemberRow = (m: OrgMemberRow) => {
    const isBot = isBotMember(m);
    const isSelf = currentUserId != null && m.userId === currentUserId;
    const canEditRow = canManageMembers && !isSelf && m.role !== 'owner';
    return (
      <div
        key={m.id}
        data-member-row={m.user?.email || m.userId}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '6px 8px',
          borderRadius: 8,
        }}
      >
        <Avatar
          src={m.user?.image || undefined}
          alt={m.user?.name || m.userId}
          fallback={m.user?.name || m.userId}
          size="small"
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="text-body text-standard" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>{m.user?.name || m.user?.email?.split('@')[0] || m.userId}</span>
            {isBot && <Badge tone="neutral">BOT</Badge>}
          </div>
          {m.user?.email && (
            <div className="text-caption text-subtle">{m.user.email}</div>
          )}
        </div>
        {canEditRow ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <select
              aria-label="Member role"
              value={m.role === 'admin' ? 'admin' : 'member'}
              disabled={busy}
              data-member-role-select=""
              onChange={(e) =>
                void handleUpdateMemberRole(m.id, e.target.value as 'member' | 'admin')
              }
              style={{
                height: 28,
                padding: '0 8px',
                borderRadius: 6,
                border: '1px solid var(--border-standard)',
                background: 'var(--surface-panel)',
                color: 'var(--text-standard)',
                fontSize: 12,
              }}
            >
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy}
              data-member-remove=""
              onClick={() => void handleRemoveMember(m.id)}
            >
              移除
            </Button>
          </div>
        ) : (
          <Badge tone="neutral">{m.role}</Badge>
        )}
      </div>
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${activeOrg?.name || 'Community'} · 成员与邀请`}
      size="default"
    >
      <div className={styles.form} data-community-members-dialog="">
        <form
          onSubmit={(e) => void handleInvite(e)}
          style={{ display: 'flex', gap: 8, alignItems: 'center' }}
        >
          <div style={{ flex: 1 }}>
            <Input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="输入邮箱邀请新成员…"
              data-auth-input="invite-email"
            />
          </div>
          <select
            aria-label="Invite role"
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as 'member' | 'admin')}
            data-auth-input="invite-role"
            style={{
              height: 36,
              padding: '0 10px',
              borderRadius: 8,
              border: '1px solid var(--border-standard)',
              background: 'var(--surface-panel)',
              color: 'var(--text-standard)',
              fontSize: 13,
            }}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <Button
            type="submit"
            variant="primary"
            disabled={busy}
            data-auth-action="send-invite"
          >
            {busy ? '发送中…' : '邀请'}
          </Button>
        </form>

        {lastInviteLink && (
          <div
            className={styles.inviteBox}
            data-invite-link={lastInviteLink}
            style={{ justifyContent: 'space-between' }}
          >
            <span className="text-caption text-standard" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              邀请已创建：{lastInviteLink}
            </span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => {
                void writeClipboardText(lastInviteLink).catch(() => undefined);
              }}
            >
              复制链接
            </Button>
          </div>
        )}

        {error && (
          <p className={styles.errorText} role="alert">
            {error}
          </p>
        )}

        <div className={styles.modeTabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'members'}
            className={styles.modeTab}
            onClick={() => setTab('members')}
          >
            成员 ({members.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'invites'}
            className={styles.modeTab}
            data-community-tab="invites"
            onClick={() => setTab('invites')}
          >
            待处理邀请 ({invitations.length})
          </button>
        </div>

        {tab === 'members' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 280, overflowY: 'auto' }}>
            <div data-members-group="humans" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div className="text-caption text-subtle" style={{ padding: '0 8px' }}>
                人类成员 ({humanMembers.length})
              </div>
              {humanMembers.map(renderMemberRow)}
            </div>
            {botMembers.length > 0 && (
              <div data-members-group="bots" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div className="text-caption text-subtle" style={{ padding: '0 8px' }}>
                  Bots ({botMembers.length})
                </div>
                {botMembers.map(renderMemberRow)}
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 280, overflowY: 'auto' }}>
            {invitations.length === 0 ? (
              <p className="text-caption text-subtle" style={{ textAlign: 'center', padding: 16 }}>
                暂无待处理邀请
              </p>
            ) : (
              invitations.map((inv) => (
                <div
                  key={inv.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 8px',
                    borderRadius: 8,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="text-body text-standard">{inv.email}</div>
                    <div className="text-caption text-subtle">{inv.role || 'member'}</div>
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => void copyLink(inv.id)}
                  >
                    {copiedId === inv.id ? '已复制' : '复制链接'}
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => void handleCancelInvite(inv.id)}
                  >
                    撤销
                  </Button>
                </div>
              ))
            )}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            type="button"
            variant="outline"
            data-auth-action="close-community-members"
            onClick={() => onOpenChange(false)}
          >
            关闭
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function CreateCommunityDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (orgId: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setError(null);
    }
  }, [open]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('请输入 Community 名称');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const slugBase = trimmed
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      const slug = `${slugBase || 'community'}-${Math.random().toString(36).slice(2, 6)}`;
      const res = await authClient.organization.create({ name: trimmed, slug });
      if (res.error || !res.data) {
        setError(res.error?.message || '创建失败');
        return;
      }
      await onCreated((res.data as { id: string }).id);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="新建 Community" size="compact">
      <form className={styles.form} onSubmit={(e) => void handleSubmit(e)}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Community 名称</span>
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：Personal Lab"
            autoFocus
            data-auth-input="new-org-name"
          />
        </label>
        {error && <p className={styles.errorText}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="submit" variant="primary" disabled={busy} data-auth-action="submit-create-org">
            {busy ? '创建中…' : '创建'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
