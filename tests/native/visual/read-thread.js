const response = http.post(OPEN_SERVER + '/api/channels/' + output.discussion + '/threads/' + output.root + '/read', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId: 'u-owner' }),
});
if (response.status !== 200) throw new Error('Unable to normalize the fixture read marker');
