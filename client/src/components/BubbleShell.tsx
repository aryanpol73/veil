/**
 * ============================================================================
 *  VEIL — BUBBLE SHELL
 * ============================================================================
 *  Shared visual shell for message bubbles with retention mode glow,
 *  tactile landing spring, specular bevel, and frosted blur.
 * ============================================================================
 */

import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import {
  Blur,
  Borders,
  Motion,
  Radius,
  Retention,
  Space,
  glow,
  withAlpha,
  type RetentionMode,
} from '../theme/obsidianPrism';
import { SpecularGlass } from './SpecularGlass';

export interface BubbleShellProps {
  mode: RetentionMode;
  mine: boolean;
  children: React.ReactNode;
  hud?: React.ReactNode;
  glowStrength?: SharedValue<number>;
}

export const BubbleShell: React.FC<BubbleShellProps> = ({
  mode,
  mine,
  children,
  hud,
  glowStrength,
}) => {
  const theme = Retention[mode];
  const enter = useSharedValue(0);

  useEffect(() => {
    enter.value = withSpring(1, Motion.land);
  }, [enter]);

  const style = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [
      { translateY: interpolate(enter.value, [0, 1], [14, 0]) },
      { scale: interpolate(enter.value, [0, 1], [0.96, 1]) },
    ],
    shadowOpacity: glowStrength ? 0.3 + glowStrength.value * 0.7 : 0.35,
  }));

  return (
    <Animated.View
      style={[
        styles.bubbleWrap,
        mine ? styles.bubbleMine : styles.bubbleTheirs,
        glow(theme.edgeGlow, mode === 'viewOnce' ? 22 : 14),
        style,
      ]}
    >
      <View
        style={[
          styles.bubble,
          mine ? styles.bubbleRadiusMine : styles.bubbleRadiusTheirs,
          { backgroundColor: theme.fill, borderColor: withAlpha(theme.accent, 0.16) },
        ]}
      >
        <BlurView {...Blur.surface} style={StyleSheet.absoluteFill} />
        <SpecularGlass />
        <View style={styles.bubbleInner}>
          {hud}
          {children}
        </View>
      </View>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  bubbleWrap: { marginVertical: Space.xs, maxWidth: '82%' },
  bubbleMine: { alignSelf: 'flex-end' },
  bubbleTheirs: { alignSelf: 'flex-start' },
  bubble: { borderWidth: Borders.width, overflow: 'hidden' },
  bubbleRadiusMine: {
    borderTopLeftRadius: Radius.bubble,
    borderTopRightRadius: Radius.bubble,
    borderBottomLeftRadius: Radius.bubble,
    borderBottomRightRadius: Radius.bubbleTail,
  },
  bubbleRadiusTheirs: {
    borderTopLeftRadius: Radius.bubble,
    borderTopRightRadius: Radius.bubble,
    borderBottomLeftRadius: Radius.bubbleTail,
    borderBottomRightRadius: Radius.bubble,
  },
  bubbleInner: { paddingHorizontal: Space.md + 2, paddingVertical: Space.md - 1 },
});

export default BubbleShell;
