import { BUZZ_AGENT_SQUIRCLE_SVG_PATH } from '@buzz-botmux/design-tokens';
import React, { useId } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import Svg, { ClipPath, Defs, Image as SvgImage, Path, Rect } from 'react-native-svg';
import { useBuzzTheme } from '../theme/ThemeProvider';

interface BuzzAvatarProps {
  name: string;
  uri?: string | null;
  size?: number;
  isAgent?: boolean;
  status?: 'online' | 'offline';
  ringColor?: string;
}

/**
 * Buzz-faithful Avatar:
 * - Agents use the exact Buzz squircle Bezier clip (`BUZZ_AGENT_SQUIRCLE_SVG_PATH`).
 * - Humans use a crisp circle.
 * - Optional status badge cut out at the bottom-right corner.
 */
export function BuzzAvatar({
  name,
  uri,
  size = 44,
  isAgent = false,
  status,
  ringColor,
}: BuzzAvatarProps) {
  const { colors } = useBuzzTheme();
  const clipId = useId().replace(/:/g, '');
  const initial = Array.from(name.trim())[0]?.toUpperCase() || '?';
  const dotSize = Math.max(10, Math.round(size * 0.27));
  const dotBorder = Math.max(2, Math.round(size * 0.055));
  const bg = colors.surfaceContainerHigh;
  const fg = colors.onSurface;

  return (
    <View style={{ width: size, height: size }}>
      {isAgent ? (
        <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
          <Svg width={size} height={size} viewBox="0 0 100 100">
            <Defs>
              <ClipPath id={clipId}>
                <Path d={BUZZ_AGENT_SQUIRCLE_SVG_PATH} />
              </ClipPath>
            </Defs>
            <Path d={BUZZ_AGENT_SQUIRCLE_SVG_PATH} fill={bg} />
            {uri ? (
              <SvgImage
                href={{ uri }}
                x={0}
                y={0}
                width={100}
                height={100}
                preserveAspectRatio="xMidYMid slice"
                clipPath={`url(#${clipId})`}
              />
            ) : (
              <Rect x={0} y={0} width={100} height={100} fill={bg} clipPath={`url(#${clipId})`} />
            )}
          </Svg>
          {!uri && (
            <View style={StyleSheet.absoluteFill} pointerEvents="none">
              <View style={styles.initialCenter}>
                <Text
                  style={{
                    color: fg,
                    fontSize: Math.round(size * 0.42),
                    fontWeight: '600',
                  }}
                >
                  {initial}
                </Text>
              </View>
            </View>
          )}
        </View>
      ) : (
        <View
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: bg,
            overflow: 'hidden',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {uri ? (
            <Image source={{ uri }} style={{ width: size, height: size }} resizeMode="cover" />
          ) : (
            <Text
              style={{
                color: fg,
                fontSize: Math.round(size * 0.42),
                fontWeight: '600',
              }}
            >
              {initial}
            </Text>
          )}
        </View>
      )}

      {status && (
        <View
          style={{
            position: 'absolute',
            right: -1,
            bottom: -1,
            width: dotSize,
            height: dotSize,
            borderRadius: dotSize / 2,
            backgroundColor: status === 'online' ? colors.success : colors.onSurfaceVariant,
            borderWidth: dotBorder,
            borderColor: ringColor ?? colors.surface,
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  initialCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
