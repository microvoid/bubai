import { useEffect, useState } from 'react';
import bubaiLogoUrl from '../../assets/bubai-logo.svg?no-inline';
import { Button } from '../../design-system/ui/Button';
import type { AuthUserSummary } from './AuthContext';
import { authClient } from './auth-client';
import styles from './IdentitySetup.module.css';
import { OnboardingScreen } from './OnboardingScreen';

export function InviteLanding({
  inviteId,
  user,
  onAccepted,
  onRejected,
}: {
  inviteId: string;
  user: AuthUserSummary;
  onAccepted: () => Promise<void>;
  onRejected: () => void;
}) {
  const [inviteInfo, setInviteInfo] = useState<{
    id: string;
    organizationName?: string;
    inviterEmail?: string;
    email?: string;
    role?: string;
  } | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setInviteError(null);
    authClient.organization
      .getInvitation({ query: { id: inviteId } })
      .then((res) => {
        if (cancelled) return;
        if (res.error || !res.data) {
          setInviteError(res.error?.message || '邀请无效或已过期');
          setInviteInfo(null);
          return;
        }
        setInviteInfo(
          res.data as {
            id: string;
            organizationName?: string;
            inviterEmail?: string;
            email?: string;
            role?: string;
          },
        );
      })
      .catch(() => {
        if (!cancelled) setInviteError('无法加载邀请信息');
      });
    return () => {
      cancelled = true;
    };
  }, [inviteId, user.id]);

  const handleAccept = async () => {
    setInviteBusy(true);
    setInviteError(null);
    try {
      const res = await authClient.organization.acceptInvitation({ invitationId: inviteId });
      if (res.error) {
        setInviteError(res.error.message || '接受邀请失败');
        return;
      }
      await onAccepted();
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : '接受邀请失败');
    } finally {
      setInviteBusy(false);
    }
  };

  const handleReject = async () => {
    setInviteBusy(true);
    try {
      await authClient.organization.rejectInvitation({ invitationId: inviteId });
      onRejected();
    } finally {
      setInviteBusy(false);
    }
  };

  return (
    <OnboardingScreen
      screenId="invite"
      labelledBy="auth-invite-title"
      intro={
        <>
          <h1 id="auth-invite-title" className="text-heading text-standard">
            加入 Community 邀请
          </h1>
          <p className="text-body text-subtle">当前已登录为 {user.email}</p>
        </>
      }
    >
      <div className={styles.form}>
        <div className={styles.inviteBox}>
          <img className={styles.brandIcon} src={bubaiLogoUrl} alt="" />
          <div>
            <div className="text-label text-standard">
              {inviteInfo?.organizationName || 'BubAI Community'}
            </div>
            <div className="text-caption text-subtle">
              {inviteInfo?.inviterEmail
                ? `由 ${inviteInfo.inviterEmail} 邀请加入`
                : '点击接受即可加入该工作空间'}
            </div>
          </div>
        </div>

        {inviteError && (
          <p className={styles.errorText} role="alert" data-auth-error="">
            {inviteError}
          </p>
        )}

        <Button
          variant="primary"
          disabled={inviteBusy}
          data-auth-action="accept-invite"
          onClick={() => void handleAccept()}
        >
          {inviteBusy ? '加入中…' : '接受并进入工作台'}
        </Button>
        <Button
          variant="outline"
          disabled={inviteBusy}
          data-auth-action="reject-invite"
          onClick={() => void handleReject()}
        >
          暂不加入
        </Button>
      </div>
    </OnboardingScreen>
  );
}
