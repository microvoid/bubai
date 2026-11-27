import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatReplyPreview } from '../../apps/web/src/features/messages/BuzzChannelTimeline';
import type { ChatMessage } from '../../apps/web/src/features/messages/types';

function makeReply(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm-1',
    channelId: 'ch-1',
    threadId: 'root-1',
    senderId: 'bot-1',
    senderRole: 'agent',
    content: '',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('formatReplyPreview', () => {
  it('shows activeLabel when running with progress', () => {
    const res = formatReplyPreview(
      makeReply({
        card: {
          title: 'Local Gemini 4 Neon',
          status: 'running',
          phase: 'thinking',
          progress: {
            activeLabel: '读取 BuzzChannelTimeline.tsx',
            toolCount: 1,
            steps: [],
          },
        },
      }),
    );
    assert.deepEqual(res, {
      text: '思考中 · 读取 BuzzChannelTimeline.tsx',
      status: 'running',
    });
  });

  it('shows connecting status when running with phase connecting and no activeLabel', () => {
    const res = formatReplyPreview(
      makeReply({
        card: {
          title: 'Local Gemini 4 Neon',
          status: 'running',
          phase: 'connecting',
        },
      }),
    );
    assert.deepEqual(res, { text: '连接中…', status: 'running' });
  });

  it('shows thinking status when running without activeLabel', () => {
    const res = formatReplyPreview(
      makeReply({
        card: {
          title: 'Local Gemini 4 Neon',
          status: 'running',
          phase: 'thinking',
        },
      }),
    );
    assert.deepEqual(res, { text: '思考中…', status: 'running' });
  });

  it('shows failed status and omits internal botmux trigger summary', () => {
    const withInternalSummary = formatReplyPreview(
      makeReply({
        card: {
          title: 'Local Gemini 4 Neon',
          status: 'failed',
          summary: 'botmux:trig-123',
        },
      }),
    );
    assert.deepEqual(withInternalSummary, { text: '执行失败', status: 'failed' });

    const withReason = formatReplyPreview(
      makeReply({
        card: {
          title: 'Local Gemini 4 Neon',
          status: 'failed',
          summary: 'API timeout',
        },
      }),
    );
    assert.deepEqual(withReason, { text: '执行失败 · API timeout', status: 'failed' });

    const interrupted = formatReplyPreview(
      makeReply({
        card: {
          title: 'Local Gemini 4 Neon',
          status: 'interrupted',
        },
      }),
    );
    assert.deepEqual(interrupted, { text: '已中断', status: 'failed' });
  });

  it('uses content or attachment names when completed and never falls back to card.title', () => {
    assert.deepEqual(
      formatReplyPreview(
        makeReply({
          content: '已修复\n  并验证通过',
          card: { title: 'Local Gemini 4 Neon', status: 'completed' },
        }),
      ),
      { text: '已修复 并验证通过' },
    );

    assert.deepEqual(
      formatReplyPreview(
        makeReply({
          content: '',
          attachments: [
            { id: 'a1', name: 'report.png', mimeType: 'image/png', size: 123, url: '/u/a1' },
          ],
          card: { title: 'Local Gemini 4 Neon', status: 'completed' },
        }),
      ),
      { text: 'report.png' },
    );

    assert.deepEqual(
      formatReplyPreview(
        makeReply({
          content: '',
          card: { title: 'Local Gemini 4 Neon', status: 'completed' },
        }),
      ),
      { text: 'Message' },
    );
  });
});
