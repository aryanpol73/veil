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
} from 'react-native';
import { BlurView } from 'expo-blur';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import {
  Palette,
  Type,
  Borders,
  Space,
  Radius,
  Blur,
  withAlpha,
  glow,
} from '../theme/obsidianPrism';
import PrismBackdrop from '../components/PrismBackdrop';
import SpecularGlass from '../components/SpecularGlass';
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
        try {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        } catch {
          /* ignore */
        }
        setError('AUTHENTICATION FAILED');
        setPin('');
        return;
      }

      try {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch {
        /* ignore */
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
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    } catch {
      /* ignore */
    }

    const next = pin + num;
    setPin(next);
    if (next.length === 6) {
      handleUnlock(next);
    }
  };

  const handleDelete = () => {
    if (loading || pin.length === 0) return;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    } catch {
      /* ignore */
    }
    setPin(pin.slice(0, -1));
  };

  return (
    <View style={styles.root}>
      <PrismBackdrop />
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <Text style={[Type.h1, styles.title]}>VEIL</Text>
          <Text style={[Type.hudLabel, styles.subtitle]}>
            OBSIDIAN CRYPTOGRAPHIC LENS
          </Text>
        </View>

        {/* PIN Indicators */}
        <View style={styles.indicatorContainer}>
          <View style={styles.dotRow}>
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
          </View>

          {error && <Text style={[Type.meta, styles.errorText]}>{error}</Text>}
          {loading && (
            <ActivityIndicator
              color={Palette.prismCyan}
              style={{ marginTop: Space.sm }}
            />
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
                  <Pressable
                    key={bIdx}
                    onPress={() => (isDel ? handleDelete() : handleKeyPress(btn))}
                    disabled={loading}
                    style={({ pressed }) => [
                      styles.keyBtn,
                      pressed && styles.keyBtnPressed,
                    ]}
                  >
                    <BlurView {...Blur.surface} style={StyleSheet.absoluteFill} />
                    <SpecularGlass />
                    <Text
                      style={[
                        Type.h2,
                        isDel ? styles.delKeyText : styles.keyText,
                      ]}
                    >
                      {btn}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>

        {/* Hidden TextInput for accessibility and password managers */}
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
      </SafeAreaView>
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.voidMidnight },
  safe: {
    flex: 1,
    justifyContent: 'space-between',
    paddingHorizontal: Space.xl,
    paddingVertical: Space.lg,
  },
  header: { alignItems: 'center', marginTop: Space.xl },
  title: {
    fontSize: 28,
    lineHeight: 34,
    color: Palette.prismCyan,
    letterSpacing: 4,
  },
  subtitle: { marginTop: 6, color: Palette.textHud, letterSpacing: 2 },
  indicatorContainer: { alignItems: 'center', marginVertical: Space.xl },
  dotRow: { flexDirection: 'row', gap: Space.md },
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: Borders.activeHigh,
    backgroundColor: withAlpha(Palette.voidTrench, 0.4),
  },
  dotFilled: {
    backgroundColor: Palette.prismCyan,
    ...glow(Palette.prismCyan, 8),
  },
  dotError: {
    borderColor: Palette.danger,
    backgroundColor: withAlpha(Palette.danger, 0.5),
  },
  errorText: { color: Palette.danger, marginTop: Space.md, letterSpacing: 1.2 },
  keypad: { width: '100%', marginBottom: Space.lg },
  keypadRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: Space.md,
  },
  keyBtn: {
    width: 76,
    height: 76,
    borderRadius: Radius.bubble,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: Borders.width,
    borderColor: Borders.specularLow,
    backgroundColor: withAlpha(Palette.glassObsidian, 0.6),
    overflow: 'hidden',
  },
  keyBtnPressed: {
    backgroundColor: withAlpha(Palette.prismCyan, 0.15),
    borderColor: Borders.activeHigh,
  },
  keyBtnEmpty: { width: 76, height: 76 },
  keyText: { fontSize: 24, lineHeight: 28, color: Palette.textPrimary },
  delKeyText: { fontSize: 20, color: Palette.textHud },
  hiddenInput: { position: 'absolute', opacity: 0, width: 0, height: 0 },
});

export default UnlockScreen;
