// Run alongside the native workspace fixture with its DISCUSSION/ROOT_MESSAGE and the iOS test UDID.
import { seedNotificationWorkspaces } from './notification-workspaces';

const { SIMULATOR_ID, DISCUSSION, ROOT_MESSAGE, AUTH_SERVER, TEST_EMAIL, TEST_PASSWORD } = process.env;
if (!SIMULATOR_ID || !DISCUSSION || !ROOT_MESSAGE)
  throw new Error('Set SIMULATOR_ID, DISCUSSION and ROOT_MESSAGE');
const scoped = process.argv.includes('--cross-community');
if (scoped && !(AUTH_SERVER && TEST_EMAIL && TEST_PASSWORD))
  throw new Error('Export AUTH_SERVER, TEST_EMAIL and TEST_PASSWORD from the disposable native fixture');
const workspace = scoped ? await seedNotificationWorkspaces(AUTH_SERVER!, TEST_EMAIL!, TEST_PASSWORD!) : undefined;
if (workspace) console.log('ORG_A=' + workspace.source);
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const kind = new URL(request.url).pathname.slice(1);
    if (request.method !== 'POST' || !(kind === 'channel' || kind === 'thread' || (workspace && kind === 'missing')))
      return new Response(null, { status: 404 });
    const payload = {
      aps: { alert: { title: 'Bubai notification test', body: 'Open ' + kind } },
      body: {
        ...(workspace && { organizationId: kind === 'missing' ? 'missing-community' : workspace.target }),
        channelId: workspace?.channel ?? DISCUSSION,
        ...(kind === 'thread' ? { threadId: workspace?.root ?? ROOT_MESSAGE } : {}),
        messageId: (kind === 'thread' ? workspace?.reply : workspace?.root) ?? ROOT_MESSAGE,
      },
    };
    const push = Bun.spawn(['xcrun', 'simctl', 'push', SIMULATOR_ID!, 'com.bubai.app.dev', '-'], {
      stdin: new Blob([JSON.stringify(payload)]),
    });
    if ((await push.exited) !== 0) return new Response(null, { status: 500 });
    // simctl returns before SpringBoard finishes presenting the tappable banner.
    await Bun.sleep(1200);
    return new Response(null, { status: 200 });
  },
});
console.log('NOTIFICATION_SERVER=' + server.url.origin);
