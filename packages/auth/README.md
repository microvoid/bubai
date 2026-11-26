# `@bubai/auth`

Better Auth configuration package for Bubai on Drizzle (PostgreSQL / PGlite), preserving all 9 plugins from `main`:

1. `bearer({ requireSignature: true })`
2. `emailOTP` (with console OTP logger for local dev & E2E, plus Resend / custom transport for production)
3. `expo()` (`@better-auth/expo`, trusted origin `bubai://`)
4. `organization({ teams: { enabled: true } })` (maps to Buzz **Community**)
5. `admin()`
6. `bot()` (`@bubai/better-auth-bot`, unifies human and Bot/Agent identities in `user`)
7. `deviceAuthorization` (CLI device grant)
8. `apiKey` (`cli`, `bot`, `bot-server` configs)
9. `cliTokenIssuer` (`redeemCliDeviceCode`)

See [docs/auth-and-buzz-alignment.md](../../docs/auth-and-buzz-alignment.md) for the full Buzz alignment and schema design.
