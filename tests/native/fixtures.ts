// Starts disposable HTTP/WS backends for the iOS Maestro suite.
import { mkdtempSync, mkdirSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { registerTestUser } from '../e2e/account-mailbox';
import { networkFixture } from './network-fixture';
import { seedNativeWorkspace } from './seed-workspace';

const root = mkdtempSync(join(tmpdir(), 'bubai-native-fixtures-'));
const children: ReturnType<typeof Bun.spawn>[] = [];
const openPort = Number(process.env.NATIVE_OPEN_PORT || 4291);
const authPort = Number(process.env.NATIVE_AUTH_PORT || 4292);
let strictProxy: ReturnType<typeof networkFixture> | undefined;
let faultProxy: ReturnType<typeof networkFixture> | undefined;
async function stop() {
  await strictProxy?.stop(true);
  await faultProxy?.stop(true);
  for (const child of children) child.kill();
  await Promise.all(children.map((child) => child.exited));
  rmSync(root, { recursive: true, force: true });
}
async function start(port: number, authRequired: boolean) {
  const url = `http://127.0.0.1:${port}`;
  const cwd = join(root, String(port));
  mkdirSync(cwd);
  const logPath = join(cwd, 'server.log');
  const log = openSync(logPath, 'w');
  const child = Bun.spawn(['bun', resolve(import.meta.dir, '../../apps/server/src/main.ts')], {
    cwd,
    stdout: log,
    stderr: 'inherit',
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: '',
      BUZZ_BOT_TOKEN: '',
      BETTER_AUTH_URL: url,
      BETTER_AUTH_SECRET: crypto.randomUUID(),
      BUBAI_AUTH_REQUIRED: String(authRequired),
      BUBAI_EMAIL_PASSWORD_ENABLED: 'true',
      BOTMUX_ENDPOINT: 'http://127.0.0.1:19998',
      EMAIL_FROM: '',
      CLOUDFLARE_ACCOUNT_ID: '',
      CLOUDFLARE_EMAIL_API_TOKEN: '',
    },
  });
  closeSync(log);
  children.push(child);
  // Read the child's own startup line before sending any requests to this port.
  for (let n = 0; n < 200; n++) {
    if (child.exitCode !== null) throw new Error(`Fixture server exited on port ${port}`);
    if (readFileSync(logPath, 'utf8').includes('server listening on')) return { url, logPath };
    await Bun.sleep(100);
  }
  throw new Error('Fixture startup timed out');
}
try {
  const open = await start(openPort, false);
  const strict = await start(authPort, true);
  const workspace = await seedNativeWorkspace(open.url);
  faultProxy = networkFixture(open.url, workspace.DISCUSSION, workspace.ROOT_MESSAGE);
  strictProxy = networkFixture(strict.url, workspace.DISCUSSION, workspace.ROOT_MESSAGE);
  console.log('AUTH_FAULT_SERVER=' + strictProxy.url.origin);
  console.log('FAULT_SERVER=' + faultProxy.url.origin);
  for (const [key, value] of Object.entries(workspace)) console.log(key + '=' + value);
  const response = await registerTestUser(
    strict.url,
    'native-ui@example.test',
    'Native Test',
    'Demo-password-1234',
    () => readFileSync(strict.logPath, 'utf8'),
  );
  if (!response.ok) throw new Error('Fixture sign-in failed');
  console.log(
    `OPEN_SERVER=${open.url}\nAUTH_SERVER=${strict.url}\nTEST_EMAIL=native-ui@example.test\nTEST_PASSWORD=Demo-password-1234`,
  );
  await new Promise<void>((done) => {
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
} finally {
  await stop();
}
