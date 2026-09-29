/**
 * ============================================================================
 *  VEIL — PRISM BUTTON
 * ============================================================================
 *  Frosted obsidian glass interactive button.
 *  Uses subtle refraction and specular highlights instead of giant flat colors.
 * ============================================================================
 */

import React from 'react';
import {
  StyleSheet,
  Text,
  View,
  Pressable,
  ActivityIndicator,
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
  Space,
  Type,
  glow,
  withAlpha,
} from '../theme/obsidianPrism';
import SpecularGlass from './SpecularGlass';

export type ButtonVariant = 'primary' | 'accent' | 'destructive' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface PrismButtonProps {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

export const PrismButton: React.FC<PrismButtonProps> = ({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  icon,
  style,
  accessibilityLabel,
}) => {
  const scale = useSharedValue(1);

  const getVariantStyles = () => {
    switch (variant) {
      case 'primary':
        return {
          textColor: Palette.prismCyan,
          edgeColor: Palette.prismCyan,
          borderColor: withAlpha(Palette.prismCyan, 0.35),
          fillColor: withAlpha(Palette.glassElevated, 0.8),
          glowColor: Palette.prismCyan,
        };
      case 'accent':
        return {
          textColor: Palette.prismLime,
          edgeColor: Palette.prismLime,
          borderColor: withAlpha(Palette.prismLime, 0.4),
          fillColor: withAlpha(Palette.glassElevated, 0.8),
          glowColor: Palette.prismLime,
        };
      case 'destructive':
        return {
          textColor: Palette.prismMagenta,
          edgeColor: Palette.prismMagenta,
          borderColor: withAlpha(Palette.prismMagenta, 0.4),
          fillColor: withAlpha(Palette.glassShroud, 0.8),
          glowColor: Palette.prismMagenta,
        };
      case 'ghost':
      default:
        return {
          textColor: Palette.textHud,
          edgeColor: Borders.specularHigh,
          borderColor: Borders.specularLow,
          fillColor: withAlpha(Palette.voidTrench, 0.5),
          glowColor: undefined,
        };
    }
  };

  const vConfig = getVariantStyles();

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: disabled ? 0.45 : 1,
  }));

  const handlePressIn = () => {
    if (disabled || loading) return;
    scale.value = withSpring(0.97, Motion.tactile);
  };

  const handlePressOut = () => {
    if (disabled || loading) return;
    scale.value = withSpring(1, Motion.tactile);
  };

  const handlePress = () => {
    if (disabled || loading) return;
    if (Platform.OS !== 'web') {
      try {
        Haptics.impactAsync(
          variant === 'destructive'
            ? Haptics.ImpactFeedbackStyle.Medium
            : Haptics.ImpactFeedbackStyle.Light,
        ).catch(() => {});
      } catch {
        /* ignore */
      }
    }
    onPress();
  };

  const sizeStyle = {
    sm: { paddingVertical: Space.xs + 2, paddingHorizontal: Space.sm + 4, borderRadius: Radius.sm },
    md: { paddingVertical: Space.sm + 2, paddingHorizontal: Space.lg, borderRadius: Radius.md },
    lg: { paddingVertical: Space.md, paddingHorizontal: Space.xl, borderRadius: Radius.md },
  }[size];

  const fontStyle = {
    sm: [Type.hudLabel, { fontSize: 10, letterSpacing: 1.2 }],
    md: [Type.hudLabel, { fontSize: 11, letterSpacing: 1.4 }],
    lg: [Type.h2, { fontSize: 13, letterSpacing: 1.6 }],
  }[size];

  return (
    <Animated.View style={[animatedStyle, style]}>
      <Pressable
        onPress={handlePress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={disabled || loading}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? title}
        accessibilityState={{ disabled: disabled || loading }}
        style={[
          styles.button,
          sizeStyle,
          {
            backgroundColor: vConfig.fillColor,
            borderColor: vConfig.borderColor,
          },
          vConfig.glowColor && glow(vConfig.glowColor, 10),
        ]}
      >
        <BlurView intensity={Blur.surface.intensity} tint="dark" style={StyleSheet.absoluteFill} />
        <SpecularGlass active color={withAlpha(vConfig.edgeColor, 0.45)} />

        <View style={styles.contentRow}>
          {loading ? (
            <ActivityIndicator size="small" color={vConfig.textColor} />
          ) : (
            <>
              {icon && <View style={styles.iconContainer}>{icon}</View>}
              <Text style={[fontStyle, { color: vConfig.textColor }]}>
                {title}
              </Text>
            </>
          )}
        </View>
      </Pressable>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  button: {
    borderWidth: Borders.width,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  iconContainer: {
    marginRight: Space.xs + 2,
  },
});

export default PrismButton;
