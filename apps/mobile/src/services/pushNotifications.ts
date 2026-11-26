import { Platform } from 'react-native';

export interface PushRegistrationState {
  supported: boolean;
  permissionStatus: 'undetermined' | 'granted' | 'denied' | 'unconfigured';
  token: string | null;
  detail: string;
}

/**
 * Push notification registration scaffold reserved for Phase 2 (APNs / FCM).
 * Requires Apple Developer Push Capability (iOS) or google-services.json (Android)
 * plus a server-side `/api/push/register` endpoint when deployed to TestFlight/Play.
 */
export async function getPushRegistrationState(): Promise<PushRegistrationState> {
  return {
    supported: Platform.OS === 'ios' || Platform.OS === 'android',
    permissionStatus: 'unconfigured',
    token: null,
    detail:
      Platform.OS === 'ios'
        ? 'APNs 推送接口已预留，需在 Apple Developer 开启 Push Notifications 并配置服务端推送凭证后启用。'
        : 'FCM 推送接口已预留，需配置 Firebase google-services.json 与服务端推送凭证后启用。',
  };
}

export async function registerPushToken(_params: {
  serverUrl: string;
  userId: string;
  token: string;
}): Promise<{ ok: boolean; reason?: string }> {
  return {
    ok: false,
    reason: 'Push gateway not configured on server yet (Phase 2)',
  };
}
