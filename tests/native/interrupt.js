const response = http.post(FAULT_SERVER + '/test/interrupt', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ thread: STAGE === 'thread' }),
});
if (response.status !== 200) throw new Error('Fixture interruption failed');
output.missedMessage = json(response.body).content;
