import { expect, test } from 'bun:test';
import { MessageDisconnectedError, MessageUnconfirmedError, UploadHttpError, type MessageAttachment } from '../../packages/chat-client/src';
import { deliveryAfterError, drainOutbox } from '../../apps/mobile/src/store/drainOutbox';
import type { OutboxEntry, OutgoingMessage } from '../../apps/mobile/src/store/outbox';

const room = { messageId: 'same-id', channelId: 'room', content: '' };
const files = ['one', 'two'].map(id => ({ id, name: id + '.png', mimeType: 'image/png' }));
const uploaded = (id: string): MessageAttachment => ({ ...files[0], id, url: '/api/uploads/' + id, size: 4 });

function memoryOutbox(entries: OutboxEntry[]) {
  return {
    entries: () => entries,
    checkpoint: (id: string, patch: Partial<OutboxEntry>) => {
      const item = entries.find(entry => entry.messageId === id);
      if (item) Object.assign(item, patch);
    },
    settle: () => {},
  };
}

test('offline attachment upload resumes at the first unuploaded file after restart', async () => {
  const item: OutboxEntry = { ...room, stagedAttachments: files };
  const storage = memoryOutbox([item]);
  const first = drainOutbox({
    ...storage,
    upload: async file => {
      if (file.id === 'two') throw new UploadHttpError(503);
      return uploaded(file.id);
    },
    transmit: async () => { throw Error('Must finish uploading before sending'); },
  });
  try {
    expect(await first.attempt(item.messageId)).toBe('queued');
    expect(item.delivery).toBe('queued');
    expect(item.uploaded).toEqual([uploaded('one')]);
  } finally { first.close(); }

  const uploads: string[] = [];
  const messages: OutgoingMessage[] = [];
  const resumed = drainOutbox({
    ...storage,
    upload: async file => { uploads.push(file.id); return uploaded(file.id); },
    transmit: async message => { messages.push(message); },
  });
  try {
    expect(await resumed.attempt(item.messageId)).toBe('sent');
    expect(uploads).toEqual(['two']);
    expect(messages).toHaveLength(1);
    expect(messages[0].messageId).toBe(item.messageId);
    expect(messages[0].attachments).toEqual([uploaded('one'), uploaded('two')]);
    expect(messages[0].stagedAttachments).toBeUndefined();
  } finally { resumed.close(); }
});

test('an uncertain receipt stays pending and restart replays the identical message and upload IDs', async () => {
  const storage = memoryOutbox([{ ...room, stagedAttachments: files }]);
  const attempts: OutgoingMessage[] = [];
  let uploads = 0;
  const driver = {
    ...storage,
    upload: async (file: typeof files[number]) => { uploads++; return uploaded(file.id); },
    transmit: async (message: OutgoingMessage) => {
      attempts.push(message);
      if (attempts.length === 1) throw new MessageUnconfirmedError();
    },
  };
  const first = drainOutbox(driver);
  try {
    expect(await first.attempt(room.messageId)).toBe('confirming');
    expect(storage.entries()[0].delivery).toBe('confirming');
  } finally { first.close(); }
  const next = drainOutbox(driver);
  try {
    expect(await next.attempt(room.messageId)).toBe('sent');
    expect(attempts[0]).toEqual(attempts[1]);
    expect(uploads).toBe(files.length);
  } finally { next.close(); }
});

test('only permanent upload errors and explicit send rejections require user intervention', () => {
  expect(deliveryAfterError(new MessageDisconnectedError())).toBe('queued');
  expect(deliveryAfterError(new TypeError('Network request failed'))).toBe('queued');
  expect(deliveryAfterError(new UploadHttpError(429))).toBe('queued');
  expect(deliveryAfterError(new UploadHttpError(413))).toBe('failed');
  expect(deliveryAfterError(new Error('This channel is archived.'))).toBe('failed');
});
