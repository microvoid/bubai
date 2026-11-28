import { Alert } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import type { BubaiClient } from '@buzz-botmux/chat-client';
import type { StagedAttachment } from '../store/reconcileTimeline';

function stagingDirectory() {
  if (!FileSystem.documentDirectory) throw new Error('无法访问本地附件存储');
  return FileSystem.documentDirectory + 'bubai-outbox/';
}

function stagedUri(id: string) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('无效的本地附件');
  return stagingDirectory() + id;
}

export async function removeStaged(files: StagedAttachment[] = []) {
  await Promise.all(files.map(file => FileSystem.deleteAsync(stagedUri(file.id), { idempotent: true })));
}

export async function uploadStaged(client: BubaiClient, file: StagedAttachment) {
  const uri = stagedUri(file.id);
  if (!(await FileSystem.getInfoAsync(uri)).exists) throw new Error('本地附件已丢失，请重新选择文件');
  const data = new FormData();
  data.append('file', { uri, name: file.name, type: file.mimeType } as unknown as Blob);
  return client.uploadFile(data);
}

export async function pickAttachments() {
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
  await FileSystem.makeDirectoryAsync(stagingDirectory(), { intermediates: true });
  const files: StagedAttachment[] = [];
  try {
    for (const asset of picked.assets) {
      const file = {
        id: globalThis.expo.uuidv4(),
        name: ('name' in asset ? asset.name : asset.fileName) || asset.uri.split('/').pop() || 'attachment',
        mimeType: asset.mimeType || 'application/octet-stream',
      };
      files.push(file);
      await FileSystem.copyAsync({ from: asset.uri, to: stagedUri(file.id) });
    }
    return files;
  } catch (error) {
    await removeStaged(files);
    throw error;
  }
}
