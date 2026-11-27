import assert from 'node:assert/strict';

export async function accountLink(readMail: () => string, email: string, kind: 'verify' | 'reset') {
  const prefix = `[bubai-auth][${kind}] email=${email} url=`;
  for (let i = 0; i < 100; i++) {
    const line = readMail().split('\n').findLast(line => line.startsWith(prefix));
    if (line) return line.slice(prefix.length).trim();
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the local account email');
}

export async function registerTestUser(base: string, email: string, name: string, password: string, readMail: () => string) {
  const headers = { 'Content-Type': 'application/json', Origin: base };
  const signup = await fetch(base + '/api/auth/sign-up/email', {
    method: 'POST', headers, body: JSON.stringify({ email, name, password }),
  });
  assert.equal(signup.status, 200);
  assert.equal(signup.headers.get('set-auth-token'), null);
  const link = await accountLink(readMail, email, 'verify');
  assert.equal(new URL(link).origin, base);
  const verified = await fetch(link, { redirect: 'manual' });
  assert.ok(verified.ok || verified.status === 302);
  return fetch(base + '/api/auth/sign-in/email', {
    method: 'POST', headers, body: JSON.stringify({ email, password }),
  });
}
