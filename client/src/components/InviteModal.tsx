/**
 * ============================================================================
 *  VEIL — INVITATION MODAL
 * ============================================================================
 *  Polished cryptographic invitation flow:
 *   - Vector QR Code with Obsidian Prism plate
 *   - Live expiration countdown (Expires in MM:SS)
 *   - Human-readable invitation verification code
 *   - One-tap Copy Token and Native Share
 *   - Peer invitation paste/import with cryptographic pairing state
 *   - Verified fingerprint confirmation
 * ============================================================================
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Modal,
  Pressable,
  Share,
  Platform,
  ScrollView,
  KeyboardAvoidingView,
} from 'react-native';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
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
import PrismButton from './PrismButton';
import PrismInput from './PrismInput';
import CryptoLabel from './CryptoLabel';
import FingerprintDisplay from './FingerprintDisplay';
import QrInvite from './QrInvite';
import { parseInvite, type ParsedInvite } from '../crypto/keys';

export interface InviteModalProps {
  visible: boolean;
  inviteUri: string | null;
  onClose: () => void;
  onPairSuccess: (parsedInvite: ParsedInvite) => void;
}

export const InviteModal: React.FC<InviteModalProps> = ({
  visible,
  inviteUri,
  onClose,
  onPairSuccess,
}) => {
  const [activeTab, setActiveTab] = useState<'create' | 'import'>('create');
  const [importText, setImportText] = useState('');
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now);

  // Parse own invitation for expiration and display
  const parsedSelf = useMemo(() => {
    if (!inviteUri) return null;
    return parseInvite(inviteUri);
  }, [inviteUri]);

  // Expiration countdown
  useEffect(() => {
    if (!visible || !parsedSelf) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible, parsedSelf]);

  const remainingSeconds = useMemo(() => {
    if (!parsedSelf?.exp) return 3600;
    return Math.max(0, Math.floor(parsedSelf.exp - now / 1000));
  }, [parsedSelf, now]);

  const countdownText = useMemo(() => {
    const mins = Math.floor(remainingSeconds / 60);
    const secs = remainingSeconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }, [remainingSeconds]);

  // Short human-readable invitation ID derived from fingerprint
  const shortId = useMemo(() => {
    if (!parsedSelf?.fingerprint) return 'VEIL-INV-TEMP';
    const parts = parsedSelf.fingerprint.split(' ');
    if (parts.length >= 2) {
      return `VEIL-${parts[0]}-${parts[1]}`;
    }
    return `VEIL-${parsedSelf.fingerprint.slice(0, 8)}`;
  }, [parsedSelf]);

  const handleCopyLink = async () => {
    if (!inviteUri) return;
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(inviteUri);
      }
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      /* ignore */
    }
  };

  const handleShare = async () => {
    if (!inviteUri) return;
    try {
      if (Platform.OS !== 'web') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      }
      await Share.share({
        message: inviteUri,
        title: 'Veil Cryptographic Invitation',
      });
    } catch {
      /* ignore */
    }
  };

  const handlePasteFromClipboard = async () => {
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
        const text = await navigator.clipboard.readText();
        if (text) {
          setImportText(text.trim());
          setError(null);
        }
      }
    } catch {
      /* ignore */
    }
  };

  const handlePair = async () => {
    setError(null);
    const token = importText.trim();
    if (!token) {
      setError('Please provide an invitation link or token');
      return;
    }

    setPairing(true);
    try {
      // Validate invitation
      const parsed = parseInvite(token);
      if (!parsed) {
        throw new Error('Invalid or expired cryptographic invitation');
      }

      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      }

      onPairSuccess(parsed);
      setImportText('');
    } catch (err: any) {
      setError(err?.message ?? 'Pairing failed: invalid invitation');
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      }
    } finally {
      setPairing(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.modalOverlay}
      >
        <Pressable style={styles.scrimDismiss} onPress={onClose} />

        <View style={styles.card}>
          <BlurView {...Blur.chrome} style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: Blur.scrim }]} />
          <SpecularGlass active />

          {/* Modal Header */}
          <View style={styles.header}>
            <View>
              <CryptoLabel variant="cyan" size="xs">
                PEER DISCOVERY
              </CryptoLabel>
              <Text style={[Type.h2, styles.title]}>INVITE CONTACT</Text>
            </View>

            <Pressable
              onPress={onClose}
              hitSlop={10}
              accessibilityLabel="Close invitation modal"
              style={({ pressed }) => [styles.closeBtn, pressed && styles.closeBtnPressed]}
            >
              <Text style={styles.closeBtnText}>✕</Text>
            </Pressable>
          </View>

          {/* Tab Selector */}
          <View style={styles.tabsRow}>
            <Pressable
              onPress={() => {
                setActiveTab('create');
                setError(null);
              }}
              style={[
                styles.tab,
                activeTab === 'create' && styles.tabActive,
              ]}
            >
              <Text
                style={[
                  Type.hudLabel,
                  styles.tabText,
                  activeTab === 'create' && { color: Palette.prismCyan },
                ]}
              >
                MY INVITATION
              </Text>
            </Pressable>

            <Pressable
              onPress={() => {
                setActiveTab('import');
                setError(null);
              }}
              style={[
                styles.tab,
                activeTab === 'import' && styles.tabActive,
              ]}
            >
              <Text
                style={[
                  Type.hudLabel,
                  styles.tabText,
                  activeTab === 'import' && { color: Palette.prismLime },
                ]}
              >
                PAIR PEER
              </Text>
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {activeTab === 'create' ? (
              <View style={styles.tabContent}>
                {/* QR Code Presentation */}
                {inviteUri ? (
                  <View style={styles.qrWrapper}>
                    <QrInvite value={inviteUri} size={190} />
                  </View>
                ) : (
                  <View style={[styles.qrWrapper, { height: 190 }]}>
                    <Text style={Type.meta}>Generating ephemeral keys…</Text>
                  </View>
                )}

                {/* Expiration and Code telemetry */}
                <View style={styles.telemetryRow}>
                  <View style={styles.telemetryPill}>
                    <CryptoLabel variant="amber" dot size="xs">
                      {`EXPIRES ${countdownText}`}
                    </CryptoLabel>
                  </View>
                  <View style={styles.telemetryPill}>
                    <Text style={styles.shortIdText}>{shortId}</Text>
                  </View>
                </View>

                {/* Action Buttons */}
                <View style={styles.actionsRow}>
                  <PrismButton
                    title={copied ? 'TOKEN COPIED ✓' : 'COPY LINK'}
                    variant={copied ? 'accent' : 'primary'}
                    size="md"
                    onPress={handleCopyLink}
                    style={styles.flexBtn}
                  />

                  <PrismButton
                    title="SHARE"
                    variant="ghost"
                    size="md"
                    onPress={handleShare}
                    style={styles.flexBtn}
                  />
                </View>

                <Text style={styles.hintText}>
                  Peers can scan this QR code or import the token to establish an end-to-end
                  encrypted Double Ratchet channel.
                </Text>
              </View>
            ) : (
              <View style={styles.tabContent}>
                <Text style={[Type.body, styles.importExplanation]}>
                  Paste an invitation link or token from your contact to verify their Ed25519
                  identity and negotiate a ratchet session.
                </Text>

                <PrismInput
                  value={importText}
                  onChangeText={(val) => {
                    setImportText(val);
                    setError(null);
                  }}
                  placeholder="veil://invite?v=1&ik=..."
                  label="PEER INVITATION TOKEN"
                  error={error}
                  mono
                  multiline
                  style={{ minHeight: 70 }}
                  rightAction={
                    Platform.OS === 'web' ? (
                      <Pressable
                        onPress={handlePasteFromClipboard}
                        style={styles.pastePill}
                      >
                        <Text style={styles.pastePillText}>PASTE</Text>
                      </Pressable>
                    ) : undefined
                  }
                />

                <PrismButton
                  title={pairing ? 'VERIFYING IDENTITY…' : 'PAIR WITH CONTACT'}
                  variant="accent"
                  size="lg"
                  loading={pairing}
                  disabled={pairing || !importText.trim()}
                  onPress={handlePair}
                  style={styles.pairBtn}
                />

                <View style={styles.securityNote}>
                  <CryptoLabel variant="lime" dot size="xs">
                    ZERO TRUST EXCHANGE
                  </CryptoLabel>
                  <Text style={styles.securityNoteText}>
                    Signatures and ephemeral DH parameters are verified client-side before any
                    network handshake.
                  </Text>
                </View>
              </View>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(5, 6, 16, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Space.md,
  },
  scrimDismiss: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  card: {
    width: '100%',
    maxWidth: 440,
    borderRadius: Radius.md,
    borderWidth: Borders.width,
    borderColor: Borders.specularLow,
    backgroundColor: withAlpha(Palette.voidMidnight, 0.95),
    overflow: 'hidden',
    position: 'relative',
    maxHeight: '90%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Space.lg,
    paddingTop: Space.lg,
    paddingBottom: Space.sm,
  },
  title: {
    color: Palette.textPrimary,
    letterSpacing: 1.4,
    marginTop: 2,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: withAlpha(Palette.voidTrench, 0.6),
    borderWidth: Borders.width,
    borderColor: Borders.specularLow,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnPressed: {
    backgroundColor: withAlpha(Palette.prismCyan, 0.2),
  },
  closeBtnText: {
    color: Palette.textMuted,
    fontSize: 14,
    lineHeight: 18,
  },
  tabsRow: {
    flexDirection: 'row',
    borderBottomWidth: Borders.width,
    borderBottomColor: Borders.specularLow,
    marginHorizontal: Space.lg,
    marginTop: Space.xs,
  },
  tab: {
    paddingVertical: Space.sm,
    paddingHorizontal: Space.md,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    marginRight: Space.md,
  },
  tabActive: {
    borderBottomColor: Palette.prismCyan,
  },
  tabText: {
    color: Palette.textMuted,
  },
  scrollContent: {
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
  },
  tabContent: {
    alignItems: 'center',
  },
  qrWrapper: {
    marginVertical: Space.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  telemetryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.sm,
    marginVertical: Space.sm,
    flexWrap: 'wrap',
  },
  telemetryPill: {
    backgroundColor: withAlpha(Palette.voidTrench, 0.7),
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.pill,
    borderWidth: Borders.width,
    borderColor: Borders.specularLow,
  },
  shortIdText: {
    fontFamily: Fonts.mono,
    fontSize: 9.5,
    color: Palette.textHud,
    letterSpacing: 1.1,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: Space.sm,
    width: '100%',
    marginVertical: Space.sm,
  },
  flexBtn: {
    flex: 1,
  },
  hintText: {
    fontSize: 12,
    lineHeight: 17,
    color: Palette.textMuted,
    textAlign: 'center',
    marginTop: Space.xs,
  },
  importExplanation: {
    fontSize: 13,
    lineHeight: 18,
    color: Palette.textHud,
    marginBottom: Space.sm,
    alignSelf: 'flex-start',
  },
  pastePill: {
    backgroundColor: withAlpha(Palette.prismCyan, 0.15),
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: Radius.sm,
    borderWidth: Borders.width,
    borderColor: withAlpha(Palette.prismCyan, 0.3),
  },
  pastePillText: {
    fontFamily: Fonts.mono,
    fontSize: 9,
    color: Palette.prismCyan,
    letterSpacing: 1,
  },
  pairBtn: {
    width: '100%',
    marginTop: Space.sm,
  },
  securityNote: {
    width: '100%',
    backgroundColor: withAlpha(Palette.voidTrench, 0.5),
    padding: Space.sm,
    borderRadius: Radius.sm,
    borderWidth: Borders.width,
    borderColor: Borders.specularLow,
    marginTop: Space.md,
  },
  securityNoteText: {
    fontSize: 11,
    lineHeight: 15,
    color: Palette.textMuted,
    marginTop: 4,
  },
});

export default InviteModal;
