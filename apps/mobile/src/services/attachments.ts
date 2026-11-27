import type { MessageAttachment } from '@buzz-botmux/chat-client';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Linking } from 'react-native';

export function attachmentSource(serverUrl: string, path: string, token: string | null) {
  const url = new URL(path, serverUrl + '/');
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('无效的附件链接');
  const privateUpload = url.href.startsWith(serverUrl.replace(/\/+$/, '') + '/api/uploads/');
  return {
    uri: url.href,
    headers: privateUpload && token ? { Authorization: 'Bearer ' + token } : undefined,
  };
}

export async function openAttachment(
  serverUrl: string,
  attachment: MessageAttachment,
  token: string | null,
) {
  const { uri, headers } = attachmentSource(serverUrl, attachment.url, token);
  if (!headers) return Linking.openURL(uri);
  const filename = attachment.name.replace(/[^\p{L}\p{N}._-]/gu, '_');
  const local = FileSystem.cacheDirectory + globalThis.expo.uuidv4() + '-' + filename;
  try {
    const result = await FileSystem.downloadAsync(uri, local, { headers });
    if (result.status !== 200) throw new Error('下载失败 (HTTP ' + result.status + ')');
    await Sharing.shareAsync(local, { mimeType: attachment.mimeType });
  } finally {
    await FileSystem.deleteAsync(local, { idempotent: true });
  }
}
