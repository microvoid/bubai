// Adds the Drizzle `AnyPgColumn` return type to self-referencing foreign keys in the
// Better Auth generated schema (e.g. user.bot_created_by_user_id -> user.id) so it
// typechecks under `strict`. Only type annotations change; columns stay identical.
import fs from 'node:fs';

const file = process.argv[2];
let source = fs.readFileSync(file, 'utf8');

source = source.replace(
  /\.references\(\(\) => user\.id/g,
  '.references((): AnyPgColumn => user.id',
);
if (source.includes('(): AnyPgColumn') && !source.includes('type AnyPgColumn')) {
  source = source.replace(
    /from "drizzle-orm\/pg-core";/,
    'from "drizzle-orm/pg-core";\nimport type { AnyPgColumn } from "drizzle-orm/pg-core";',
  );
}

fs.writeFileSync(file, source);
