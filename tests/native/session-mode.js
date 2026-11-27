const response = http.post(TARGET + '/test/session-mode', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: MODE }),
});
if (response.status !== 200) throw new Error('Fixture session-mode change failed');
