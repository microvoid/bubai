import { expect, test } from 'bun:test';
import { mobileGetSession, mobileListOrganizations } from '../../apps/mobile/src/services/auth';

async function withResponse(body: unknown, status: number, run: (url: string) => Promise<void>) {
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: () => Response.json(body, { status }),
  });
  try {
    await run(server.url.href);
  } finally {
    await server.stop(true);
  }
}

test('a temporary server outage does not invalidate the mobile session', () =>
  withResponse({}, 503, async url => {
    await expect(mobileGetSession(url, 'fixture')).rejects.toThrow();
  }));

test('an expired session requires sign-in', () =>
  withResponse({}, 401, async url => {
    expect(await mobileGetSession(url, 'fixture')).toBeNull();
  }));

test('an invalid organization response cannot start community creation', () =>
  withResponse({}, 200, async url => {
    await expect(mobileListOrganizations(url, 'fixture')).rejects.toThrow();
  }));
