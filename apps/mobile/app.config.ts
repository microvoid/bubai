import type { ExpoConfig } from 'expo/config';

const variant = process.env.APP_VARIANT || 'development';
const isProd = variant === 'production';
const isPreview = variant === 'preview';
const suffix = isProd ? '' : isPreview ? '.preview' : '.dev';
const nameSuffix = isProd ? '' : isPreview ? ' Preview' : ' Dev';

const config: ExpoConfig = {
  name: `Bubai${nameSuffix}`,
  slug: 'bubai',
  ...(process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim() && {
    extra: { eas: { projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID.trim() } },
  }),
  scheme: 'bubai',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  icon: './assets/icon.png',
  splash: {
    image: './assets/splash-icon.png',
    resizeMode: 'contain',
    backgroundColor: '#121214',
  },
  newArchEnabled: true,
  ios: {
    supportsTablet: true,
    bundleIdentifier: `com.bubai.app${suffix}`,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: !isProd,
        NSAllowsLocalNetworking: true,
      },
    },
  },
  android: {
    package: `com.bubai.app${suffix}`,
    adaptiveIcon: {
      foregroundImage: './assets/icon.png',
      backgroundColor: '#121214',
    },
    edgeToEdgeEnabled: true,
    softwareKeyboardLayoutMode: 'resize',
  },
  plugins: ['expo-router', 'expo-secure-store', 'expo-notifications', ['expo-audio', { microphonePermission: '允许 Bubai 录制你发送给智能体的语音。' }], './plugins/withXcode26FmtFix'],
  experiments: {
    typedRoutes: true,
  },
};

export default config;
