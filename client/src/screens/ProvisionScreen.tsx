/**
 * ============================================================================
 *  VEIL — PROVISION SCREEN (OBSIDIAN PRISM)
 * ============================================================================
 *  Initial dual-partition cryptographic setup:
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
  ScrollView,
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
import PrismButton from '../components/PrismButton';
import PrismInput from '../components/PrismInput';
import CryptoLabel from '../components/CryptoLabel';
import FingerprintDisplay from '../components/FingerprintDisplay';
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
      if (Platform.OS !== 'web') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      }

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
        <View style={styles.responsiveShell}>
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {/* Header */}
            <View style={styles.header}>
              <Text style={[Type.h1, styles.title]}>INITIALIZE VEIL</Text>
              <CryptoLabel variant="cyan" size="xs" containerStyle={{ marginTop: 4 }}>
                DUAL-PARTITION CRYPTOGRAPHIC PROVISIONING
              </CryptoLabel>
            </View>

            {/* Architecture Overview */}
            <PrismSurface
              radius={Radius.md}
              style={styles.card}
              contentStyle={styles.cardContent}
              tint={withAlpha(Palette.voidTrench, 0.75)}
            >
              <CryptoLabel variant="lime" dot size="xs">
                PLAUSIBLE DENIABILITY
              </CryptoLabel>
              <Text style={styles.infoText}>
                Veil provisions two independent SQLite partitions simultaneously. Your Master PIN
                opens your real persona; your Ghost PIN opens a plausible decoy vault to withstand
                physical coercion.
              </Text>
            </PrismSurface>

            {/* Primary Identity Section */}
            <PrismSurface
              radius={Radius.md}
              style={styles.section}
              contentStyle={styles.sectionContent}
              tint={withAlpha(Palette.glassObsidian, 0.6)}
            >
              <View style={styles.sectionHeaderRow}>
                <CryptoLabel variant="cyan" dot size="xs">
                  PRIMARY PARTITION
                </CryptoLabel>
                <Text style={styles.badgeText}>MASK 0</Text>
              </View>

              <Text style={styles.inputPrompt}>Identity Fingerprint</Text>
              <FingerprintDisplay
                fingerprint={primaryMask.fingerprint}
                copyable
                size="sm"
                style={styles.fpBox}
              />

              <PrismInput
                value={masterPin}
                onChangeText={(val) => {
                  setMasterPin(val.replace(/\D/g, '').slice(0, 8));
                  setError(null);
                }}
                label="MASTER SECURITY PIN (MIN 6 DIGITS)"
                placeholder="Enter 6-8 digit PIN"
                keyboardType="numeric"
                secureTextEntry
                maxLength={8}
                mono
                autoFocus
              />
            </PrismSurface>

            {/* Ghost Identity Section */}
            <PrismSurface
              radius={Radius.md}
              style={styles.section}
              contentStyle={styles.sectionContent}
              tint={withAlpha(Palette.glassShroud, 0.6)}
              active
              glowColor={withAlpha(Palette.prismMagenta, 0.2)}
            >
              <View style={styles.sectionHeaderRow}>
                <CryptoLabel variant="magenta" dot size="xs">
                  GHOST DECOY PARTITION
                </CryptoLabel>
                <Text style={styles.badgeTextGhost}>DURESS SAFE</Text>
              </View>

              <Text style={styles.inputPrompt}>Decoy Persona Fingerprint</Text>
              <FingerprintDisplay
                fingerprint={ghostMask.fingerprint}
                copyable
                size="sm"
                style={styles.fpBox}
              />

              <PrismInput
                value={ghostPin}
                onChangeText={(val) => {
                  setGhostPin(val.replace(/\D/g, '').slice(0, 8));
                  setError(null);
                }}
                label="GHOST RECOVERY PIN (MUST BE DIFFERENT)"
                placeholder="Enter distinct 6-8 digit PIN"
                keyboardType="numeric"
                secureTextEntry
                maxLength={8}
                mono
              />
            </PrismSurface>

            {error && (
              <CryptoLabel
                variant="magenta"
                size="sm"
                containerStyle={{ alignSelf: 'center', marginVertical: Space.sm }}
              >
                {error}
              </CryptoLabel>
            )}

            {/* Submit Action */}
            <PrismButton
              title={loading ? 'CALCULATING ARGON2ID PROOF…' : 'ENGAGE CRYPTOGRAPHIC LENS'}
              variant="primary"
              size="lg"
              loading={loading}
              disabled={loading || masterPin.length < 6 || ghostPin.length < 6}
              onPress={handleProvision}
              style={styles.submitBtn}
            />
          </ScrollView>
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
    maxWidth: 480,
    alignSelf: 'center',
  },
  scrollContent: {
    paddingHorizontal: Space.lg,
    paddingTop: Space.md,
    paddingBottom: Space.xxl,
  },
  header: {
    alignItems: 'center',
    marginVertical: Space.md,
  },
  title: {
    fontSize: 24,
    lineHeight: 30,
    color: Palette.prismCyan,
    letterSpacing: 4,
  },
  card: {
    marginBottom: Space.md,
  },
  cardContent: {
    padding: Space.md,
  },
  infoText: {
    fontFamily: 'system-ui, sans-serif',
    fontSize: 12.5,
    lineHeight: 18,
    color: Palette.textHud,
    marginTop: Space.xs,
  },
  section: {
    marginBottom: Space.md,
  },
  sectionContent: {
    padding: Space.md,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Space.xs,
  },
  badgeText: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: Palette.prismCyan,
    letterSpacing: 1,
  },
  badgeTextGhost: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: Palette.prismMagenta,
    letterSpacing: 1,
  },
  inputPrompt: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: Palette.textMuted,
    letterSpacing: 1.1,
    marginTop: Space.xs,
    marginBottom: 2,
    textTransform: 'uppercase',
  },
  fpBox: {
    marginBottom: Space.xs,
  },
  submitBtn: {
    marginTop: Space.md,
    marginBottom: Space.xl,
  },
});

export default ProvisionScreen;
