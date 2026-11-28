import { BlurView } from 'expo-blur';
import { StyleSheet } from 'react-native';
import { useBuzzTheme } from '../theme/ThemeProvider';

export function FrostedSurface() {
  const { mode } = useBuzzTheme();
  return <BlurView pointerEvents="none" intensity={55} tint={mode} style={StyleSheet.absoluteFill} />;
}
