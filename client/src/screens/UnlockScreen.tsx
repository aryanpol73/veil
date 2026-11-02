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
import { unlockWithPin } from '../storage/db';
import { beginSession, endSession } from '../session/SessionController';
import {
  PIN_MAX_LENGTH,
  PIN_MIN_LENGTH,
  isValidPinLength,
  sanitizePin,
} from '../storage/pinPolicy';
import type { RootNavigationProp } from '../types/navigation';

const formatWait = (ms: number): string => {
  const s = Math.ceil(ms / 1000);
  return s < 60 ? `${s}S` : `${Math.ceil(s / 60)}M`;
};

export interface UnlockScreenProps {
  navigation: RootNavigationProp;
}

export const UnlockScreen: React.FC<UnlockScreenProps> = ({ navigation }) => {
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUnlock = async (enteredPin: string) => {
    if (loading || !isValidPinLength(enteredPin)) return;
    setLoading(true);
    setError(null);

    try {
      await endSession();
      const res = await unlockWithPin(enteredPin);
      if (!res.ok) {
        if (Platform.OS !== 'web') {
          try {
            await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          } catch {
            /* ignore */
          }
        }
        setError(
          res.retryAfterMs > 0
            ? `INCORRECT PIN · TRY AGAIN IN ${formatWait(res.retryAfterMs)}`
            : 'INCORRECT PIN',
        );
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

      if (!beginSession()) {
        await endSession();
        setError('INCORRECT PIN');
        setPin('');
        return;
      }

      navigation.replace('ThreadList');
    } catch {
      setError('INCORRECT PIN');
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

    // No auto-submit: PINs may be any length in the policy range, so the
    // user confirms explicitly with the submit key.
    if (pin.length >= PIN_MAX_LENGTH) return;
    setPin(pin + num);
  };

  const handleSubmit = () => {
    if (loading || !isValidPinLength(pin)) return;
    handleUnlock(pin);
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
              ENTER PIN
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
              {Array.from({ length: Math.max(PIN_MIN_LENGTH, pin.length) }, (_, idx) => idx).map((idx) => (
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
              ['✓', '0', '⌫'],
            ].map((row, rIdx) => (
              <View key={rIdx} style={styles.keypadRow}>
                {row.map((btn, bIdx) => {
                  const isDel = btn === '⌫';
                  const isSubmit = btn === '✓';
                  if (isSubmit && !isValidPinLength(pin)) {
                    return <View key={bIdx} style={styles.keyBtnEmpty} />;
                  }
                  return (
                    <PrismSurface
                      key={bIdx}
                      interactive
                      onPress={() => (isDel ? handleDelete() : isSubmit ? handleSubmit() : handleKeyPress(btn))}
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
                      accessibilityLabel={isDel ? 'Delete PIN digit' : isSubmit ? 'Unlock' : `Digit ${btn}`}
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

          {/* Hidden TextInput for accessibility / keyboard input */}
          <TextInput
            value={pin}
            onChangeText={(val) => setPin(sanitizePin(val))}
            onSubmitEditing={handleSubmit}
            keyboardType="numeric"
            maxLength={PIN_MAX_LENGTH}
            secureTextEntry
            style={styles.hiddenInput}
            autoFocus={false}
            accessibilityLabel="Enter security PIN"
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
  hiddenInput: {
    position: 'absolute',
    opacity: 0,
    width: 1,
    height: 1,
  },
});

export default UnlockScreen;
