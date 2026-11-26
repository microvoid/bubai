# `@bubai/auth`

Better Auth configuration package for Bubai on Drizzle (PostgreSQL / PGlite), using standard Better Auth plugins with no patches or custom middleware wrappers:

1. `bearer()`
2. `emailOTP({ sendVerificationOTP })` (defaults to console logging in dev)
3. `expo()` (`@better-auth/expo`, trusted origin `bubai://`)
4. `organization({ teams: { enabled: true } })` (maps to Buzz **Community**)
5. `admin()`
6. `bot()` (`@bubai/better-auth-bot`, unifies human and Bot/Agent identities in `user`)
7. `deviceAuthorization()`
8. `apiKey([botApiKeyConfig, botServerApiKeyConfig])`

## Schema Generation

`src/schema.ts` is generated directly from the configured plugins via Better Auth CLI:

```bash
pnpm --filter @bubai/auth auth:generate
```

See [docs/auth-and-buzz-alignment.md](../../docs/auth-and-buzz-alignment.md) for the Buzz concept alignment and integration plan.
