import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import bubaiLogoUrl from '../../assets/bubai-logo.svg?no-inline';
import { useAppearance } from '../../shared/theme/service';
import {
  AuthContext,
  useBubaiAuth,
  type AuthContextValue,
  type AuthOrgSummary,
  type AuthUserSummary,
} from './AuthContext';
import { AuthForm } from './AuthForms';
import {
  AUTH_SERVER_HTTP,
  authClient,
  type InstanceAuthInfo,
} from './auth-client';
import { DeviceApproveView } from './DeviceApproveView';
import styles from './IdentitySetup.module.css';
import { InviteLanding } from './InviteLanding';
import { OnboardingScreen } from './OnboardingScreen';
import { OnboardingSetup } from './OnboardingSetup';
import { SessionExpiredOverlay } from './SessionExpiredOverlay';

export { useBubaiAuth, type AuthContextValue, type AuthOrgSummary, type AuthUserSummary };

function parseInviteIdFromLocation(): string | null {
  const match = window.location.pathname.match(/^\/invite\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
}

function parseDeviceRouteFromLocation(): { active: boolean; userCode: string } {
  if (!/^\/device\/?$/.test(window.location.pathname)) {
    return { active: false, userCode: '' };
  }
  const params = new URLSearchParams(window.location.search);
  const code = params.get('user_code') || params.get('code') || '';
  return { active: true, userCode: code.trim().toUpperCase() };
}

export function AuthGate({ children }: { children: ReactNode }) {
  useAppearance();
  const [instanceInfo, setInstanceInfo] = useState<InstanceAuthInfo | null>(null);
  const { data: sessionData, isPending: sessionPending, refetch: refetchSession } =
    authClient.useSession();
  const [organizations, setOrganizations] = useState<AuthOrgSummary[]>([]);
  const [loadedOrgsForUserId, setLoadedOrgsForUserId] = useState<string | null>(null);
  const [orgRevision, setOrgRevision] = useState(0);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [inviteId, setInviteId] = useState<string | null>(() => parseInviteIdFromLocation());
  const [deviceRouteActive, setDeviceRouteActive] = useState<boolean>(
    () => parseDeviceRouteFromLocation().active,
  );
  const [deviceInitialCode] = useState<string>(() => parseDeviceRouteFromLocation().userCode);
  const [authFormMode, setAuthFormMode] = useState<'otp' | 'password'>('otp');

  // Track last focused element before SessionExpiredOverlay (ported from Buzz LaunchSignIn)
  const savedFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${AUTH_SERVER_HTTP}/api/instance`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Partial<InstanceAuthInfo> | null) => {
        if (cancelled) return;
        setInstanceInfo({
          name: data?.name || 'Bubai',
          authRequired: Boolean(data?.authRequired),
          emailAndPasswordEnabled:
            data?.emailAndPasswordEnabled !== undefined
              ? Boolean(data.emailAndPasswordEnabled)
              : true,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setInstanceInfo({ name: 'Bubai', authRequired: true, emailAndPasswordEnabled: true });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const user: AuthUserSummary | null = sessionData?.user
    ? {
        id: sessionData.user.id,
        name: sessionData.user.name,
        email: sessionData.user.email,
        image: sessionData.user.image ?? null,
      }
    : null;

  const activeOrgId =
    (sessionData?.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;

  const refreshOrganizations = useCallback(async () => {
    if (!user) {
      setOrganizations([]);
      setLoadedOrgsForUserId(null);
      return;
    }
    const targetUserId = user.id;
    try {
      const res = await authClient.organization.list();
      const list = Array.isArray(res.data) ? (res.data as AuthOrgSummary[]) : [];
      setOrganizations(list);
      // Auto-activate first organization if user has orgs but none is active yet
      if (list.length > 0 && !activeOrgId) {
        await authClient.organization.setActive({ organizationId: list[0]!.id });
        await refetchSession();
      }
    } catch {
      setOrganizations([]);
    } finally {
      setLoadedOrgsForUserId(targetUserId);
    }
  }, [user, activeOrgId, refetchSession]);

  useEffect(() => {
    if (sessionPending) return;
    void refreshOrganizations();
  }, [user?.id, sessionPending]);

  // Listen for 401 unauthorized events mid-session (ported from Buzz LaunchSignIn)
  useEffect(() => {
    if (!instanceInfo?.authRequired) return;
    const onUnauthorized = () => {
      if (document.activeElement instanceof HTMLElement) {
        savedFocusRef.current = document.activeElement;
      }
      setSessionExpired(true);
    };
    window.addEventListener('bubai:unauthorized', onUnauthorized);
    return () => window.removeEventListener('bubai:unauthorized', onUnauthorized);
  }, [instanceInfo?.authRequired]);

  const switchOrganization = useCallback(
    async (orgId: string) => {
      await authClient.organization.setActive({ organizationId: orgId });
      await refetchSession();
      setOrgRevision((r) => r + 1);
    },
    [refetchSession],
  );

  const refreshSession = useCallback(async () => {
    await refetchSession();
  }, [refetchSession]);

  const signOut = useCallback(async () => {
    setSessionExpired(false);
    setAuthFormMode('otp');
    await authClient.signOut();
    await refetchSession();
    setOrganizations([]);
  }, [refetchSession]);

  const activeOrg = useMemo(() => {
    if (organizations.length === 0) return null;
    if (activeOrgId) {
      const found = organizations.find((o) => o.id === activeOrgId);
      if (found) return found;
    }
    return organizations[0] ?? null;
  }, [organizations, activeOrgId]);

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      authRequired: Boolean(instanceInfo?.authRequired),
      emailAndPasswordEnabled: Boolean(instanceInfo?.emailAndPasswordEnabled),
      user,
      organizations,
      activeOrg,
      orgRevision,
      switchOrganization,
      refreshOrganizations,
      refreshSession,
      signOut,
    }),
    [
      instanceInfo?.authRequired,
      instanceInfo?.emailAndPasswordEnabled,
      user,
      organizations,
      activeOrg,
      orgRevision,
      switchOrganization,
      refreshOrganizations,
      refreshSession,
      signOut,
    ],
  );

  if (!instanceInfo) {
    return (
      <AuthContext.Provider value={contextValue}>
        <div className={`${styles.landing} ${styles.step}`} data-auth-screen="boot">
          <div className={styles.progress}>
            <img className={styles.brandIcon} src={bubaiLogoUrl} alt="BubAI" />
            <p className="text-body text-subtle">正在连接 BubAI…</p>
          </div>
        </div>
      </AuthContext.Provider>
    );
  }

  if (!instanceInfo.authRequired) {
    return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
  }

  if (sessionPending || (user && loadedOrgsForUserId !== user.id)) {
    return (
      <AuthContext.Provider value={contextValue}>
        <div className={`${styles.landing} ${styles.step}`} data-auth-screen="boot">
          <div className={styles.progress}>
            <img className={styles.brandIcon} src={bubaiLogoUrl} alt="BubAI" />
            <p className="text-body text-subtle">正在恢复会话…</p>
          </div>
        </div>
      </AuthContext.Provider>
    );
  }

  if (!user) {
    return (
      <AuthContext.Provider value={contextValue}>
        <OnboardingScreen
          screenId="sign-in"
          labelledBy="auth-signin-title"
          intro={
            <>
              <div className={styles.brandHeader}>
                <img className={styles.brandIcon} src={bubaiLogoUrl} alt="" />
                <h1 id="auth-signin-title" className="text-heading text-standard">
                  登录到 {instanceInfo.name}
                </h1>
              </div>
              <p className="text-body text-subtle">
                {deviceRouteActive
                  ? '请先登录，随后即可批准终端设备授权'
                  : inviteId
                    ? '请先登录，随后即可接受 Community 邀请'
                    : authFormMode === 'password'
                      ? '开发模式：使用邮箱和密码登录或注册账号'
                      : '输入邮箱获取 6 位一次性验证码，快速进入工作空间'}
              </p>
            </>
          }
        >
          <AuthForm
            emailAndPasswordEnabled={instanceInfo.emailAndPasswordEnabled}
            onModeChange={setAuthFormMode}
            onAuthenticated={() => {
              void refetchSession();
            }}
          />
        </OnboardingScreen>
      </AuthContext.Provider>
    );
  }

  if (deviceRouteActive) {
    return (
      <AuthContext.Provider value={contextValue}>
        <DeviceApproveView
          user={user}
          initialUserCode={deviceInitialCode}
          onContinue={() => {
            setDeviceRouteActive(false);
            window.history.replaceState({}, '', '/');
          }}
        />
      </AuthContext.Provider>
    );
  }

  if (inviteId) {
    return (
      <AuthContext.Provider value={contextValue}>
        <InviteLanding
          inviteId={inviteId}
          user={user}
          onAccepted={async () => {
            window.history.replaceState({}, '', '/');
            setInviteId(null);
            await refreshOrganizations();
            setOrgRevision((r) => r + 1);
          }}
          onRejected={() => {
            window.history.replaceState({}, '', '/');
            setInviteId(null);
          }}
        />
      </AuthContext.Provider>
    );
  }

  if (organizations.length === 0) {
    return (
      <AuthContext.Provider value={contextValue}>
        <OnboardingSetup
          user={user}
          onCompleted={async () => {
            await refetchSession();
            await refreshOrganizations();
            setOrgRevision((r) => r + 1);
          }}
          onSignOut={signOut}
        />
      </AuthContext.Provider>
    );
  }

  return (
    <AuthContext.Provider value={contextValue}>
      {sessionExpired && (
        <SessionExpiredOverlay
          emailAndPasswordEnabled={instanceInfo.emailAndPasswordEnabled}
          lockedEmail={user.email}
          onAuthenticated={() => {
            setSessionExpired(false);
            void refetchSession();
            setOrgRevision((r) => r + 1);
            queueMicrotask(() => {
              if (savedFocusRef.current?.isConnected) {
                savedFocusRef.current.focus();
              }
            });
          }}
          onSwitchAccount={() => void signOut()}
        />
      )}
      <div
        className="contents"
        inert={sessionExpired}
        style={sessionExpired ? { visibility: 'hidden' } : undefined}
      >
        {children}
      </div>
    </AuthContext.Provider>
  );
}
