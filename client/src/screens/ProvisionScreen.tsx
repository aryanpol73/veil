/**
 * ============================================================================
 *  VEIL — PROVISION SCREEN (INITIAL DUAL-PARTITION SETUP)
 * ============================================================================
 *  Creates both primary and decoy vaults simultaneously:
 *   - Generates independent cryptographic master seeds
 *   - Derives Ed25519/X25519 identities for primary and ghost personas
 *   - Sets Master PIN (Primary Vault) and Ghost PIN (Decoy Vault)
 *   - Runs Argon2id stretching and page padding in one pass
 * ============================================================================
 */

import React, { useMemo, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  Pressable,
  ScrollView,
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
  generateMasterSeed,
  deriveMask,
} from '../crypto/keys';
import {
  provisionVaults,
  unlockWithPin,
  activeMaskIndex,
  loadSealedMasterSeed,
} from '../storage/db';
import { identityManager } from '../identity/IdentityManager';
import { messageService } from '../messaging/MessageService';
import type { RootNavigationProp } from '../types/navigation';

export interface ProvisionScreenProps {
  navigation: RootNavigationProp;
}

export const ProvisionScreen: React.FC<ProvisionScreenProps> = ({ navigation }) => {
  const [masterPin, setMasterPin] = useState('');
  const [ghostPin, setGhostPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Generate seeds and derive fingerprints once on mount
  const { primarySeed, ghostSeed, primaryMask, ghostMask } = useMemo(() => {
    const pSeed = generateMasterSeed();
    const gSeed = generateMasterSeed();
    const pMask = deriveMask(pSeed, 0);
    const gMask = deriveMask(gSeed, 1);
    return {
      primarySeed: pSeed,
      ghostSeed: gSeed,
      primaryMask: pMask,
      ghostMask: gMask,
    };
  }, []);

  const handleProvision = async () => {
    if (loading) return;
    setError(null);

    if (masterPin.length < 6 || ghostPin.length < 6) {
      setError('PINs must be at least 6 digits');
      return;
    }

    if (masterPin === ghostPin) {
      setError('Master and Ghost PINs must be distinct');
      return;
    }

    setLoading(true);
    try {
      await provisionVaults({
        masterPin,
        ghostPin,
        primaryFingerprint: primaryMask.fingerprint,
        ghostFingerprint: ghostMask.fingerprint,
        primarySeed,
        ghostSeed,
      });

      // Automatically unlock into primary vault
      const res = await unlockWithPin(masterPin);
      if (res.ok) {
        const seed = loadSealedMasterSeed();
        if (seed) {
          const mask = identityManager.setIdentity(seed, activeMaskIndex());
          messageService.setActiveMask(mask);
        }
        navigation.replace('ThreadList');
      } else {
        navigation.replace('Unlock');
      }
    } catch (err: any) {
      setError(err?.message ?? 'Provisioning failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.root}>
      <PrismBackdrop />
      <SafeAreaView style={styles.safe}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <Text style={[Type.h1, styles.title]}>INITIALIZE VEIL</Text>
            <Text style={[Type.hudLabel, styles.subtitle]}>
              CRYPTOGRAPHIC DUAL-VAULT PROVISIONING
            </Text>
          </View>

          <View style={styles.card}>
            <BlurView {...Blur.surface} style={StyleSheet.absoluteFill} />
            <SpecularGlass />
            <Text style={[Type.hudLabel, { color: Palette.prismCyan }]}>
              DUAL PARTITION ARCHITECTURE
            </Text>
            <Text style={[Type.body, styles.infoText]}>
              Veil initializes two separate vaults in one pass. Your Master PIN
              unlocks your primary identity. Your Ghost PIN unlocks a plausible decoy
              vault with simulated history to protect against coercion.
            </Text>
          </View>

          {/* Primary Identity Preview */}
          <View style={styles.section}>
            <Text style={[Type.hudLabel, styles.sectionHeader]}>
              PRIMARY IDENTITY FINGERPRINT
            </Text>
            <View style={styles.fingerprintBox}>
              <SpecularGlass />
              <Text style={Type.fingerprint}>{primaryMask.fingerprint}</Text>
            </View>
            <Text style={[Type.hudLabel, styles.inputLabel]}>
              MASTER PIN (MIN 6 DIGITS)
            </Text>
            <TextInput
              value={masterPin}
              onChangeText={setMasterPin}
              keyboardType="numeric"
              secureTextEntry
              maxLength={8}
              placeholder="••••••"
              placeholderTextColor={Palette.textMuted}
              style={[Type.input, styles.pinInput]}
            />
          </View>

          {/* Ghost Persona Preview */}
          <View style={styles.section}>
            <Text style={[Type.hudLabel, styles.sectionHeader]}>
              GHOST PERSONA FINGERPRINT (DECOY)
            </Text>
            <View style={styles.fingerprintBox}>
              <SpecularGlass />
              <Text style={Type.fingerprint}>{ghostMask.fingerprint}</Text>
            </View>
            <Text style={[Type.hudLabel, styles.inputLabel]}>
              GHOST PIN (DURESS RECOVERY)
            </Text>
            <TextInput
              value={ghostPin}
              onChangeText={setGhostPin}
              keyboardType="numeric"
              secureTextEntry
              maxLength={8}
              placeholder="••••••"
              placeholderTextColor={Palette.textMuted}
              style={[Type.input, styles.pinInput]}
            />
          </View>

          {error && <Text style={[Type.meta, styles.errorText]}>{error}</Text>}

          <Pressable
            onPress={handleProvision}
            disabled={loading}
            style={({ pressed }) => [
              styles.submitBtn,
              pressed && styles.submitBtnPressed,
              loading && { opacity: 0.6 },
            ]}
          >
            <SpecularGlass active />
            {loading ? (
              <ActivityIndicator color={Palette.textInverse} />
            ) : (
              <Text style={[Type.h2, styles.submitBtnText]}>
                ENGAGE CRYPTOGRAPHIC LENS
              </Text>
            )}
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.voidMidnight },
  safe: { flex: 1 },
  scrollContent: { padding: Space.lg, paddingBottom: Space.xxl },
  header: { alignItems: 'center', marginVertical: Space.lg },
  title: {
    fontSize: 22,
    lineHeight: 28,
    color: Palette.prismCyan,
    letterSpacing: 3,
  },
  subtitle: { marginTop: 4, color: Palette.textHud, letterSpacing: 1.5 },
  card: {
    padding: Space.lg,
    borderRadius: Radius.md,
    borderWidth: Borders.width,
    borderColor: Borders.specularLow,
    backgroundColor: withAlpha(Palette.glassObsidian, 0.7),
    marginBottom: Space.lg,
    overflow: 'hidden',
  },
  infoText: {
    marginTop: Space.sm,
    fontSize: 13,
    lineHeight: 18,
    color: Palette.textPrimary,
  },
  section: {
    marginBottom: Space.lg,
    padding: Space.md,
    borderRadius: Radius.md,
    borderWidth: Borders.width,
    borderColor: Borders.specularLow,
    backgroundColor: withAlpha(Palette.voidMidnight, 0.6),
  },
  sectionHeader: { color: Palette.prismLime, marginBottom: Space.xs },
  fingerprintBox: {
    padding: Space.sm,
    backgroundColor: withAlpha(Palette.voidTrench, 0.6),
    borderRadius: Radius.sm,
    borderWidth: Borders.width,
    borderColor: Borders.specularLow,
    alignItems: 'center',
    marginBottom: Space.sm,
  },
  inputLabel: { marginTop: Space.xs, color: Palette.textHud },
  pinInput: {
    backgroundColor: withAlpha(Palette.glassElevated, 0.7),
    borderWidth: Borders.width,
    borderColor: Borders.specularLow,
    borderRadius: Radius.sm,
    paddingHorizontal: Space.md,
    paddingVertical: Space.sm,
    color: Palette.prismCyan,
    fontSize: 18,
    letterSpacing: 4,
    marginTop: Space.xs,
  },
  errorText: {
    color: Palette.danger,
    textAlign: 'center',
    marginBottom: Space.md,
    letterSpacing: 1,
  },
  submitBtn: {
    backgroundColor: Palette.prismCyan,
    paddingVertical: Space.md,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Space.md,
    ...glow(Palette.prismCyan, 16),
  },
  submitBtnPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  submitBtnText: {
    color: Palette.textInverse,
    fontSize: 14,
    fontWeight: 'bold',
    letterSpacing: 1.5,
  },
});

export default ProvisionScreen;
