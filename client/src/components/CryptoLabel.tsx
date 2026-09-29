/**
 * ============================================================================
 *  VEIL — CRYPTO LABEL
 * ============================================================================
 *  High-contrast monospace machine HUD label with precise letter spacing
 *  and semantic accents.
 * ============================================================================
 */

import React from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextStyle,
  StyleProp,
  ViewStyle,
} from 'react-native';
import {
  Fonts,
  Palette,
  Space,
  withAlpha,
} from '../theme/obsidianPrism';

export type CryptoLabelVariant =
  | 'cyan'
  | 'lime'
  | 'amber'
  | 'magenta'
  | 'muted'
  | 'slate';

export interface CryptoLabelProps {
  children: string;
  variant?: CryptoLabelVariant;
  dot?: boolean;
  style?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  size?: 'xs' | 'sm' | 'md';
}

export const CryptoLabel: React.FC<CryptoLabelProps> = ({
  children,
  variant = 'slate',
  dot = false,
  style,
  containerStyle,
  size = 'sm',
}) => {
  const getColor = () => {
    switch (variant) {
      case 'cyan':
        return Palette.prismCyan;
      case 'lime':
        return Palette.prismLime;
      case 'amber':
        return Palette.prismAmber;
      case 'magenta':
        return Palette.prismMagenta;
      case 'muted':
        return Palette.textMuted;
      case 'slate':
      default:
        return Palette.textHud;
    }
  };

  const color = getColor();

  const fontSizes = {
    xs: { fontSize: 8.5, lineHeight: 11, letterSpacing: 1.2 },
    sm: { fontSize: 10, lineHeight: 13, letterSpacing: 1.4 },
    md: { fontSize: 12, lineHeight: 16, letterSpacing: 1.6 },
  }[size];

  return (
    <View style={[styles.container, containerStyle]}>
      {dot && (
        <View
          style={[
            styles.dot,
            { backgroundColor: color, shadowColor: color },
          ]}
        />
      )}
      <Text
        style={[
          styles.label,
          fontSizes,
          { color },
          style,
        ]}
      >
        {children.toUpperCase()}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    marginRight: Space.xs + 1,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 4,
  },
  label: {
    fontFamily: Fonts.mono,
  },
});

export default CryptoLabel;
