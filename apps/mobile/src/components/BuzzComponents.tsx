import { Ionicons } from "@expo/vector-icons";
import { buzzGrid, buzzRadii, buzzTypography } from '@buzz-botmux/design-tokens';
import * as Haptics from 'expo-haptics';
import React from 'react';
import { TextInput, type TextInputProps, type ButtonProps, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useBuzzTheme } from '../theme/ThemeProvider';

export function BuzzButton({title, onPress, color, disabled, ...props}: ButtonProps) {
  const { colors } = useBuzzTheme();
  return <Pressable {...props} accessibilityRole="button" accessibilityLabel={props.accessibilityLabel ?? title}
    accessibilityState={{disabled}} disabled={disabled} onPress={onPress}
    style={({pressed}) => ({minHeight: 44, justifyContent: 'center', alignItems: 'center',
      borderRadius: buzzRadii.sm, paddingHorizontal: 12, backgroundColor: colors.surfaceContainerHigh, opacity: disabled ? 0.45 : pressed ? 0.75 : 1})}>
    <Text style={[buzzTypography.label, {color: color || colors.primary}]}>{title}</Text>
  </Pressable>;
}

export function BuzzInput({style, ...props}: TextInputProps) {
  const { colors } = useBuzzTheme();
  return <TextInput placeholderTextColor={colors.onSurfaceVariant} {...props}
    style={[buzzTypography.body, {minHeight: 44, paddingHorizontal: 12, borderRadius: buzzRadii.sm,
      borderColor: colors.outline, borderWidth: StyleSheet.hairlineWidth, color: colors.onSurface, backgroundColor: colors.surfaceContainerLow}, style]}/>;
}

export function BuzzBadge({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  const { colors } = useBuzzTheme();
  const bg =
    tone === 'success'
      ? `${colors.success}22`
      : tone === 'warning'
        ? `${colors.warning}26`
        : tone === 'danger'
          ? colors.errorContainer
          : colors.surfaceContainerHigh;
  const fg =
    tone === 'success'
      ? colors.success
      : tone === 'warning'
        ? colors.warning
        : tone === 'danger'
          ? colors.error
          : colors.onSurfaceVariant;

  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[buzzTypography.micro, { color: fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function BuzzCountBadge({ count }: { count: number }) {
  const { accent } = useBuzzTheme();
  if (count <= 0) return null;
  return (
    <View style={[styles.countBadge, { backgroundColor: accent.fill }]}>
      <Text style={[buzzTypography.micro, { color: accent.foreground }]}>
        {count > 99 ? '99+' : count}
      </Text>
    </View>
  );
}

export function BuzzFilterPill({
  label,
  selected,
  count,
  onPress,
}: {
  label: string;
  selected: boolean;
  count?: number;
  onPress: () => void;
}) {
  const { colors } = useBuzzTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{selected}}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [
        styles.pill,
        {
          backgroundColor: selected ? colors.primary : colors.surfaceContainerLow,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <Text
        style={[
          buzzTypography.filter,
          { color: selected ? colors.onPrimary : colors.onSurfaceVariant },
        ]}
      >
        {label}
        {count !== undefined && count > 0 ? ` ${count}` : ''}
      </Text>
    </Pressable>
  );
}

export function BuzzSectionGroup({
  title,
  collapsible = false,
  children,
  style,
}: {
  title?: string;
  collapsible?: boolean;
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  const { colors } = useBuzzTheme();
  const [expanded, setExpanded] = React.useState(true);
  return (
    <View style={[styles.sectionWrap, style]}>
      {title && (collapsible ? <Pressable accessibilityRole="button" accessibilityState={{expanded}} onPress={() => setExpanded(!expanded)} style={{flexDirection:'row', alignItems:'center', minHeight:36, gap:6}}>
          <Text style={[buzzTypography.author,{color:colors.onSurfaceVariant}]}>{title}</Text><Ionicons name={expanded ? "chevron-down" : "chevron-forward"} size={14} color={colors.onSurfaceVariant} />
        </Pressable> : (
        <Text style={[buzzTypography.caption, styles.sectionTitle, { color: colors.onSurfaceVariant }]}>
          {title}
        </Text>
      ))}
      {expanded && <View
        style={[
          styles.sectionCard,
          {
            backgroundColor: colors.surfaceContainerLow,
            borderColor: colors.outline,
          },
        ]}
      >
        {children}
      </View>}
    </View>
  );
}

export function BuzzConnectionPill({
  connected,
  label,
  onPress,
}: {
  connected: boolean;
  label: string;
  onPress?: () => void;
}) {
  const { colors } = useBuzzTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={[
        styles.connPill,
        {
          backgroundColor: colors.surfaceContainerLow,
          borderColor: colors.outline,
        },
      ]}
    >
      <View
        style={{
          width: 7,
          height: 7,
          borderRadius: 4,
          backgroundColor: connected ? colors.success : colors.warning,
        }}
      />
      <Text style={[buzzTypography.micro, { color: colors.onSurfaceVariant }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: buzzRadii.pill,
    alignSelf: 'flex-start',
  },
  countBadge: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    minHeight: 34,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: buzzRadii.pill,
  },
  sectionWrap: {
    gap: 6,
  },
  sectionTitle: {
    paddingHorizontal: buzzGrid.xxs,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sectionCard: {
    borderRadius: buzzRadii.card,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  connPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: buzzRadii.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
