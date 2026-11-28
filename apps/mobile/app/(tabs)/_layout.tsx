import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useBuzzTheme } from '@/theme/ThemeProvider';

export default function WorkspaceLayout() {
  const router = useRouter();
  const { colors } = useBuzzTheme();
  return (
    <Stack
      screenOptions={{
        headerTitle: '',
        headerLeft: () => (
          <Pressable testID="workspace-back" accessibilityRole="button" accessibilityLabel="返回消息"
            onPress={()=>router.canGoBack()?router.back():router.replace('/')} hitSlop={8}
            style={{width:44,height:44,alignItems:'flex-start',justifyContent:'center'}}>
            <Ionicons name="chevron-back" color={colors.onSurface} size={24}/>
          </Pressable>
        ),
        headerBackTitle: '消息',
        headerShadowVisible: false,
        headerTintColor: colors.onSurface,
        headerStyle: { backgroundColor: colors.surface },
      }}
    >
      <Stack.Screen
        name="index"
        options={{ headerShown: false, title: '消息' }}
      />
      <Stack.Screen name="activity" />
      <Stack.Screen name="agents" />
      <Stack.Screen name="settings" />
    </Stack>
  );
}
