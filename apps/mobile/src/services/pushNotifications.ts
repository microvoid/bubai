import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type { BubaiClient } from '@buzz-botmux/chat-client';

export async function registerDevice(client: BubaiClient, storageKey: string) {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') throw new Error('此平台不支持推送');
  const projectId = Constants.easConfig?.projectId || Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) throw new Error('此构建未设置 EXPO_PUBLIC_EAS_PROJECT_ID，无法启用推送通知。');
  if (Platform.OS === 'android')
    await Notifications.setNotificationChannelAsync('messages', {
      name: 'Messages',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  const permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) throw new Error('请在系统设置中允许通知');
  const device = await Notifications.getExpoPushTokenAsync({ projectId });
  await client.registerPush(String(device.data), Platform.OS);
  await SecureStore.setItemAsync(storageKey, String(device.data));
}

export async function unregisterDevice(client: BubaiClient, storageKey: string) {
  const device = await SecureStore.getItemAsync(storageKey);
  if (!device) return;
  await client.unregisterPush(device);
  await SecureStore.deleteItemAsync(storageKey);
}
