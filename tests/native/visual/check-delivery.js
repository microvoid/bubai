const result = http.get(OPEN_SERVER + '/api/channels/' + output.discussion + '/messages?userId=u-owner');
const received = JSON.parse(result.body).messages.filter(message => message.content === output.offline);
if (received.length !== 1) throw new Error('Expected exactly one acknowledged offline message');
