/**
 * Upload storage adapter for Bubai server.
 *
 * Uses Bun's native S3Client when S3_BUCKET + credentials are configured
 * (works with AWS S3, Cloudflare R2, MinIO, RustFS, Aliyun OSS, Volcengine TOS, etc.).
 * Automatically falls back to local disk (.data/uploads or UPLOAD_DIR) for zero-config local dev.
 */
import fs from 'node:fs';
import path from 'node:path';
import { S3Client } from 'bun';

export interface UploadStorage {
  driver: 's3' | 'local';
  detail: string;
  put(storedName: string, bytes: ArrayBuffer, mimeType: string): Promise<{ url: string }>;
  get(storedName: string, range?: string): Promise<Response | null>;
}

function fileResponse(file: Blob, size: number, type: string, range: string | undefined, driver: UploadStorage['driver']): Response {
  const headers = new Headers({
    'Content-Type': type || 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
  });
  // Safari probes media with bytes=0-1 before requesting the playback range.
  // Unrecognized or multipart ranges can use the full representation.
  const match = range?.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (match && (match[1] || match[2])) {
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      headers.set('Content-Range', `bytes */${size}`);
      headers.set('Cache-Control', 'no-store');
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    headers.set('Content-Length', String(end - start + 1));
    const part = file.slice(start, end + 1);
    return new Response(driver === 's3' ? part.stream() : part, { status: 206, headers });
  }
  headers.set('Content-Length', String(size));
  return new Response(driver === 's3' ? file.stream() : file, { headers });
}

export function createUploadStorage(): UploadStorage {
  const bucket = process.env.S3_BUCKET?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  const endpoint = process.env.S3_ENDPOINT?.trim() || undefined;
  const region = process.env.S3_REGION?.trim() || 'auto';
  const publicUrl = process.env.S3_PUBLIC_URL?.trim().replace(/\/+$/, '') || '';
  const prefix = (process.env.S3_PREFIX ?? 'uploads').trim().replace(/^\/+|\/+$/g, '');

  if (bucket && accessKeyId && secretAccessKey) {
    const client = new S3Client({
      bucket,
      region,
      endpoint,
      accessKeyId,
      secretAccessKey,
    });

    const keyFor = (storedName: string) => (prefix ? `${prefix}/${storedName}` : storedName);

    return {
      driver: 's3',
      detail: `${bucket}${endpoint ? ` @ ${endpoint}` : ''} (${region})`,
      async put(storedName, bytes, mimeType) {
        const key = keyFor(storedName);
        await client.write(key, bytes, { type: mimeType });
        const url = publicUrl
          ? `${publicUrl}/${key.split('/').map(encodeURIComponent).join('/')}`
          : `/api/uploads/${encodeURIComponent(storedName)}`;
        return { url };
      },
      async get(storedName, range) {
        const key = keyFor(storedName);
        const s3File = client.file(key);
        if (!(await s3File.exists())) return null;
        const stat = await s3File.stat();
        return fileResponse(s3File, stat.size, stat.type || s3File.type, range, 's3');
      },
    };
  }

  const uploadsDir = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), '.data/uploads'));
  fs.mkdirSync(uploadsDir, { recursive: true });

  return {
    driver: 'local',
    detail: uploadsDir,
    async put(storedName, bytes) {
      const fullPath = path.join(uploadsDir, storedName);
      await Bun.write(fullPath, bytes);
      return { url: `/api/uploads/${encodeURIComponent(storedName)}` };
    },
    async get(storedName, range) {
      const fullPath = path.join(uploadsDir, storedName);
      const bunFile = Bun.file(fullPath);
      if (!(await bunFile.exists())) return null;
      return fileResponse(bunFile, bunFile.size, bunFile.type, range, 'local');
    },
  };
}
