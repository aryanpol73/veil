/**
 * ============================================================================
 *  VEIL — PRISM SURFACE (FROSTED OBSIDIAN GLASS)
 * ============================================================================
 *  The foundational architectural plate for Veil.
 *  Uses asymmetric specular hairlines (top/left 8% white highlight) and
 *  frosted glass tint over the chromatic void.
 * ============================================================================
 */

import React from 'react';
import {
  StyleSheet,
  View,
  Pressable,
  ViewStyle,
  StyleProp,
  Platform,
} from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import {
  Blur,
  Borders,
  Motion,
  Palette,
  Radius,
  Surface,
  glow,
  withAlpha,
} from '../theme/obsidianPrism';
import SpecularGlass from './SpecularGlass';

export interface PrismSurfaceProps {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  active?: boolean;
  glowColor?: string;
  glowRadius?: number;
  interactive?: boolean;
  onPress?: () => void;
  radius?: number;
  tint?: string;
  blurIntensity?: number;
  accessibilityLabel?: string;
  accessibilityRole?: 'button' | 'none';
}

export const PrismSurface: React.FC<PrismSurfaceProps> = ({
  children,
  style,
  contentStyle,
  active = false,
  glowColor,
  glowRadius = 14,
  interactive = false,
  onPress,
  radius = Radius.md,
  tint = withAlpha(Palette.glassObsidian, 0.65),
  blurIntensity = Blur.surface.intensity,
  accessibilityLabel,
  accessibilityRole,
}) => {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    if (!interactive) return;
    scale.value = withSpring(0.98, Motion.tactile);
  };

  const handlePressOut = () => {
    if (!interactive) return;
    scale.value = withSpring(1, Motion.tactile);
  };

  const handlePress = () => {
    if (!interactive || !onPress) return;
    if (Platform.OS !== 'web') {
      try {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      } catch {
        /* ignore */
      }
    }
    onPress();
  };

  const surfaceGlow = active && glowColor ? glow(glowColor, glowRadius) : undefined;

  const content = (
    <View
      style={[
        styles.plate,
        {
          borderRadius: radius,
          backgroundColor: tint,
          borderColor: active ? withAlpha(glowColor ?? Palette.prismCyan, 0.3) : Borders.specularLow,
        },
        surfaceGlow,
        style,
      ]}
    >
      <BlurView
        intensity={blurIntensity}
        tint="dark"
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: Blur.scrim, borderRadius: radius },
        ]}
        pointerEvents="none"
      />
      <SpecularGlass
        active={active}
        color={active && glowColor ? withAlpha(glowColor, 0.4) : undefined}
      />
      <View style={[styles.inner, contentStyle]}>{children}</View>
    </View>
  );

  if (interactive) {
    return (
      <Animated.View style={animatedStyle}>
        <Pressable
          onPress={handlePress}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          accessibilityLabel={accessibilityLabel}
          accessibilityRole={accessibilityRole ?? 'button'}
          style={styles.pressable}
        >
          {content}
        </Pressable>
      </Animated.View>
    );
  }

  return content;
};

const styles = StyleSheet.create({
  plate: {
    borderWidth: Borders.width,
    overflow: 'hidden',
    position: 'relative',
  },
  inner: {
    position: 'relative',
    zIndex: 1,
  },
  pressable: {
    overflow: 'visible',
  },
});

export default PrismSurface;
