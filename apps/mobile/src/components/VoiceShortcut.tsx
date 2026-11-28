import React, { useRef, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  RecordingPresets,
  useAudioRecorder,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { deleteAsync } from 'expo-file-system';
import { useRouter } from 'expo-router';
import { useBubai } from '@/store/BubaiProvider';
import { useBuzzTheme } from '@/theme/ThemeProvider';

export function VoiceShortcut() {
  const { colors } = useBuzzTheme();
  const { participants, client, currentUserId, sendWsMessage } = useBubai();
  const router = useRouter();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState<(typeof participants)[number]>();
  const [recording, setRecording] = useState(false);
  const [clip, setClip] = useState<string>();
  const busy = useRef(false);
  const held = useRef(false);
  const longRecording = useRef(false);
  const messageId = useRef('');
  const agents = participants.filter(
    (person) => person.role === 'agent' && !person.archived,
  );
  async function perform(action: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    try {
      await action();
    } catch (error) {
      Alert.alert('语音消息', String(error));
    } finally {
      busy.current = false;
    }
  }
  async function stop() {
    try {
      await recorder.stop();
    } finally {
      setRecording(false);
      await setAudioModeAsync({ allowsRecording: false });
    }
    return recorder.uri ?? undefined;
  }
  async function close() {
    const uri = recording ? await stop() : clip;
    setOpen(false);
    setAgent(undefined);
    setClip(undefined);
    if (uri) await deleteAsync(uri, { idempotent: true });
  }
  async function start() {
    if (!(await requestRecordingPermissionsAsync()).granted) {
      Alert.alert('无法录音', '请在系统设置中允许使用麦克风。');
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
      messageId.current = globalThis.expo.uuidv4();
      setRecording(true);
    } catch (error) {
      await setAudioModeAsync({ allowsRecording: false });
      throw error;
    }
  }
  async function finishHold() {
    longRecording.current = false;
    try {
      setClip(await stop());
    } finally {
      setOpen(true);
    }
  }
  async function recordWhileHeld() {
    if (!agents.length || !(await getRecordingPermissionsAsync()).granted) {
      setOpen(true);
      return;
    }
    if (!held.current) return;
    await start();
    longRecording.current = true;
    if (!held.current) await finishHold();
  }
  async function send() {
    if (!clip || !client || !agent) return;
    const { channel } = await client.openDm({
      userId: currentUserId,
      targetId: agent.id,
      targetRole: 'agent',
      targetName: agent.name,
    });
    const data = new FormData();
    data.append('file', {
      uri: clip,
      type: 'audio/mp4',
      name: '语音.m4a',
    } as unknown as Blob);
    const attachment = await client.uploadFile(data);
    await sendWsMessage({
      channelId: channel.id,
      messageId: messageId.current,
      content: '',
      attachments: [attachment],
    });
    await close();
    router.push({ pathname: '/channel/[id]', params: { id: channel.id } });
  }
  function row(label: string, action: () => void) {
    return (
      <Pressable
        key={label}
        accessibilityRole="button"
        onPress={action}
        style={{ paddingVertical: 14 }}
      >
        <Text style={{ color: colors.onSurface, fontSize: 17 }}>{label}</Text>
      </Pressable>
    );
  }
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="智能体语音"
        accessibilityHint="轻点选择智能体，长按录音，松开后选择接收者"
        onPressIn={() => {
          held.current = true;
        }}
        onLongPress={() => void perform(recordWhileHeld)}
        onPressOut={() => {
          held.current = false;
          if (longRecording.current && !busy.current) void perform(finishHold);
        }}
        onPress={() => setOpen(true)}
        style={{
          width: 54,
          height: 54,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons
          name={recording ? 'mic' : 'mic-outline'}
          size={24}
          color={recording ? colors.error : colors.onSurface}
        />
      </Pressable>
      <Modal
        transparent
        visible={open}
        animationType="fade"
        onRequestClose={() => void perform(close)}
      >
        <View
          style={{
            flex: 1,
            justifyContent: 'flex-end',
            backgroundColor: colors.scrim,
          }}
        >
          <ScrollView
            style={{
              flexGrow: 0,
              maxHeight: '80%',
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              backgroundColor: colors.surface,
            }}
            contentContainerStyle={{ padding: 24, paddingBottom: 40 }}
          >
            <Text
              style={{
                fontSize: 20,
                fontWeight: '600',
                color: colors.onSurface,
              }}
            >
              {agent?.name ?? '给智能体发语音'}
            </Text>
            {!agent &&
              (agents.length ? (
                agents.map((person) => row(person.name, () => setAgent(person)))
              ) : (
                <Text style={{ color: colors.onSurfaceVariant }}>
                  当前社区暂无智能体
                </Text>
              ))}
            {agent &&
              row(
                clip ? '发送语音' : recording ? '结束录音' : '开始录音',
                () =>
                  void perform(
                    clip
                      ? send
                      : recording
                        ? async () => setClip(await stop())
                        : start,
                  ),
              )}
            {row('取消', () => void perform(close))}
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}
