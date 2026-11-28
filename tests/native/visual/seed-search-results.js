const stamp = Date.now();
output.channelHit = 'Channel needle ' + stamp;
output.threadHit = 'Thread needle ' + stamp;
function post(content, threadId) {
  const result = http.post(OPEN_SERVER + '/api/bot/messages', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botId: 'local-e2e', channelId: output.discussion, threadId, content }),
  });
  if (result.status >= 300) throw Error('Cannot seed search target history');
  return JSON.parse(result.body).message.id;
}
// Keep the channel hit outside the initial 50-message page and the thread hit
// below the first viewport, so a correct route alone cannot pass this test.
output.channelResultId = post(output.channelHit);
for (let i = 0; i < 51; i++) post('Channel context ' + i);
for (let i = 0; i < 22; i++) post('Thread context ' + i, output.root);
output.threadResultId = post(output.threadHit, output.root);
for (let i = 0; i < 15; i++) post('Later reply ' + i, output.root);
