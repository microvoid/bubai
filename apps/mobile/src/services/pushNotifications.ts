import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { BubaiClient } from '@buzz-botmux/chat-client';

export async function registerDevice(serverUrl: string, token: string, storageKey: string) {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') throw new Error('此平台不支持推送');
  if (Platform.OS === 'android')
    await Notifications.setNotificationChannelAsync('messages', {
      name: 'Messages',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  const permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) throw new Error('请在系统设置中允许通知');
  const projectId = Constants.easConfig?.projectId || Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) throw new Error('此构建尚未配置推送项目');
  const device = await Notifications.getExpoPushTokenAsync({ projectId });
  const client = new BubaiClient({ baseUrl: serverUrl, token });
  await client.registerPush(String(device.data), Platform.OS);
  await SecureStore.setItemAsync(storageKey, String(device.data));
}

export async function unregisterDevice(serverUrl: string, token: string, storageKey: string) {
  const device = await SecureStore.getItemAsync(storageKey);
  if (!device) return;
  await new BubaiClient({ baseUrl: serverUrl, token }).unregisterPush(device);
  await SecureStore.deleteItemAsync(storageKey);
}
