// Run alongside the native workspace fixture with its DISCUSSION/ROOT_MESSAGE and the iOS test UDID.
const { SIMULATOR_ID, DISCUSSION, ROOT_MESSAGE } = process.env;
if (!SIMULATOR_ID || !DISCUSSION || !ROOT_MESSAGE)
  throw new Error('Set SIMULATOR_ID, DISCUSSION and ROOT_MESSAGE');
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const kind = new URL(request.url).pathname.slice(1);
    if (request.method !== 'POST' || !['channel', 'thread'].includes(kind))
      return new Response(null, { status: 404 });
    const payload = {
      aps: { alert: { title: 'Bubai notification test', body: 'Open ' + kind } },
      body: {
        channelId: DISCUSSION,
        ...(kind === 'thread' ? { threadId: ROOT_MESSAGE } : {}),
        messageId: ROOT_MESSAGE,
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
