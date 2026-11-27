import { constants } from 'node:fs';
import { mkdtemp, mkdir, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BotTurnRequestedEvent, BubaiClient } from '@buzz-botmux/chat-client';

const MAX_BYTES = 64 * 1024 * 1024;
export type LocalArtifact = { path: string; name?: string; mimeType?: string };
export type TurnFiles = { root: string; inputs: string[]; output: string; artifacts: LocalArtifact[] };

export async function withTurnFiles<T>(
  event: BotTurnRequestedEvent,
  sdk: BubaiClient,
  signal: AbortSignal,
  run: (files: TurnFiles) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'bub-turn-'));
  try {
    const files: TurnFiles = { root, inputs: [], output: path.join(root, 'output'), artifacts: [] };
    await mkdir(files.output);
    let remaining = MAX_BYTES;
    const inputs = event.triggerMessage.attachments;
    if (inputs.length > 16) throw new Error('Too many input attachments');
    for (const item of inputs) {
      if (item.size > remaining) throw new Error('Input attachments exceed 64 MiB');
      const target = path.join(root, files.inputs.length + '-' + path.basename(item.name).slice(-120));
      const stream = await sdk.downloadTurnAttachment(
        event.replyTarget.messageId,
        event.triggerMessage.id,
        item,
        signal,
      );
      const handle = await open(target, 'wx', 0o600);
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          remaining -= value.length;
          if (remaining < 0) throw new Error('Input attachments exceed 64 MiB');
          await handle.writeFile(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        await handle.close();
      }
      files.inputs.push(target);
    }
    return await run(files);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function readArtifact(files: TurnFiles, artifact: LocalArtifact, limit = MAX_BYTES) {
  const source = await realpath(path.resolve(files.output, artifact.path));
  const output = path.join(await realpath(files.root), 'output');
  if (!source.startsWith(output + path.sep)) throw new Error('Artifact must be in the turn output directory');
  const fd = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit)
      throw new Error('Invalid artifact or size limit exceeded');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await fd.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('Artifact changed during upload');
      offset += bytesRead;
    }
    const types: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.txt': 'text/plain',
      '.pdf': 'application/pdf',
    };
    return new File([bytes], path.basename(artifact.name || source), {
      type: artifact.mimeType || types[path.extname(source).toLowerCase()] || 'application/octet-stream',
    });
  } finally {
    await fd.close();
  }
}

export async function uploadArtifacts(
  files: TurnFiles,
  sdk: BubaiClient,
  turnId: string,
  signal: AbortSignal,
) {
  const uploaded = [];
  let remaining = MAX_BYTES;
  for (const artifact of files.artifacts) {
    signal.throwIfAborted();
    const file = await readArtifact(files, artifact, remaining);
    remaining -= file.size;
    const data = new FormData();
    data.set('file', file);
    for (let attempt = 0; ; attempt++) {
      try {
        uploaded.push(await sdk.uploadFile(data, { turnId, signal }));
        break;
      } catch (err) {
        if (attempt >= 2 || signal.aborted) throw err;
      }
    }
  }
  return uploaded;
}
