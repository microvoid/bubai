const headers = { 'Content-Type': 'application/json' };
const created = http.post(OPEN_SERVER + '/api/channels', {
  headers,
  body: JSON.stringify({ userId: 'u-owner', name: 'mobile-check-' + Date.now() }),
});
if (created.status >= 300) throw Error('Cannot create an isolated test channel');
output.discussion = JSON.parse(created.body).channel.id;
const root = http.post(OPEN_SERVER + '/api/bot/messages', {
  headers,
  body: JSON.stringify({ botId: 'local-e2e', channelId: output.discussion, content: 'Interaction check' }),
});
if (root.status >= 300) throw Error('Cannot create the root message');
output.root = JSON.parse(root.body).message.id;
