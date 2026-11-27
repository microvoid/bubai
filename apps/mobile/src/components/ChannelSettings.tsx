import type { Channel } from '@buzz-botmux/chat-client';
import React, { useState } from 'react';
import { Alert, Button, Text, TextInput, View } from 'react-native';
import { useBubai } from '../store/BubaiProvider';
import { useBuzzTheme } from '../theme/ThemeProvider';

export function ChannelSettings({ channel, leave }: { channel: Channel; leave: () => void }) {
  const { client, currentUserId: userId, sidebarGroups, refreshBootstrap } = useBubai();
  const { colors } = useBuzzTheme();
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic);
  const [groupName, setGroupName] = useState('');
  if (!client) return null;
  const run = async (op: Promise<unknown>, exit = false) => {
    try {
      await op;
      await refreshBootstrap();
      if (exit) leave();
    } catch (error) { Alert.alert('频道设置失败', String(error)); }
  };
  const id = channel.id;
  return <View style={{ gap: 6 }}>
    {channel.kind !== 'dm' && <>
      <TextInput accessibilityLabel="频道名称" value={name} onChangeText={setName} style={{ color: colors.onSurface }} />
      <TextInput accessibilityLabel="频道主题" placeholder="频道主题" value={topic} onChangeText={setTopic} style={{ color: colors.onSurface }} />
      {['follow_source', 'always_thread', 'always_main', 'dm_main_channel_thread'].map(mode =>
        <Button key={mode} title={(channel.replyMode === mode ? '✓ ' : '') + mode} onPress={() => void run(client.updateChannelSettings(id, { userId, replyMode: mode }))} />)}
      <Button title="保存频道信息" onPress={() => void run(client.updateChannelSettings(id, { userId, name, topic }))} />
    </>}
    <Button title={channel.muted ? '取消静音' : '静音'} onPress={() => void run(client.muteChannel(id, { userId, muted: !channel.muted }))} />
    <Button title={channel.starred ? '取消标星' : '标星'} onPress={() => void run(client.placeChannel(id, { userId, starred: !channel.starred }))} />
    <Button title="标为未读" onPress={() => void run(client.markChannelUnread(id, { userId }), true)} />
    <Button title="隐藏" onPress={() => void run(client.hideChannel(id, { userId, hidden: true }), true)} />
    <Text style={{ color: colors.onSurface }}>侧栏分组</Text>
    {[{ id: '', name: '无分组' }, ...sidebarGroups].map(group => <Button key={group.id} title={group.name} onPress={() => void run(client.placeChannel(id, { userId, groupId: group.id || null }))} />)}
    <TextInput value={groupName} onChangeText={setGroupName} placeholder="新分组名称" style={{ color: colors.onSurface }} />
    <Button title="新建分组" disabled={!groupName.trim()} onPress={() => void run(client.createSidebarGroup(groupName.trim(), userId).then(({group}) => client.placeChannel(id, { userId, groupId: group.id })))} />
    {channel.kind !== 'dm' && <>
      <Button title="归档频道" onPress={() => Alert.alert('归档此频道？', undefined, [
        { text: '取消' }, { text: '归档', onPress: () => void run(client.archiveChannel(id, { userId, archived: true }), true) },
      ])} />
      <Button title="删除频道" color={colors.error} onPress={() => Alert.alert('永久删除此频道及其消息？', undefined, [
        { text: '取消' }, { text: '删除', style: 'destructive', onPress: () => void run(client.deleteChannel(id, userId), true) },
      ])} />
    </>}
  </View>;
}
