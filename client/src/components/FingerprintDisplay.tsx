/**
 * ============================================================================
 *  VEIL — FINGERPRINT DISPLAY
 * ============================================================================
 *  High-contrast Crockford Base32 safety fingerprint block with chunking,
 *  optional copy affordance, and verification indicators.
 * ============================================================================
 */

import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Pressable,
  Platform,
  ViewStyle,
  StyleProp,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import {
  Borders,
  Fonts,
  Palette,
  Radius,
  Space,
  Type,
  withAlpha,
} from '../theme/obsidianPrism';

export interface FingerprintDisplayProps {
  fingerprint: string;
  truncate?: boolean;
  copyable?: boolean;
  verified?: boolean;
  style?: StyleProp<ViewStyle>;
  size?: 'sm' | 'md' | 'lg';
}

export const FingerprintDisplay: React.FC<FingerprintDisplayProps> = ({
  fingerprint,
  truncate = false,
  copyable = false,
  verified = false,
  style,
  size = 'md',
}) => {
  const [copied, setCopied] = useState(false);

  // Format into 4-character chunks: "XXXX XXXX XXXX XXXX..."
  const cleanFp = fingerprint.replace(/\s+/g, '');
  const chunks = cleanFp.match(/.{1,4}/g) ?? [cleanFp];

  const displayChunks = truncate && chunks.length > 3
    ? [chunks[0], '····', chunks[chunks.length - 1]]
    : chunks;

  const handleCopy = async () => {
    if (!copyable) return;
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(fingerprint);
      }
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  const fontSizes = {
    sm: { fontSize: 10, lineHeight: 13, letterSpacing: 1.1 },
    md: { fontSize: 12, lineHeight: 16, letterSpacing: 1.3 },
    lg: { fontSize: 14, lineHeight: 18, letterSpacing: 1.5 },
  }[size];

  return (
    <Pressable
      onPress={handleCopy}
      disabled={!copyable}
      accessibilityRole={copyable ? 'button' : 'none'}
      accessibilityLabel={`Cryptographic fingerprint: ${fingerprint}`}
      style={({ pressed }) => [
        styles.container,
        copyable && styles.copyable,
        copyable && pressed && styles.pressed,
        style,
      ]}
    >
      <View style={styles.row}>
        <Text style={[styles.fpText, fontSizes]}>
          {displayChunks.join(' ')}
        </Text>

        {verified && (
          <View style={styles.verifiedBadge}>
            <Text style={styles.verifiedText}>✓ VERIFIED</Text>
          </View>
        )}

        {copied && (
          <View style={styles.copiedBadge}>
            <Text style={styles.copiedText}>COPIED</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  container: {
    borderRadius: Radius.sm,
    paddingVertical: 2,
  },
  copyable: {
    borderBottomWidth: 1,
    borderBottomColor: withAlpha(Palette.prismCyan, 0.2),
  },
  pressed: {
    opacity: 0.7,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Space.xs + 2,
  },
  fpText: {
    fontFamily: Fonts.mono,
    color: Palette.textHud,
  },
  verifiedBadge: {
    backgroundColor: withAlpha(Palette.prismLime, 0.15),
    borderWidth: Borders.width,
    borderColor: withAlpha(Palette.prismLime, 0.4),
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  verifiedText: {
    fontFamily: Fonts.mono,
    fontSize: 8.5,
    color: Palette.prismLime,
    letterSpacing: 1,
  },
  copiedBadge: {
    backgroundColor: withAlpha(Palette.prismCyan, 0.2),
    borderWidth: Borders.width,
    borderColor: withAlpha(Palette.prismCyan, 0.5),
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  copiedText: {
    fontFamily: Fonts.mono,
    fontSize: 8.5,
    color: Palette.prismCyan,
    letterSpacing: 1,
  },
});

export default FingerprintDisplay;
