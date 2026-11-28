const page = http.get(OPEN_SERVER + '/api/channels/' + output.discussion + '/messages?userId=u-owner');
const human = JSON.parse(page.body).messages.filter(message => message.senderRole === 'human');
if (human.length !== 1 || human[0].attachments.length !== 1)
  throw Error('Expected exactly one message containing one attachment');
const asset = human[0].attachments[0];
if (asset.name !== 'Bubai-QA-icon.png' || !asset.url.startsWith('/api/uploads/') || !asset.size)
  throw Error('The selected attachment is missing from the server');
if (http.get(OPEN_SERVER + asset.url).status !== 200) throw Error('Uploaded attachment unavailable');
