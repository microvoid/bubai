import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text } from 'react-native';
import { useMemo } from 'react';
import { attachmentSource } from '../services/attachments';

export function VoiceMessage({
  url,
  server,
  token,
  color,
}: {
  url: string;
  server: string;
  token: string | null;
  color: string;
}) {
  const source = useMemo(
    () => attachmentSource(server, url, token),
    [server, url, token],
  );
  const player = useAudioPlayer(source);
  const status = useAudioPlayerStatus(player);
  async function toggle() {
    if (status.playing) {
      player.pause();
      return;
    }
    if (
      status.didJustFinish ||
      (status.duration > 0 && status.currentTime >= status.duration)
    )
      await player.seekTo(0);
    player.play();
  }
  const seconds = Math.floor(
    (status.playing ? status.currentTime : status.duration) || 0,
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={status.playing ? '暂停语音消息' : '播放语音消息'}
      onPress={() => void toggle()}
      style={{
        minWidth: 130,
        minHeight: 36,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <Ionicons
        name={status.playing ? 'pause' : 'play'}
        color={color}
        size={20}
      />
      <Text style={{ fontSize: 16, color }}>语音消息</Text>
      <Text style={{ fontSize: 13, color }}>
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
      </Text>
    </Pressable>
  );
}
