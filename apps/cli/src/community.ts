export interface CliCommunity {
  id: string;
  name: string;
  slug: string;
}

function normalizeBaseUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, '');
}

export async function listCommunities(serverUrl: string, token: string): Promise<CliCommunity[]> {
  const res = await fetch(`${normalizeBaseUrl(serverUrl)}/api/auth/organization/list`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to list communities (HTTP ${res.status}): ${text || res.statusText}`);
  }
  const body = (await res.json().catch(() => [])) as
    | CliCommunity[]
    | { organizations?: CliCommunity[]; data?: CliCommunity[] };
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.organizations)) return body.organizations;
  if (Array.isArray(body.data)) return body.data;
  return [];
}

export async function setActiveCommunity(
  serverUrl: string,
  token: string,
  organizationId: string,
): Promise<void> {
  const res = await fetch(`${normalizeBaseUrl(serverUrl)}/api/auth/organization/set-active`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ organizationId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to set active community (HTTP ${res.status}): ${text || res.statusText}`);
  }
}

export function matchCommunity(communities: CliCommunity[], ref: string): CliCommunity | undefined {
  const trimmed = ref.trim();
  const lower = trimmed.toLowerCase();
  return (
    communities.find((c) => c.id === trimmed || c.slug === trimmed || c.name === trimmed) ??
    communities.find((c) => c.slug.toLowerCase() === lower || c.name.toLowerCase() === lower)
  );
}

export type ResolveCommunityResult =
  | { status: 'activated'; community: CliCommunity; communities: CliCommunity[] }
  | { status: 'multiple'; communities: CliCommunity[] }
  | { status: 'none'; communities: CliCommunity[] };

export async function resolveAndActivateCommunity(
  serverUrl: string,
  token: string,
  requestedRef?: string,
): Promise<ResolveCommunityResult> {
  const communities = await listCommunities(serverUrl, token);
  if (requestedRef) {
    const matched = matchCommunity(communities, requestedRef);
    if (!matched) {
      const available =
        communities.length > 0
          ? communities.map((c) => `${c.name} (${c.slug})`).join(', ')
          : 'none';
      throw new Error(`Community "${requestedRef}" not found. Available communities: ${available}`);
    }
    await setActiveCommunity(serverUrl, token, matched.id);
    return { status: 'activated', community: matched, communities };
  }

  if (communities.length === 1) {
    const only = communities[0]!;
    await setActiveCommunity(serverUrl, token, only.id);
    return { status: 'activated', community: only, communities };
  }

  if (communities.length > 1) {
    return { status: 'multiple', communities };
  }

  return { status: 'none', communities };
}
