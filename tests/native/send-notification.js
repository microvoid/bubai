const response = http.post(NOTIFICATION_SERVER + '/' + KIND, { body: '' });
if (response.status !== 200) throw new Error('simctl could not deliver the fixture notification');
