import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React, { useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useBuzzTheme } from '../theme/ThemeProvider';

export function SwipeReply({ onReply, children }: { onReply?: () => void; children: React.ReactNode }) {
  const { colors } = useBuzzTheme();
  const offset = useRef(new Animated.Value(0)).current;
  const armed = useRef(false);
  const gesture = Gesture.Pan().enabled(Boolean(onReply)).runOnJS(true)
    .activeOffsetX(-14).failOffsetY([-12, 12])
    .onUpdate(({ translationX }) => {
      offset.setValue(Math.min(0, Math.max(-72, translationX)));
      if (translationX < -52 && !armed.current) void Haptics.selectionAsync();
      armed.current = translationX < -52;
    })
    .onEnd((_, success) => { if (success && armed.current) onReply?.(); })
    .onFinalize(() => {
      armed.current = false;
      Animated.spring(offset, { toValue: 0, useNativeDriver: true }).start();
    });
  return (
    <View>
      <Animated.View pointerEvents="none" style={[styles.icon, { opacity: offset.interpolate({inputRange: [-52, 0], outputRange: [1, 0], extrapolate: 'clamp'}) }]}>
        <Ionicons name="arrow-undo" size={22} color={colors.onSurfaceVariant} />
      </Animated.View>
      <GestureDetector gesture={gesture}>
        <Animated.View style={{ transform: [{ translateX: offset }] }}>{children}</Animated.View>
      </GestureDetector>
    </View>
  );
}
const styles = StyleSheet.create({ icon: { position: 'absolute', right: 18, top: '40%' } });
