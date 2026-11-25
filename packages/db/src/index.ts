import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import * as schema from './schema.js';

export * from './schema.js';
export { eq, asc, desc, and, lt, gt, isNull, inArray, ilike, sql } from 'drizzle-orm';

export type ChatDb = PgliteDatabase<typeof schema>;

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  name text NOT NULL,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  topic text NOT NULL DEFAULT '',
  visibility text NOT NULL DEFAULT 'public',
  kind text NOT NULL DEFAULT 'channel',
  reply_mode text NOT NULL DEFAULT 'follow_source',
  dm_key text UNIQUE,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE channels ADD COLUMN IF NOT EXISTS dm_key text UNIQUE;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS reply_mode text NOT NULL DEFAULT 'follow_source';

CREATE TABLE IF NOT EXISTS channel_reads (
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  muted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS thread_reads (
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  root_message_id uuid NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (root_message_id, user_id)
);

CREATE TABLE IF NOT EXISTS channel_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  agent_id text,
  auto_reply boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, user_id),
  UNIQUE (channel_id, agent_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  thread_id uuid,
  reply_to_id uuid,
  sender_user_id text REFERENCES users(id) ON DELETE SET NULL,
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
  display_name text,
  description text,
  system_prompt text,
  avatar_url text,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

export async function openChatDatabase(dataDir?: string): Promise<{
  pglite: PGlite;
  db: ChatDb;
}> {
  const dir = dataDir || path.resolve(process.cwd(), '.data/pglite');
  fs.mkdirSync(dir, { recursive: true });
  const pglite = new PGlite(dir);
  await pglite.waitReady;
  await pglite.exec(DDL);
  const db = drizzle(pglite, { schema });
  return { pglite, db };
}
