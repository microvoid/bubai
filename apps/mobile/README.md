# Bubai Mobile (`@buzz-botmux/mobile`)

Expo + React Native mobile client for Bubai (iOS & Android), pairing `agentes-chat`-inspired chat infrastructure with Buzz Mobile's visual design tokens and Botmux terminal/approval workflows.

## Local Development

```bash
# From repository root
pnpm install

# Start Metro bundler
pnpm --filter @buzz-botmux/mobile start

# Build & run on iOS Simulator
pnpm --filter @buzz-botmux/mobile ios

# Build & run on Android Emulator
pnpm --filter @buzz-botmux/mobile android
```

Set `EXPO_PUBLIC_SERVER_URL` to point to your Bubai server (defaults to `http://127.0.0.1:4000` on iOS Simulator and `http://10.0.2.2:4000` on Android Emulator), or change it inside **Settings → Bubai Server**.

## Release & Distribution Notes

- **Local builds** (`expo prebuild --platform ios` / `expo prebuild --platform android`, simulator/emulator runs, and Hermes bundle export) require **zero** external credentials.
- **TestFlight / App Store (`eas build --profile production --platform ios`)** requires an Apple Developer Team ID and App Store Connect API Key (external credentials, not stored in repo).
- **Play Store / Signed Release APK (`eas build --profile preview --platform android`)** requires an Android upload keystore when distributing outside local debug builds.
