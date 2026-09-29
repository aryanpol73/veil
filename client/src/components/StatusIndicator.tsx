/**
 * ============================================================================
 *  VEIL — STATUS INDICATOR
 * ============================================================================
 *  Compact relay and network telemetry badge with micro-dot and color-independent
 *  indicators.
 * ============================================================================
 */

import React, { useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ViewStyle,
  StyleProp,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import {
  Borders,
  Fonts,
  Palette,
  Radius,
  Space,
  Type,
  glow,
  withAlpha,
} from '../theme/obsidianPrism';
import type { ConnectionStatus } from '../transport/RelayClient';

export interface StatusIndicatorProps {
  status: ConnectionStatus;
  style?: StyleProp<ViewStyle>;
  showLabel?: boolean;
}

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({
  status,
  style,
  showLabel = true,
}) => {
  const pulse = useSharedValue(0.4);

  useEffect(() => {
    if (status === 'connecting') {
      pulse.value = withRepeat(
        withTiming(1, { duration: 800, easing: Easing.inOut(Easing.quad) }),
        -1,
        true,
      );
    } else {
      pulse.value = 1;
    }
  }, [status, pulse]);

  const dotAnimatedStyle = useAnimatedStyle(() => ({
    opacity: pulse.value,
  }));

  const getStatusConfig = () => {
    switch (status) {
      case 'connected':
        return {
          color: Palette.prismEmerald,
          label: 'RELAY LIVE',
          glyph: '●',
          glowStyle: glow(Palette.prismEmerald, 6),
        };
      case 'connecting':
        return {
          color: Palette.prismAmber,
          label: 'CONNECTING',
          glyph: '◌',
          glowStyle: glow(Palette.prismAmber, 6),
        };
      case 'disconnected':
      default:
        return {
          color: Palette.textMuted,
          label: 'OFFLINE',
          glyph: '○',
          glowStyle: undefined,
        };
    }
  };

  const config = getStatusConfig();

  return (
    <View style={[styles.container, style]}>
      <Animated.View
        style={[
          styles.dot,
          { backgroundColor: config.color },
          config.glowStyle,
          dotAnimatedStyle,
        ]}
      />
      {showLabel && (
        <Text style={[styles.label, { color: config.color }]}>
          {config.label}
        </Text>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: Radius.pill,
    backgroundColor: withAlpha(Palette.voidTrench, 0.5),
    borderWidth: Borders.width,
    borderColor: Borders.specularLow,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: Space.xs + 1,
  },
  label: {
    fontFamily: Fonts.mono,
    fontSize: 9,
    letterSpacing: 1.1,
  },
});

export default StatusIndicator;
