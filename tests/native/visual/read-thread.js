const channel = OPEN_SERVER + '/api/channels/' + output.discussion;
for (const path of ['/read', '/threads/' + output.root + '/read']) {
  const response = http.post(channel + path, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'u-owner' }),
  });
  if (response.status !== 200) throw new Error('Unable to normalize fixture read state at ' + path);
}
