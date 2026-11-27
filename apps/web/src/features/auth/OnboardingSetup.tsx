import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '../../design-system/ui/Button';
import { Input } from '../../design-system/ui/Input';
import type { AuthUserSummary } from './AuthContext';
import { authClient, resolveDisplayName } from './auth-client';
import styles from './IdentitySetup.module.css';
import { OnboardingScreen } from './OnboardingScreen';

function slugifyOrgName(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = Math.random().toString(36).slice(2, 6);
  return base ? `${base}-${suffix}` : `community-${suffix}`;
}

interface PendingInvitationItem {
  id: string;
  organizationId: string;
  organizationName?: string;
  inviterEmail?: string;
  role?: string | null;
  status: string;
}

export function OnboardingSetup({
  user,
  onCompleted,
  onSignOut,
}: {
  user: AuthUserSummary;
  onCompleted: () => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  const [onboardingTab, setOnboardingTab] = useState<'create' | 'join'>('create');
  const [orgNameInput, setOrgNameInput] = useState('');
  const [inviteCodeInput, setInviteCodeInput] = useState('');
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [pendingInvitations, setPendingInvitations] = useState<PendingInvitationItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await authClient.organization.listUserInvitations();
        if (cancelled) return;
        const rawList = Array.isArray(res.data) ? (res.data as PendingInvitationItem[]) : [];
        const pending = rawList.filter((inv) => inv.status === 'pending');
        const enriched = await Promise.all(
          pending.map(async (inv) => {
            if (inv.organizationName) return inv;
            try {
              const detail = await authClient.organization.getInvitation({
                query: { id: inv.id },
              });
              const data = detail.data as
                | { organizationName?: string; inviterEmail?: string }
                | undefined;
              return {
                ...inv,
                organizationName: data?.organizationName || inv.organizationName,
                inviterEmail: data?.inviterEmail || inv.inviterEmail,
              };
            } catch {
              return inv;
            }
          }),
        );
        if (!cancelled) setPendingInvitations(enriched);
      } catch {
        if (!cancelled) setPendingInvitations([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  const handleCreateOrg = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = orgNameInput.trim();
    if (!trimmed) {
      setOnboardingError('请输入 Community 名称');
      return;
    }
    setOnboardingBusy(true);
    setOnboardingError(null);
    try {
      const created = await authClient.organization.create({
        name: trimmed,
        slug: slugifyOrgName(trimmed),
      });
      if (created.error || !created.data) {
        setOnboardingError(created.error?.message || '创建 Community 失败');
        return;
      }
      const orgId = (created.data as { id: string }).id;
      await authClient.organization.setActive({ organizationId: orgId });
      await onCompleted();
    } catch (err) {
      setOnboardingError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setOnboardingBusy(false);
    }
  };

  const acceptInvitationById = async (invitationId: string) => {
    setOnboardingBusy(true);
    setOnboardingError(null);
    try {
      const res = await authClient.organization.acceptInvitation({ invitationId });
      if (res.error) {
        setOnboardingError(res.error.message || '接受邀请失败');
        return;
      }
      await onCompleted();
    } catch (err) {
      setOnboardingError(err instanceof Error ? err.message : '接受邀请失败');
    } finally {
      setOnboardingBusy(false);
    }
  };

  const handleJoinByInviteCode = async (e: FormEvent) => {
    e.preventDefault();
    const raw = inviteCodeInput.trim();
    const extracted = raw.match(/\/invite\/([^/?#]+)/)?.[1] || raw;
    if (!extracted) {
      setOnboardingError('请输入邀请链接或邀请码');
      return;
    }
    await acceptInvitationById(extracted);
  };

  return (
    <OnboardingScreen
      screenId="onboarding"
      labelledBy="auth-onboarding-title"
      intro={
        <>
          <h1 id="auth-onboarding-title" className="text-heading text-standard">
            欢迎，{resolveDisplayName(user.name, user.email)}
          </h1>
          <p className="text-body text-subtle">
            创建一个新的 Community，或通过邀请加入团队空间
          </p>
        </>
      }
    >
      <div className={styles.form}>
        <div className={styles.modeTabs} role="tablist" aria-label="Onboarding mode">
          <button
            type="button"
            role="tab"
            aria-selected={onboardingTab === 'create'}
            className={styles.modeTab}
            data-auth-action="onboarding-tab-create"
            onClick={() => {
              setOnboardingTab('create');
              setOnboardingError(null);
            }}
          >
            创建新 Community
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={onboardingTab === 'join'}
            className={styles.modeTab}
            data-auth-action="onboarding-tab-join"
            onClick={() => {
              setOnboardingTab('join');
              setOnboardingError(null);
            }}
          >
            加入已有
          </button>
        </div>

        {onboardingTab === 'create' ? (
          <form className={styles.form} onSubmit={(e) => void handleCreateOrg(e)}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Community 名称</span>
              <Input
                type="text"
                value={orgNameInput}
                onChange={(e) => setOrgNameInput(e.target.value)}
                placeholder="例如：Bubai Team"
                autoFocus
                data-auth-input="org-name"
              />
            </label>

            {onboardingError && (
              <p className={styles.errorText} role="alert" data-auth-error="">
                {onboardingError}
              </p>
            )}

            <Button
              type="submit"
              variant="primary"
              disabled={onboardingBusy}
              data-auth-action="create-org"
            >
              {onboardingBusy ? '创建中…' : '创建并进入工作台'}
            </Button>
          </form>
        ) : (
          <div className={styles.form}>
            {pendingInvitations.length > 0 && (
              <div className={styles.form} data-pending-invitations-list="">
                <span className={styles.fieldLabel}>发给 {user.email} 的待处理邀请</span>
                {pendingInvitations.map((inv) => (
                  <div
                    key={inv.id}
                    className={styles.inviteBox}
                    style={{ justifyContent: 'space-between' }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div className="text-label text-standard">
                        {inv.organizationName || 'BubAI Community'}
                      </div>
                      <div className="text-caption text-subtle">
                        {inv.inviterEmail
                          ? `来自 ${inv.inviterEmail} · ${inv.role || 'member'}`
                          : `角色：${inv.role || 'member'}`}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="xs"
                      variant="primary"
                      disabled={onboardingBusy}
                      data-auth-action="accept-pending-invite"
                      data-invitation-id={inv.id}
                      onClick={() => void acceptInvitationById(inv.id)}
                    >
                      接受并加入
                    </Button>
                  </div>
                ))}
                <div className={styles.divider}>或使用邀请链接</div>
              </div>
            )}
            <form className={styles.form} onSubmit={(e) => void handleJoinByInviteCode(e)}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>邀请链接或邀请码</span>
                <Input
                  type="text"
                  value={inviteCodeInput}
                  onChange={(e) => setInviteCodeInput(e.target.value)}
                  placeholder="粘贴 /invite/... 链接或邀请 ID"
                  autoFocus={pendingInvitations.length === 0}
                  data-auth-input="invite-code"
                />
              </label>

              {onboardingError && (
                <p className={styles.errorText} role="alert" data-auth-error="">
                  {onboardingError}
                </p>
              )}

              <Button
                type="submit"
                variant="primary"
                disabled={onboardingBusy}
                data-auth-action="join-org"
              >
                {onboardingBusy ? '加入中…' : '接受并加入'}
              </Button>
            </form>
          </div>
        )}

        <div className={styles.rowActions}>
          <button
            type="button"
            className={styles.linkButton}
            data-auth-action="onboarding-sign-out"
            onClick={() => void onSignOut()}
          >
            退出登录（{user.email}）
          </button>
        </div>
      </div>
    </OnboardingScreen>
  );
}
