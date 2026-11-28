const response = http.get(OPEN_SERVER + '/api/bootstrap?userId=u-owner');
if (response.status !== 200) throw new Error('Test workspace unavailable');
output.discussion = JSON.parse(response.body).channels.find(ch => ch.name === 'native-discussion').id;
const page = http.get(OPEN_SERVER + '/api/channels/' + output.discussion + '/messages?userId=u-owner');
output.root = JSON.parse(page.body).messages.find(m => m.content.indexOf('Native review') >= 0).id;
