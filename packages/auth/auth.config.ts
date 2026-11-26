/**
 * Config entry for the Better Auth CLI only:
 *   pnpm --filter @bubai/auth auth:generate
 * The mock Drizzle client never connects to a database.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { createAuth } from './src/index.js';

export const auth = createAuth({
  database: drizzle.mock(),
  secret: 'bubai-auth-schema-generation-secret-0000',
  baseURL: 'http://localhost:4000',
});
