import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema.js';

export * from './schema.js';
export { eq, asc, desc, and, lt, gt, isNull, isNotNull, inArray, ilike, sql } from 'drizzle-orm';

export type ChatDb = NodePgDatabase<typeof schema>;

function buildPgPoolConfig(databaseUrl: string): PoolConfig {
  const parsed = new URL(databaseUrl);
  const sslmode = (parsed.searchParams.get('sslmode') || '').toLowerCase();
  const sslnegotiation = (parsed.searchParams.get('sslnegotiation') || '').toLowerCase();

  // Direct TLS (PostgreSQL 17+): immediately negotiate TLS with ALPN "postgresql"
  // instead of sending a plaintext SSLRequest packet.
  if (sslnegotiation === 'direct') {
    const host = parsed.hostname;
    const port = Number(parsed.port || 5432);
    const rejectUnauthorized = sslmode === 'verify-full' || sslmode === 'verify-ca';
    parsed.searchParams.delete('sslmode');
    parsed.searchParams.delete('sslnegotiation');
    return {
      connectionString: parsed.toString(),
      ssl: false,
      stream: () => {
        const sock = tls.connect({
          host,
          port,
          ...(net.isIP(host) ? {} : { servername: host }),
          ALPNProtocols: ['postgresql'],
          rejectUnauthorized,
        });
        // pg calls stream.connect(port, host) after constructing the stream,
        // whereas tls.connect() has already initiated the TLS connection.
        (sock as unknown as { connect: () => typeof sock }).connect = () => sock;
        return sock;
      },
    };
  }

  if (sslmode === 'require' || sslmode === 'prefer') {
    parsed.searchParams.delete('sslmode');
    return {
      connectionString: parsed.toString(),
      ssl: { rejectUnauthorized: false },
    };
  }

  if (sslmode === 'verify-full' || sslmode === 'verify-ca') {
    parsed.searchParams.delete('sslmode');
    return {
      connectionString: parsed.toString(),
      ssl: { rejectUnauthorized: true },
    };
  }

  return { connectionString: databaseUrl };
}

