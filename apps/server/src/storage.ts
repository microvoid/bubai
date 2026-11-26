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
  get(storedName: string): Promise<Response | null>;
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
      async get(storedName) {
        const key = keyFor(storedName);
        const s3File = client.file(key);
        if (!(await s3File.exists())) return null;
        const stat = await s3File.stat().catch(() => null);
        return new Response(s3File, {
          headers: {
            'Content-Type': stat?.type || s3File.type || 'application/octet-stream',
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        });
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
    async get(storedName) {
      const fullPath = path.join(uploadsDir, storedName);
      const bunFile = Bun.file(fullPath);
      if (!(await bunFile.exists())) return null;
      return new Response(bunFile, {
        headers: {
          'Content-Type': bunFile.type || 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    },
  };
}
