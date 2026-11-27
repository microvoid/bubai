import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import bubaiLogoUrl from '../../assets/bubai-logo.svg?no-inline';
import { Button } from '../../design-system/ui/Button';
import { Input } from '../../design-system/ui/Input';
import { useAppearance } from '../../shared/theme/service';
import { AuthForm } from './AuthForms';
import {
  AUTH_SERVER_HTTP,
  authClient,
  type InstanceAuthInfo,
} from './auth-client';
import styles from './IdentitySetup.module.css';
import { OnboardingScreen } from './OnboardingScreen';

export interface AuthOrgSummary {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
}

export interface AuthUserSummary {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

export interface AuthContextValue {
  authRequired: boolean;
  emailAndPasswordEnabled: boolean;
  user: AuthUserSummary | null;
  organizations: AuthOrgSummary[];
  activeOrg: AuthOrgSummary | null;
  orgRevision: number;
  switchOrganization: (orgId: string) => Promise<void>;
  refreshOrganizations: () => Promise<void>;
  refreshSession: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useBubaiAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useBubaiAuth must be used inside AuthGate');
  }
  return ctx;
}

function slugifyOrgName(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = Math.random().toString(36).slice(2, 6);
  return base ? `${base}-${suffix}` : `community-${suffix}`;
}

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
  const [deviceUserCode, setDeviceUserCode] = useState<string>(
    () => parseDeviceRouteFromLocation().userCode,
  );
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [deviceOutcome, setDeviceOutcome] = useState<'approved' | 'denied' | null>(null);
  const [authFormMode, setAuthFormMode] = useState<'otp' | 'password'>('otp');

  // Onboarding state
  const [onboardingTab, setOnboardingTab] = useState<'create' | 'join'>('create');
  const [orgNameInput, setOrgNameInput] = useState('');
  const [inviteCodeInput, setInviteCodeInput] = useState('');
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [pendingInvitations, setPendingInvitations] = useState<
    Array<{
      id: string;
      organizationId: string;
      organizationName?: string;
      inviterEmail?: string;
      role?: string | null;
      status: string;
    }>
  >([]);

  // Invite landing state
  const [inviteInfo, setInviteInfo] = useState<{
    id: string;
    organizationName?: string;
    inviterEmail?: string;
    email?: string;
    role?: string;
  } | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

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
          setInstanceInfo({ name: 'Bubai', authRequired: false, emailAndPasswordEnabled: true });
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
      const list = Array.isArray(res.data)
        ? (res.data as AuthOrgSummary[])
        : [];
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

  // Auto-load pending invitations for the signed-in user when they have 0 orgs (OnboardingSetup "Join existing" tab)
  useEffect(() => {
    if (!user || loadedOrgsForUserId !== user.id || organizations.length > 0) {
      setPendingInvitations([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await authClient.organization.listUserInvitations();
        if (cancelled) return;
        const rawList = Array.isArray(res.data)
          ? (res.data as Array<{
              id: string;
              organizationId: string;
              organizationName?: string;
              inviterEmail?: string;
              role?: string | null;
              status: string;
            }>)
          : [];
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
  }, [user?.id, loadedOrgsForUserId, organizations.length]);

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

  // Load invite details when on /invite/:id and signed in
  useEffect(() => {
    if (!inviteId || !user) return;
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
        const inv = res.data as {
          id: string;
          organizationName?: string;
          inviterEmail?: string;
          email?: string;
          role?: string;
        };
        setInviteInfo(inv);
      })
      .catch(() => {
        if (!cancelled) setInviteError('无法加载邀请信息');
      });
    return () => {
      cancelled = true;
    };
  }, [inviteId, user?.id]);

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
      await refetchSession();
      await refreshOrganizations();
      setOrgRevision((r) => r + 1);
    } catch (err) {
      setOnboardingError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setOnboardingBusy(false);
    }
  };

  const handleAcceptPendingInvite = async (invitationId: string) => {
    setOnboardingBusy(true);
    setOnboardingError(null);
    try {
      const res = await authClient.organization.acceptInvitation({ invitationId });
      if (res.error) {
        setOnboardingError(res.error.message || '接受邀请失败');
        return;
      }
      await refreshOrganizations();
      setOrgRevision((r) => r + 1);
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
    setOnboardingBusy(true);
    setOnboardingError(null);
    try {
      const res = await authClient.organization.acceptInvitation({ invitationId: extracted });
      if (res.error) {
        setOnboardingError(res.error.message || '接受邀请失败');
        return;
      }
      await refreshOrganizations();
      setOrgRevision((r) => r + 1);
    } catch (err) {
      setOnboardingError(err instanceof Error ? err.message : '接受邀请失败');
    } finally {
      setOnboardingBusy(false);
    }
  };

  const handleAcceptInviteLanding = async () => {
    if (!inviteId) return;
    setInviteBusy(true);
    setInviteError(null);
    try {
      const res = await authClient.organization.acceptInvitation({ invitationId: inviteId });
      if (res.error) {
        setInviteError(res.error.message || '接受邀请失败');
        return;
      }
      window.history.replaceState({}, '', '/');
      setInviteId(null);
      await refreshOrganizations();
      setOrgRevision((r) => r + 1);
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : '接受邀请失败');
    } finally {
      setInviteBusy(false);
    }
  };

  const handleRejectInviteLanding = async () => {
    if (!inviteId) return;
    setInviteBusy(true);
    try {
      await authClient.organization.rejectInvitation({ invitationId: inviteId });
      window.history.replaceState({}, '', '/');
      setInviteId(null);
    } finally {
      setInviteBusy(false);
    }
  };

  // While instance info is loading, avoid flashing workspace or sign-in
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

  // Legacy compatibility mode (Phase 1 default when BUBAI_AUTH_REQUIRED !== 'true')
  if (!instanceInfo.authRequired) {
    return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
  }

  // Cold boot: wait for session check and org list for current user before deciding
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

  // Unauthenticated -> Buzz-aligned AuthScreen
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

  // Authenticated on /device -> CLI Device Authorization confirmation
  if (deviceRouteActive) {
    const submitDeviceDecision = async (decision: 'approve' | 'deny') => {
      const cleanCode = deviceUserCode.trim().replace(/-/g, '').toUpperCase();
      if (!cleanCode) {
        setDeviceError('请输入终端显示的设备授权码');
        return;
      }
      setDeviceBusy(true);
      setDeviceError(null);
      try {
        const verifyRes = await authClient.device({ query: { user_code: cleanCode } });
        if (verifyRes.error) {
          setDeviceError(verifyRes.error.error_description || '设备授权码无效或已过期');
          return;
        }
        const res =
          decision === 'approve'
            ? await authClient.device.approve({ userCode: cleanCode })
            : await authClient.device.deny({ userCode: cleanCode });
        if (res.error) {
          setDeviceError(res.error.error_description || '设备授权操作失败，请检查授权码是否有效或已过期');
          return;
        }
        setDeviceOutcome(decision === 'approve' ? 'approved' : 'denied');
      } catch (err) {
        setDeviceError(err instanceof Error ? err.message : '设备授权操作失败');
      } finally {
        setDeviceBusy(false);
      }
    };

    return (
      <AuthContext.Provider value={contextValue}>
        <OnboardingScreen
          screenId="device"
          labelledBy="auth-device-title"
          intro={
            <>
              <div className={styles.brandHeader}>
                <img className={styles.brandIcon} src={bubaiLogoUrl} alt="" />
                <h1 id="auth-device-title" className="text-heading text-standard">
                  终端设备授权
                </h1>
              </div>
              <p className="text-body text-subtle">当前已登录为 {user.email}</p>
            </>
          }
        >
          <div className={styles.form}>
            {deviceOutcome ? (
              <>
                <div className={styles.inviteBox} data-device-outcome={deviceOutcome}>
                  <div>
                    <div className="text-label text-standard">
                      {deviceOutcome === 'approved' ? '设备授权已批准' : '已拒绝该设备授权'}
                    </div>
                    <div className="text-caption text-subtle">
                      {deviceOutcome === 'approved'
                        ? '你可以返回终端继续使用 BubAI CLI，或直接进入工作台。'
                        : '该授权码已作废，未向终端授予访问权限。'}
                    </div>
                  </div>
                </div>
                <Button
                  variant="primary"
                  data-auth-action="device-continue"
                  onClick={() => {
                    setDeviceRouteActive(false);
                    window.history.replaceState({}, '', '/');
                  }}
                >
                  进入工作台
                </Button>
              </>
            ) : (
              <>
                <label className={styles.fieldLabel}>
                  <span className="text-label text-standard">设备授权码</span>
                  <Input
                    value={deviceUserCode}
                    onChange={(e) => setDeviceUserCode(e.target.value.toUpperCase())}
                    placeholder="例如：ABCD-1234"
                    disabled={deviceBusy}
                    data-device-code-input=""
                  />
                </label>

                {deviceError && (
                  <p className={styles.errorText} role="alert" data-auth-error="">
                    {deviceError}
                  </p>
                )}

                <Button
                  variant="primary"
                  disabled={deviceBusy || !deviceUserCode.trim()}
                  data-auth-action="approve-device"
                  onClick={() => void submitDeviceDecision('approve')}
                >
                  {deviceBusy ? '处理中…' : '批准授权'}
                </Button>
                <Button
                  variant="outline"
                  disabled={deviceBusy || !deviceUserCode.trim()}
                  data-auth-action="deny-device"
                  onClick={() => void submitDeviceDecision('deny')}
                >
                  拒绝
                </Button>
              </>
            )}
          </div>
        </OnboardingScreen>
      </AuthContext.Provider>
    );
  }

  // Authenticated on /invite/:id -> InviteLanding
  if (inviteId) {
    return (
      <AuthContext.Provider value={contextValue}>
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
              onClick={() => void handleAcceptInviteLanding()}
            >
              {inviteBusy ? '加入中…' : '接受并进入工作台'}
            </Button>
            <Button
              variant="outline"
              disabled={inviteBusy}
              data-auth-action="reject-invite"
              onClick={() => void handleRejectInviteLanding()}
            >
              暂不加入
            </Button>
          </div>
        </OnboardingScreen>
      </AuthContext.Provider>
    );
  }

  // Authenticated with 0 organizations -> OnboardingSetup
  if (organizations.length === 0) {
    return (
      <AuthContext.Provider value={contextValue}>
        <OnboardingScreen
          screenId="onboarding"
          labelledBy="auth-onboarding-title"
          intro={
            <>
              <h1 id="auth-onboarding-title" className="text-heading text-standard">
                欢迎，{user.name.trim() || user.email.split('@')[0] || user.email}
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
                    <span className={styles.fieldLabel}>
                      发给 {user.email} 的待处理邀请
                    </span>
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
                          onClick={() => void handleAcceptPendingInvite(inv.id)}
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
                onClick={() => void signOut()}
              >
                退出登录（{user.email}）
              </button>
            </div>
          </div>
        </OnboardingScreen>
      </AuthContext.Provider>
    );
  }

  // Authenticated & has org -> Render Workspace (keep mounted + inert under SessionExpiredOverlay!)
  return (
    <AuthContext.Provider value={contextValue}>
      {sessionExpired &&
        createPortal(
          <div className={styles.topLayerOverlay}>
            <OnboardingScreen
              screenId="session-expired"
              labelledBy="auth-expired-title"
              intro={
                <>
                  <h1 id="auth-expired-title" className="text-heading text-standard">
                    会话已过期
                  </h1>
                  <p className="text-body text-subtle">
                    为保护你的内容，请重新验证身份。你当前的草稿与浏览位置已保留。
                  </p>
                </>
              }
            >
              <AuthForm
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
            </OnboardingScreen>
          </div>,
          document.body,
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