const DDL = `
CREATE TABLE IF NOT EXISTS "user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  role text,
  banned boolean DEFAULT false,
  ban_reason text,
  ban_expires timestamp,
  kind text NOT NULL DEFAULT 'HUMAN',
  bot_created_by_user_id text
);

CREATE TABLE IF NOT EXISTS channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  topic text NOT NULL DEFAULT '',
  visibility text NOT NULL DEFAULT 'public',
  kind text NOT NULL DEFAULT 'channel',
  reply_mode text NOT NULL DEFAULT 'follow_source',
  archived boolean NOT NULL DEFAULT false,
  dm_key text,
  organization_id text,
  created_by_user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE channels ADD COLUMN IF NOT EXISTS dm_key text;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS reply_mode text NOT NULL DEFAULT 'follow_source';
ALTER TABLE channels ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS organization_id text;
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_name_key;
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_dm_key_key;
CREATE INDEX IF NOT EXISTS channels_organization_idx ON channels (organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS channels_org_name_uidx ON channels (COALESCE(organization_id, ''), name);
CREATE UNIQUE INDEX IF NOT EXISTS channels_org_dm_key_uidx ON channels (COALESCE(organization_id, ''), dm_key) WHERE dm_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS channel_reads (
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  muted boolean NOT NULL DEFAULT false,
  hidden boolean NOT NULL DEFAULT false,
  marked_unread boolean NOT NULL DEFAULT false,
  starred boolean NOT NULL DEFAULT false,
  group_id text,
  PRIMARY KEY (channel_id, user_id)
);

ALTER TABLE channel_reads ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
ALTER TABLE channel_reads ADD COLUMN IF NOT EXISTS marked_unread boolean NOT NULL DEFAULT false;
ALTER TABLE channel_reads ADD COLUMN IF NOT EXISTS starred boolean NOT NULL DEFAULT false;
ALTER TABLE channel_reads ADD COLUMN IF NOT EXISTS group_id text;

CREATE TABLE IF NOT EXISTS sidebar_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sidebar_groups_user_idx ON sidebar_groups (user_id);

CREATE TABLE IF NOT EXISTS thread_reads (
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  root_message_id uuid NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (root_message_id, user_id)
);

CREATE TABLE IF NOT EXISTS channel_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id text REFERENCES "user"(id) ON DELETE CASCADE,
  agent_id text,
  auto_reply boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, user_id),
  UNIQUE (channel_id, agent_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_members_channel_user_uidx ON channel_members (channel_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS channel_members_channel_agent_uidx ON channel_members (channel_id, agent_id);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  thread_id uuid,
  reply_to_id uuid,
  sender_user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  sender_agent_id text,
  content text NOT NULL,
  card jsonb,
  attachments jsonb,
  botmux_session_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  deleted_at timestamptz
);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments jsonb;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id uuid;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS adapter_meta jsonb;

CREATE INDEX IF NOT EXISTS messages_channel_created_idx ON messages (channel_id, created_at);
CREATE INDEX IF NOT EXISTS messages_thread_created_idx ON messages (thread_id, created_at);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  emoji text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS message_pins (
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by_user_id text NOT NULL,
  pinned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, message_id)
);

CREATE TABLE IF NOT EXISTS botmux_bindings (
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  bot_id text NOT NULL,
  session_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, bot_id)
);

CREATE TABLE IF NOT EXISTS agent_profiles (
  agent_id text PRIMARY KEY,
  adapter_type text NOT NULL DEFAULT 'botmux',
  external_id text,
  default_name text,
  display_name text,
  description text,
  system_prompt text,
  avatar_url text,
  cli_id text,
  working_dir text,
  capabilities jsonb,
  webhook_url text,
  webhook_secret text,
  archived boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS adapter_type text NOT NULL DEFAULT 'botmux';
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS default_name text;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS cli_id text;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS working_dir text;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS capabilities jsonb;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS webhook_url text;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS webhook_secret text;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

CREATE TABLE IF NOT EXISTS uploads (
  stored_name text PRIMARY KEY,
  organization_id text,
  uploaded_by_user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  mime_type text NOT NULL DEFAULT 'application/octet-stream',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS uploads_org_idx ON uploads (organization_id);

DO $$
BEGIN
  IF to_regclass('public.users') IS NOT NULL THEN
    INSERT INTO "user" (id, name, email, email_verified, image, kind)
    SELECT id, name, id || '@legacy.bubai.local', false, avatar_url, 'HUMAN'
    FROM users
    ON CONFLICT (id) DO NOTHING;

    ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_created_by_user_id_fkey;
    ALTER TABLE channel_reads DROP CONSTRAINT IF EXISTS channel_reads_user_id_fkey;
    ALTER TABLE sidebar_groups DROP CONSTRAINT IF EXISTS sidebar_groups_user_id_fkey;
    ALTER TABLE thread_reads DROP CONSTRAINT IF EXISTS thread_reads_user_id_fkey;
    ALTER TABLE channel_members DROP CONSTRAINT IF EXISTS channel_members_user_id_fkey;
    ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_sender_user_id_fkey;

    ALTER TABLE channels ADD CONSTRAINT channels_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES "user"(id) ON DELETE SET NULL;
    ALTER TABLE channel_reads ADD CONSTRAINT channel_reads_user_id_fkey FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;
    ALTER TABLE sidebar_groups ADD CONSTRAINT sidebar_groups_user_id_fkey FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;
    ALTER TABLE thread_reads ADD CONSTRAINT thread_reads_user_id_fkey FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;
    ALTER TABLE channel_members ADD CONSTRAINT channel_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;
    ALTER TABLE messages ADD CONSTRAINT messages_sender_user_id_fkey FOREIGN KEY (sender_user_id) REFERENCES "user"(id) ON DELETE SET NULL;

    DROP TABLE users;
  END IF;
END $$;
`;

export interface OpenChatDatabaseOptions {
  dataDir?: string;
  databaseUrl?: string;
  /** Optional SQL DDL executed before chat tables (e.g. AUTH_DDL from @bubai/auth). */
  beforeDdl?: string;
}

export async function openChatDatabase(
  options?: string | OpenChatDatabaseOptions,
): Promise<{
  driver: 'postgres' | 'pglite';
  pglite?: PGlite;
  pool?: Pool;
  db: ChatDb;
  close: () => Promise<void>;
}> {
  const opts: OpenChatDatabaseOptions =
    typeof options === 'string' ? { dataDir: options } : options || {};
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL?.trim();
  const fullDdl = opts.beforeDdl ? `${opts.beforeDdl}\n${DDL}` : DDL;

  if (databaseUrl) {
    const pool = new Pool(buildPgPoolConfig(databaseUrl));
    await pool.query(fullDdl);
    const db = drizzlePg(pool, { schema });
    return {
      driver: 'postgres',
      pool,
      db,
      close: () => pool.end(),
    };
  }

  const dir = opts.dataDir || path.resolve(process.cwd(), '.data/pglite');
  fs.mkdirSync(dir, { recursive: true });
  const pglite = new PGlite(dir);
  await pglite.waitReady;
  await pglite.exec(fullDdl);
  const db = drizzlePglite(pglite, { schema }) as unknown as ChatDb;
  return {
    driver: 'pglite',
    pglite,
    db,
    close: () => pglite.close(),
  };
}
