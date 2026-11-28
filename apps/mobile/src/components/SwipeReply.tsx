import React, { useMemo, useRef } from 'react';
import { Animated, PanResponder } from 'react-native';

export function SwipeReply({
  onReply,
  children,
}: {
  onReply?: () => void;
  children: React.ReactNode;
}) {
  const offset = useRef(new Animated.Value(0)).current;
  const latest = useRef(onReply);
  latest.current = onReply;
  const gesture = useMemo(() => {
    const reset = () =>
      Animated.spring(offset, { toValue: 0, useNativeDriver: true }).start();
    return PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, g) =>
        Boolean(latest.current) && g.dx < -14 && -g.dx > 2 * Math.abs(g.dy),
      onPanResponderMove: (_, g) =>
        offset.setValue(Math.max(-72, Math.min(0, g.dx))),
      onPanResponderRelease: (_, g) => {
        reset();
        if (g.dx < -52) latest.current?.();
      },
      onPanResponderTerminate: reset,
    });
  }, [offset]);
  return (
    <Animated.View
      {...gesture.panHandlers}
      style={{ transform: [{ translateX: offset }] }}
    >
      {children}
    </Animated.View>
  );
}
