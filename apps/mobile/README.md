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

### Native E2E

Run `bun tests/native/fixtures.ts` from the repository root to start two disposable servers with separate databases. The fixture prints the Maestro environment values. Copy the archived channel ID and both fault-proxy URLs into the shell variables used below. Start a fresh fixture for each full run so that roster changes from an earlier run do not affect the invitation flow. Port 4291 serves the open workspace and port 4292 serves the signed-in workspace.

Build the development app with its native dependencies, install it on a test simulator, and start Metro with `EXPO_PUBLIC_SERVER_URL=http://127.0.0.1:4291`. Run the UI flows from the repository root:

```sh
maestro --device "$SIMULATOR_ID" test \
  -e OPEN_SERVER=http://127.0.0.1:4291 -e AUTH_SERVER=http://127.0.0.1:4292 \
  -e TEST_EMAIL=native-ui@example.test -e TEST_PASSWORD=Demo-password-1234 \
  -e FAULT_SERVER="$FAULT_SERVER" -e AUTH_FAULT_SERVER="$AUTH_FAULT_SERVER" \
  -e ARCHIVED_CHANNEL="$ARCHIVED_CHANNEL" apps/mobile/e2e
```

The two loopback proxies can interrupt WebSockets while a channel or thread is open and return a 503 or 401 during session recovery. They operate only on the disposable servers.

For an Android emulator, install the development APK and use `adb reverse tcp:PORT tcp:PORT` for Metro, the fixture servers, and both printed proxy ports before running Maestro against its serial.

The HTTP and WebSocket regressions also run as part of `bun run test:e2e`. Terminating the fixture process removes its temporary databases.

Push-enabled builds use the EAS project ID in `EXPO_PUBLIC_EAS_PROJECT_ID` and the project's APNs or FCM credentials. The server sends through Expo Push Service. Set `EXPO_ACCESS_TOKEN` when the project requires enhanced push security.

To test foreground and cold-start notification taps on iOS, start the workspace fixture above. Set `SIMULATOR_ID`, `DISCUSSION`, and `ROOT_MESSAGE` to the simulator and the fixture's seeded IDs. Grant the dev app notification permission and run:

```sh
bun tests/native/notification-fixture.ts
# In another shell, use the URL printed by the notification fixture.
maestro --device "$SIMULATOR_ID" test -e OPEN_SERVER="$OPEN_SERVER" \
  -e NOTIFICATION_SERVER="$NOTIFICATION_SERVER" tests/native/notification-taps.yaml
```

This delivers notifications through the simulator operating system using `simctl push`. Production delivery also requires provider credentials.
