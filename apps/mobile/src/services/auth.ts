export interface MobileAuthUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

export interface MobileAuthOrg {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
}

export interface MobileAuthSession {
  token: string;
  user: MobileAuthUser;
  activeOrganizationId: string | null;
}

const MOBILE_ORIGIN = 'bubai://';

function cleanBaseUrl(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/, '');
}

class AuthHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function authRequest<T>(
  serverUrl: string,
  path: string,
  opts: {
    method?: 'GET' | 'POST';
    token?: string;
    body?: Record<string, unknown>;
  } = {},
): Promise<{ data: T; headers: Headers }> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Origin: MOBILE_ORIGIN,
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
  };

  const res = await fetch(`${cleanBaseUrl(serverUrl)}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers,
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const msg =
      typeof parsed === 'object' && parsed !== null
        ? String(
            (parsed as { message?: unknown; error?: unknown }).message ||
              (parsed as { error?: unknown }).error ||
              `HTTP ${res.status}`,
          )
        : `HTTP ${res.status}`;
    throw new AuthHttpError(res.status, msg);
  }

  return { data: parsed as T, headers: res.headers };
}

function normalizeUser(raw: {
  id: string;
  name?: string | null;
  email: string;
  image?: string | null;
}): MobileAuthUser {
  return {
    id: raw.id,
    email: raw.email,
    name: raw.name?.trim() || raw.email.split('@')[0] || raw.email,
    image: raw.image ?? null,
  };
}

export async function mobileSendEmailOtp(serverUrl: string, email: string): Promise<void> {
  await authRequest(serverUrl, '/api/auth/email-otp/send-verification-otp', {
    method: 'POST',
    body: { email: email.trim(), type: 'sign-in' },
  });
}

export async function mobileSignInWithEmailOtp(
  serverUrl: string,
  email: string,
  otp: string,
): Promise<MobileAuthSession> {
  const { data, headers } = await authRequest<{
    token?: string;
    user: { id: string; name?: string | null; email: string; image?: string | null };
  }>(serverUrl, '/api/auth/sign-in/email-otp', {
    method: 'POST',
    body: { email: email.trim(), otp: otp.trim() },
  });
  const token = headers.get('set-auth-token') || data.token || '';
  if (!token) {
    throw new Error('Server did not return a Bearer session token');
  }
  return {
    token,
    user: normalizeUser(data.user),
    activeOrganizationId: null,
  };
}

export async function mobileSignInWithPassword(
  serverUrl: string,
  email: string,
  password: string,
): Promise<MobileAuthSession> {
  const { data, headers } = await authRequest<{
    token?: string;
    user: { id: string; name?: string | null; email: string; image?: string | null };
  }>(serverUrl, '/api/auth/sign-in/email', {
    method: 'POST',
    body: { email: email.trim(), password },
  });
  const token = headers.get('set-auth-token') || data.token || '';
  if (!token) {
    throw new Error('Server did not return a Bearer session token');
  }
  return {
    token,
    user: normalizeUser(data.user),
    activeOrganizationId: null,
  };
}

export async function mobileSignUpWithPassword(
  serverUrl: string,
  email: string,
  password: string,
  name: string,
): Promise<MobileAuthSession | null> {
  const { data, headers } = await authRequest<{
    token?: string;
    user: { id: string; name?: string | null; email: string; image?: string | null };
  }>(serverUrl, '/api/auth/sign-up/email', {
    method: 'POST',
    body: { email: email.trim(), password, name: name.trim() },
  });
  const token = headers.get('set-auth-token') || data.token || '';
  if (!token) {
    return null;
  }
  return {
    token,
    user: normalizeUser(data.user),
    activeOrganizationId: null,
  };
}

export async function mobileGetSession(
  serverUrl: string,
  token: string,
): Promise<MobileAuthSession | null> {
  if (!token.trim()) return null;
  try {
    const { data } = await authRequest<{
      user?: { id: string; name?: string | null; email: string; image?: string | null };
      session?: { activeOrganizationId?: string | null };
    } | null>(serverUrl, '/api/auth/get-session', {
      method: 'GET',
      token,
    });
    if (data === null) return null;
    if (!data.user?.id) throw new Error('Invalid session response');
    return {
      token,
      user: normalizeUser(data.user),
      activeOrganizationId: data.session?.activeOrganizationId ?? null,
    };
  } catch (error) {
    if (error instanceof AuthHttpError && error.status === 401) return null;
    throw error;
  }
}

export async function mobileSignOut(serverUrl: string, token: string): Promise<void> {
  if (!token.trim()) return;
  await authRequest(serverUrl, '/api/auth/sign-out', {
    method: 'POST',
    token,
    body: {},
  }).catch(() => {});
}

export async function mobileListOrganizations(
  serverUrl: string,
  token: string,
): Promise<MobileAuthOrg[]> {
  const { data } = await authRequest<MobileAuthOrg[]>(
    serverUrl,
    '/api/auth/organization/list',
    { method: 'GET', token },
  );
  if (!Array.isArray(data)) throw new Error('Invalid organization list');
  return data;
}

export async function mobileCreateOrganization(
  serverUrl: string,
  token: string,
  name: string,
  slug?: string,
): Promise<MobileAuthOrg> {
  const baseSlug =
    slug?.trim() ||
    `${name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'community'}-${Math.random().toString(36).slice(2, 6)}`;
  const { data } = await authRequest<MobileAuthOrg>(
    serverUrl,
    '/api/auth/organization/create',
    {
      method: 'POST',
      token,
      body: { name: name.trim(), slug: baseSlug },
    },
  );
  return data;
}

export async function mobileSetActiveOrganization(
  serverUrl: string,
  token: string,
  organizationId: string,
): Promise<void> {
  await authRequest(serverUrl, '/api/auth/organization/set-active', {
    method: 'POST',
    token,
    body: { organizationId },
  });
}

export async function mobileDeviceDecision(server: string, token: string, rawCode: string, approve: boolean) {
  const userCode = rawCode.trim().replace(/-/g, '').toUpperCase();
  await authRequest(server, '/api/auth/device?user_code=' + encodeURIComponent(userCode), { token });
  await authRequest(server, '/api/auth/device/' + (approve ? 'approve' : 'deny'), { token, body: { userCode } });
}

export async function mobileGetInvite(server: string, token: string, id: string) {
  const { data } = await authRequest<{ organizationName: string; email: string }>(
    server, '/api/auth/organization/get-invitation?id=' + encodeURIComponent(id), { token });
  return data;
}

export async function mobileInviteDecision(server: string, token: string, invitationId: string, accept: boolean) {
  await authRequest(server, '/api/auth/organization/' + (accept ? 'accept-invitation' : 'reject-invitation'), {
    token, body: { invitationId },
  });
}

export interface CommunityRoster {
  members: { id: string; userId: string; role: string; user: MobileAuthUser }[];
  invitations: { id: string; email: string; status: string }[];
}

export async function mobileCommunityRoster(server: string, token: string, organizationId: string) {
  const { data } = await authRequest<CommunityRoster>(
    server, '/api/auth/organization/get-full-organization?organizationId=' + encodeURIComponent(organizationId), { token },
  );
  return data;
}

export async function mobileInviteMember(server: string, token: string, organizationId: string, email: string) {
  const { data } = await authRequest<{ id: string }>(server, '/api/auth/organization/invite-member', {
    token, body: { organizationId, email: email.trim(), role: 'member' },
  });
  return data;
}

export async function mobileCancelInvitation(server: string, token: string, invitationId: string) {
  await authRequest(server, '/api/auth/organization/cancel-invitation', { token, body: { invitationId } });
}

export async function mobileRemoveMember(server: string, token: string, organizationId: string, memberId: string) {
  await authRequest(server, '/api/auth/organization/remove-member', { token, body: { organizationId, memberIdOrEmail: memberId } });
}

export async function mobileSetMemberRole(server: string, token: string, organizationId: string, memberId: string, role: 'admin' | 'member') {
  await authRequest(server, '/api/auth/organization/update-member-role', { token, body: { organizationId, memberId, role } });
}
