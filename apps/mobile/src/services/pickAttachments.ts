import { Alert } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import type { BubaiClient } from '@buzz-botmux/chat-client';

export async function pickAttachments(client: BubaiClient) {
  const source = await new Promise<'images' | 'files' | null>((resolve) => {
    Alert.alert(
      '添加附件',
      undefined,
      [
        { text: '照片', onPress: () => resolve('images') },
        { text: '文件', onPress: () => resolve('files') },
        { text: '取消', style: 'cancel', onPress: () => resolve(null) },
      ],
      { cancelable: true, onDismiss: () => resolve(null) },
    );
  });
  if (!source) return [];
  const picked =
    source === 'images'
      ? await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsMultipleSelection: true,
        })
      : await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  if (picked.canceled) return [];
  return Promise.all(
    picked.assets.map((asset) => {
      const data = new FormData();
      data.append('file', {
        uri: asset.uri,
        name:
          ('name' in asset ? asset.name : asset.fileName) ||
          asset.uri.split('/').pop() ||
          'attachment',
        type: asset.mimeType || 'application/octet-stream',
      } as unknown as Blob);
      return client.uploadFile(data);
    }),
  );
}
