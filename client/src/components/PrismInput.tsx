/**
 * ============================================================================
 *  VEIL — PRISM INPUT
 * ============================================================================
 *  Frosted obsidian input field with specular bevel, active cyan glow,
 *  direct container tap-to-focus, and optional visibility toggle.
 * ============================================================================
 */

import React, { useRef, useState } from 'react';
import {
  StyleSheet,
  TextInput,
  View,
  Text,
  Pressable,
  ViewStyle,
  StyleProp,
  Platform,
} from 'react-native';
import { BlurView } from 'expo-blur';
import {
  Blur,
  Borders,
  Fonts,
  Palette,
  Radius,
  Space,
  Type,
  glow,
  withAlpha,
} from '../theme/obsidianPrism';
import SpecularGlass from './SpecularGlass';

export interface PrismInputProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  label?: string;
  error?: string | null;
  mono?: boolean;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'numeric' | 'email-address';
  maxLength?: number;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  style?: StyleProp<ViewStyle>;
  rightAction?: React.ReactNode;
  editable?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  multiline?: boolean;
  autoFocus?: boolean;
}

export const PrismInput: React.FC<PrismInputProps> = ({
  value,
  onChangeText,
  placeholder,
  label,
  error,
  mono = false,
  secureTextEntry = false,
  keyboardType = 'default',
  maxLength,
  autoCapitalize = 'none',
  style,
  rightAction,
  editable = true,
  onFocus,
  onBlur,
  multiline = false,
  autoFocus = false,
}) => {
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const handleFocus = () => {
    setFocused(true);
    onFocus?.();
  };

  const handleBlur = () => {
    setFocused(false);
    onBlur?.();
  };

  const handleContainerPress = () => {
    if (editable) {
      inputRef.current?.focus();
    }
  };

  const activeColor = error
    ? Palette.danger
    : focused
    ? Palette.prismCyan
    : Borders.specularLow;

  const isActuallySecured = secureTextEntry && !revealed;

  return (
    <View style={[styles.wrapper, style]}>
      {label && (
        <View style={styles.labelRow}>
          <Text
            style={[
              Type.hudLabel,
              { color: error ? Palette.danger : focused ? Palette.prismCyan : Palette.textHud },
            ]}
          >
            {label}
          </Text>
        </View>
      )}

      <Pressable
        onPress={handleContainerPress}
        style={[
          styles.container,
          {
            borderColor: activeColor,
            backgroundColor: withAlpha(Palette.voidTrench, 0.75),
          },
          focused && glow(Palette.prismCyan, 12),
          error && glow(Palette.danger, 10),
        ]}
      >
        <BlurView
          intensity={Blur.surface.intensity}
          tint="dark"
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <SpecularGlass active={focused || !!error} color={withAlpha(activeColor, 0.4)} />

        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={withAlpha(Palette.textHud, 0.7)}
          onFocus={handleFocus}
          onBlur={handleBlur}
          secureTextEntry={isActuallySecured}
          keyboardType={keyboardType}
          maxLength={maxLength}
          autoCapitalize={autoCapitalize}
          autoCorrect={false}
          spellCheck={false}
          keyboardAppearance="dark"
          editable={editable}
          multiline={multiline}
          autoFocus={autoFocus}
          selectionColor={Palette.prismCyan}
          style={[
            styles.input,
            mono
              ? { fontFamily: Fonts.mono, letterSpacing: 1.5, fontSize: 15 }
              : [Type.body, { fontSize: 15 }],
            !editable && { opacity: 0.6 },
          ]}
        />

        {secureTextEntry && value.length > 0 && (
          <Pressable
            onPress={() => setRevealed(!revealed)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={revealed ? 'Hide PIN' : 'Show PIN'}
            style={styles.toggleBtn}
          >
            <Text style={styles.toggleText}>
              {revealed ? 'HIDE' : 'SHOW'}
            </Text>
          </Pressable>
        )}

        {rightAction && <View style={styles.rightAction}>{rightAction}</View>}
      </Pressable>

      {error && <Text style={[Type.meta, styles.errorText]}>{error}</Text>}
    </View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    marginVertical: Space.xs,
  },
  labelRow: {
    marginBottom: Space.xs,
    paddingHorizontal: 2,
  },
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.md,
    borderWidth: Borders.width,
    overflow: 'hidden',
    minHeight: 48,
    paddingHorizontal: Space.md,
    position: 'relative',
    cursor: 'text' as any,
  },
  input: {
    flex: 1,
    color: Palette.textPrimary,
    minHeight: 48,
    paddingVertical: Platform.OS === 'ios' ? Space.sm + 2 : Space.sm,
    outlineStyle: 'none' as any,
    zIndex: 2,
    position: 'relative',
  },
  toggleBtn: {
    paddingHorizontal: Space.xs + 2,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: withAlpha(Palette.glassElevated, 0.8),
    borderWidth: Borders.width,
    borderColor: Borders.specularLow,
    zIndex: 3,
    marginLeft: Space.xs,
  },
  toggleText: {
    fontFamily: Fonts.mono,
    fontSize: 9,
    letterSpacing: 1.1,
    color: Palette.prismCyan,
  },
  rightAction: {
    marginLeft: Space.sm,
    justifyContent: 'center',
    zIndex: 3,
  },
  errorText: {
    color: Palette.danger,
    marginTop: Space.xxs + 2,
    paddingHorizontal: 2,
  },
});

export default PrismInput;
