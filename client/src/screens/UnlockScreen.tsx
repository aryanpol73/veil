/**
 * ============================================================================
 *  VEIL — UNLOCK SCREEN (COERCION-RESISTANT PIN ACCESS)
 * ============================================================================
 *  Unlocks the dual-partition vault:
 *   - Master PIN unlocks primary vault (Personal Mask 0)
 *   - Ghost PIN unlocks decoy vault (Ghost Mask 1)
 *  Timing and UI behavior are identical in both cases.
 * ============================================================================
 */

import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  Pressable,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import {
  Palette,
  Type,
  Borders,
  Space,
  Radius,
  withAlpha,
  glow,
} from '../theme/obsidianPrism';
import PrismBackdrop from '../components/PrismBackdrop';
import PrismSurface from '../components/PrismSurface';
import CryptoLabel from '../components/CryptoLabel';
import {
  unlockWithPin,
  activeMaskIndex,
  loadSealedMasterSeed,
} from '../storage/db';
import { identityManager } from '../identity/IdentityManager';
import { messageService } from '../messaging/MessageService';
import type { RootNavigationProp } from '../types/navigation';

export interface UnlockScreenProps {
  navigation: RootNavigationProp;
}

export const UnlockScreen: React.FC<UnlockScreenProps> = ({ navigation }) => {
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUnlock = async (enteredPin: string) => {
    if (loading || enteredPin.length < 6) return;
    setLoading(true);
    setError(null);

    try {
      const res = await unlockWithPin(enteredPin);
      if (!res.ok) {
        if (Platform.OS !== 'web') {
          try {
            await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          } catch {
            /* ignore */
          }
        }
        setError('AUTHENTICATION FAILED');
        setPin('');
        return;
      }

      if (Platform.OS !== 'web') {
        try {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } catch {
          /* ignore */
        }
      }

      // Load sealed master seed for this partition
      const seed = loadSealedMasterSeed();
      if (seed) {
        const mask = identityManager.setIdentity(seed, activeMaskIndex());
        messageService.setActiveMask(mask);
      }

      navigation.replace('ThreadList');
    } catch {
      setError('AUTHENTICATION ERROR');
      setPin('');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyPress = (num: string) => {
    if (loading) return;
    setError(null);
    if (Platform.OS !== 'web') {
      try {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      } catch {
        /* ignore */
      }
    }

    const next = pin + num;
    setPin(next);
    if (next.length === 6) {
      handleUnlock(next);
    }
  };

  const handleDelete = () => {
    if (loading || pin.length === 0) return;
    if (Platform.OS !== 'web') {
      try {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      } catch {
        /* ignore */
      }
    }
    setPin(pin.slice(0, -1));
  };

  return (
    <View style={styles.root}>
      <PrismBackdrop />
      <SafeAreaView style={styles.safe}>
        <View style={styles.responsiveShell}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={[Type.h1, styles.title]}>VEIL</Text>
            <CryptoLabel variant="cyan" size="xs" containerStyle={{ marginTop: 4 }}>
              OBSIDIAN CRYPTOGRAPHIC LENS
            </CryptoLabel>
            <Text style={styles.subtitle}>
              DUAL PARTITION VAULT ACCESS
            </Text>
          </View>

          {/* PIN Indicators Plate */}
          <View style={styles.indicatorContainer}>
            <PrismSurface
              radius={Radius.pill}
              style={styles.indicatorPlate}
              contentStyle={styles.dotRow}
              tint={withAlpha(Palette.voidTrench, 0.7)}
            >
              {[0, 1, 2, 3, 4, 5].map((idx) => (
                <View
                  key={idx}
                  style={[
                    styles.dot,
                    idx < pin.length && styles.dotFilled,
                    error && styles.dotError,
                  ]}
                />
              ))}
            </PrismSurface>

            {error && (
              <CryptoLabel variant="magenta" size="xs" containerStyle={{ marginTop: Space.md }}>
                {error}
              </CryptoLabel>
            )}

            {loading && (
              <View style={styles.loadingContainer}>
                <ActivityIndicator
                  color={Palette.prismCyan}
                  size="small"
                />
                <CryptoLabel variant="cyan" size="xs" containerStyle={{ marginTop: Space.xs }}>
                  DERIVING ARGON2ID KEYS…
                </CryptoLabel>
              </View>
            )}
          </View>

          {/* Virtual Keypad */}
          <View style={styles.keypad}>
            {[
              ['1', '2', '3'],
              ['4', '5', '6'],
              ['7', '8', '9'],
              ['', '0', '⌫'],
            ].map((row, rIdx) => (
              <View key={rIdx} style={styles.keypadRow}>
                {row.map((btn, bIdx) => {
                  if (btn === '') {
                    return <View key={bIdx} style={styles.keyBtnEmpty} />;
                  }
                  const isDel = btn === '⌫';
                  return (
                    <PrismSurface
                      key={bIdx}
                      interactive
                      onPress={() => (isDel ? handleDelete() : handleKeyPress(btn))}
                      radius={Radius.bubble}
                      style={styles.keyBtn}
                      contentStyle={styles.keyBtnInner}
                      tint={
                        isDel
                          ? withAlpha(Palette.glassShroud, 0.6)
                          : withAlpha(Palette.glassObsidian, 0.65)
                      }
                      active={isDel}
                      glowColor={isDel ? withAlpha(Palette.prismMagenta, 0.3) : undefined}
                      accessibilityLabel={isDel ? 'Delete PIN digit' : `Digit ${btn}`}
                    >
                      <Text
                        style={[
                          Type.h1,
                          isDel ? styles.delKeyText : styles.keyText,
                        ]}
                      >
                        {btn}
                      </Text>
                    </PrismSurface>
                  );
                })}
              </View>
            ))}
          </View>

          {/* Coercion Notice */}
          <View style={styles.footer}>
            <Text style={styles.footerNote}>
              Independent Master & Ghost PINs unlock separate partitions with zero forensic linkage.
            </Text>
          </View>

          {/* Hidden TextInput for accessibility / keyboard input */}
          <TextInput
            value={pin}
            onChangeText={(val) => {
              const digits = val.replace(/\D/g, '').slice(0, 6);
              setPin(digits);
              if (digits.length === 6) handleUnlock(digits);
            }}
            keyboardType="numeric"
            maxLength={6}
            secureTextEntry
            style={styles.hiddenInput}
            autoFocus={false}
            accessibilityLabel="Enter 6-digit security PIN"
          />
        </View>
      </SafeAreaView>
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.voidMidnight },
  safe: { flex: 1 },
  responsiveShell: {
    flex: 1,
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Space.xl,
    paddingVertical: Space.lg,
  },
  header: {
    alignItems: 'center',
    marginTop: Space.lg,
  },
  title: {
    fontSize: 30,
    lineHeight: 36,
    color: Palette.prismCyan,
    letterSpacing: 6,
  },
  subtitle: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: Palette.textMuted,
    letterSpacing: 1.8,
    marginTop: 6,
  },
  indicatorContainer: {
    alignItems: 'center',
    marginVertical: Space.md,
  },
  indicatorPlate: {
    paddingHorizontal: Space.lg,
    paddingVertical: Space.sm + 2,
    borderWidth: Borders.width,
    borderColor: Borders.specularLow,
  },
  dotRow: {
    flexDirection: 'row',
    gap: Space.md,
    alignItems: 'center',
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: Borders.activeHigh,
    backgroundColor: withAlpha(Palette.voidTrench, 0.4),
  },
  dotFilled: {
    backgroundColor: Palette.prismCyan,
    borderColor: Palette.prismCyan,
    ...glow(Palette.prismCyan, 10),
  },
  dotError: {
    borderColor: Palette.danger,
    backgroundColor: withAlpha(Palette.danger, 0.6),
  },
  loadingContainer: {
    alignItems: 'center',
    marginTop: Space.md,
  },
  keypad: {
    width: '100%',
    maxWidth: 320,
    alignSelf: 'center',
  },
  keypadRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: Space.xs + 2,
  },
  keyBtn: {
    width: 68,
    height: 68,
  },
  keyBtnInner: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyBtnEmpty: {
    width: 68,
    height: 68,
  },
  keyText: {
    color: Palette.textPrimary,
    fontSize: 24,
    lineHeight: 28,
  },
  delKeyText: {
    color: Palette.prismMagenta,
    fontSize: 20,
    lineHeight: 24,
  },
  footer: {
    alignItems: 'center',
    marginTop: Space.sm,
  },
  footerNote: {
    fontFamily: 'monospace',
    fontSize: 9.5,
    lineHeight: 14,
    color: Palette.textMuted,
    textAlign: 'center',
    letterSpacing: 0.5,
  },
  hiddenInput: {
    position: 'absolute',
    opacity: 0,
    width: 1,
    height: 1,
  },
});

export default UnlockScreen;
