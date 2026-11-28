import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUploadStorage } from './storage';

test('uploaded media serves the Safari probe, seeks, and full downloads', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bubai-media-'));
  const previous = { UPLOAD_DIR: process.env.UPLOAD_DIR, S3_BUCKET: process.env.S3_BUCKET };
  try {
    delete process.env.S3_BUCKET;
    process.env.UPLOAD_DIR = dir;
    const storage = createUploadStorage();
    const name = 'clip.mp4';
    await storage.put(name, Uint8Array.from([0, 1, 2, 3, 4]).buffer, 'video/mp4');
    using server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        return (await storage.get(name, request.headers.get('Range') ?? undefined))!;
      },
    });
    for (const [range, contentRange, bytes] of [
      ['bytes=0-1', 'bytes 0-1/5', [0, 1]],
      ['bytes=3-', 'bytes 3-4/5', [3, 4]],
      ['bytes=-2', 'bytes 3-4/5', [3, 4]],
      ['bytes=2-99', 'bytes 2-4/5', [2, 3, 4]],
    ] as const) {
      const res = await fetch(server.url, { headers: { Range: range }, signal: AbortSignal.timeout(3000) });
      expect(res.status).toBe(206);
      expect(res.headers.get('Content-Range')).toBe(contentRange);
      expect(res.headers.get('Content-Length')).toBe(String(bytes.length));
      expect(res.headers.get('Content-Type')).toBe('video/mp4');
      expect(Array.from(await res.bytes())).toEqual([...bytes]);
    }
    const invalid = (await storage.get(name, 'bytes=5-'))!;
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get('Content-Range')).toBe('bytes */5');
    const full = (await storage.get(name))!;
    expect(full.status).toBe(200);
    expect(full.headers.get('Accept-Ranges')).toBe('bytes');
    expect(Array.from(await full.bytes())).toEqual([0, 1, 2, 3, 4]);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
