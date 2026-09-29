/**
 * ============================================================================
 *  VEIL — THREAD LIST SCREEN
 * ============================================================================
 *  Displays active encrypted conversations, relay status, invitation sharing,
 *  and invitation importing.
 * ============================================================================
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  FlatList,
  Pressable,
  Modal,
  TextInput,
  Share,
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
import { getDb, lockVault } from '../storage/db';
import { identityManager } from '../identity/IdentityManager';
import { contactManager } from '../protocol/contacts/ContactManager';
import { createInvite, parseInvite } from '../crypto/keys';
import { relayClient, type ConnectionStatus } from '../transport/RelayClient';
import type { Thread } from '../types/models';
import type { RootNavigationProp } from '../types/navigation';

export interface ThreadListScreenProps {
  navigation: RootNavigationProp;
}

export const ThreadListScreen: React.FC<ThreadListScreenProps> = ({ navigation }) => {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [relayStatus, setRelayStatus] = useState<ConnectionStatus>('disconnected');
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [generatedInviteUri, setGeneratedInviteUri] = useState<string | null>(null);
  const [importUri, setImportUri] = useState('');
  const [importError, setImportError] = useState<string | null>(null);

  const activeMask = identityManager.getActiveMask();

  const loadThreads = useCallback(() => {
    try {
      const db = getDb();
      const rows = db.execute<any>(
        'SELECT * FROM threads ORDER BY last_activity_at DESC',
      ).rows;

      const fullThreads: Thread[] = rows.map((r) => {
        const contact = contactManager.getContact(r.contact_id);
        return {
          id: r.id,
          contactId: r.contact_id,
          defaultRetention: r.default_retention,
          lastActivityAt: r.last_activity_at,
          unreadCount: r.unread_count,
          contact: contact ?? undefined,
        };
      });
      setThreads(fullThreads);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadThreads();
    const sub = relayClient.onStatusChange(setRelayStatus);
    const interval = setInterval(loadThreads, 3000);
    return () => {
      sub();
      clearInterval(interval);
    };
  }, [loadThreads]);

  const handleLock = async () => {
    try {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    } catch {
      /* ignore */
    }
    await lockVault();
    identityManager.lock();
    navigation.replace('Unlock');
  };

  const handleCreateInvite = () => {
    if (!activeMask) return;
    try {
      Haptics.selectionAsync().catch(() => {});
    } catch {
      /* ignore */
    }
    const { uri } = createInvite(activeMask);
    setGeneratedInviteUri(uri);
    setShowInviteModal(true);
  };

  const handleShareInvite = async () => {
    if (!generatedInviteUri) return;
    try {
      await Share.share({
        message: generatedInviteUri,
        title: 'Veil Cryptographic Invitation',
      });
    } catch {
      /* ignore */
    }
  };

  const handleImportInvite = () => {
    setImportError(null);
    if (!importUri.trim()) return;

    const parsed = parseInvite(importUri.trim());
    if (!parsed) {
      setImportError('Invalid or expired invitation URI');
      return;
    }

    try {
      const { thread } = contactManager.createFromInvite(
        parsed,
        activeMask?.index ?? 0,
      );
      setShowInviteModal(false);
      setImportUri('');
      setGeneratedInviteUri(null);
      loadThreads();
      navigation.navigate('Chat', {
        threadId: thread.id,
        contactId: thread.contactId,
      });
    } catch (err: any) {
      setImportError(err?.message ?? 'Failed to import invite');
    }
  };

  return (
    <View style={styles.root}>
      <PrismBackdrop />
      <SafeAreaView style={styles.safe}>
        {/* Top App Bar */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={[Type.h1, styles.brandTitle]}>VEIL</Text>
            <View style={styles.statusRow}>
              <View
                style={[
                  styles.statusDot,
                  relayStatus === 'connected'
                    ? styles.statusOnline
                    : relayStatus === 'connecting'
                    ? styles.statusConnecting
                    : styles.statusOffline,
                ]}
              />
              <Text style={Type.hudLabel}>
                {relayStatus === 'connected' ? 'RELAY LIVE' : relayStatus.toUpperCase()}
              </Text>
            </View>
          </View>

          <View style={styles.headerRight}>
            <Pressable
              onPress={handleCreateInvite}
              style={({ pressed }) => [styles.iconBtn, pressed && styles.btnPressed]}
              accessibilityLabel="Create or import invitation"
            >
              <SpecularGlass />
              <Text style={styles.iconBtnText}>+</Text>
            </Pressable>

            <Pressable
              onPress={handleLock}
              style={({ pressed }) => [styles.iconBtn, pressed && styles.btnPressed]}
              accessibilityLabel="Lock vault"
            >
              <SpecularGlass />
              <Text style={styles.iconBtnText}>⚿</Text>
            </Pressable>
          </View>
        </View>

        {/* Identity HUD Card */}
        {activeMask && (
          <View style={styles.identityCard}>
            <BlurView {...Blur.surface} style={StyleSheet.absoluteFill} />
            <SpecularGlass />
            <View style={styles.idCardHeader}>
              <Text style={[Type.hudLabel, { color: Palette.prismLime }]}>
                MASK · PERSONAL
              </Text>
              <Text style={Type.hudLabel}>
                DEVICE {identityManager.getDeviceFingerprint()}
              </Text>
            </View>
            <Text style={[Type.fingerprint, styles.idFp]}>
              {activeMask.fingerprint}
            </Text>
          </View>
        )}

        {/* Conversation Threads */}
        <FlatList
          data={threads}
          keyExtractor={(item) => item.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => {
            const alias = item.contact?.alias ?? 'Unknown Peer';
            const fp = item.contact?.fingerprint ?? '';
            const verified = item.contact?.verificationState === 'VERIFIED';

            return (
              <Pressable
                onPress={() => {
                  try {
                    Haptics.selectionAsync().catch(() => {});
                  } catch {
                    /* ignore */
                  }
                  navigation.navigate('Chat', {
                    threadId: item.id,
                    contactId: item.contactId,
                  });
                }}
                style={({ pressed }) => [
                  styles.threadItem,
                  pressed && styles.threadItemPressed,
                ]}
              >
                <BlurView {...Blur.surface} style={StyleSheet.absoluteFill} />
                <SpecularGlass />
                <View style={styles.threadRow}>
                  <View style={styles.threadAvatar}>
                    <Text style={styles.avatarLetter}>
                      {alias.slice(0, 1).toUpperCase()}
                    </Text>
                  </View>
                  <View style={styles.threadInfo}>
                    <View style={styles.threadTopLine}>
                      <Text style={Type.h2}>{alias}</Text>
                      {verified && (
                        <View style={styles.verifiedBadge}>
                          <Text style={styles.verifiedText}>✓ VERIFIED</Text>
                        </View>
                      )}
                    </View>
                    <Text style={Type.fingerprint} numberOfLines={1}>
                      {fp}
                    </Text>
                  </View>
                  {item.unreadCount > 0 && (
                    <View style={styles.unreadPill}>
                      <Text style={styles.unreadText}>{item.unreadCount}</Text>
                    </View>
                  )}
                </View>
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={[Type.h2, styles.emptyTitle]}>No Active Channels</Text>
              <Text style={[Type.body, styles.emptySubtitle]}>
                Create an invitation to establish a cryptographically paired conversation.
              </Text>
            </View>
          }
        />

        {/* Invitation Modal */}
        <Modal
          visible={showInviteModal}
          transparent
          animationType="fade"
          onRequestClose={() => setShowInviteModal(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <BlurView {...Blur.chrome} style={StyleSheet.absoluteFill} />
              <SpecularGlass />

              <Text style={[Type.h2, styles.modalTitle]}>INVITATIONS</Text>

              {generatedInviteUri && (
                <View style={styles.inviteSection}>
                  <Text style={[Type.hudLabel, { color: Palette.prismCyan }]}>
                    YOUR INVITATION LINK (EXPIRES 1 HR)
                  </Text>
                  <View style={styles.uriBox}>
                    <Text style={[Type.meta, styles.uriText]} numberOfLines={2}>
                      {generatedInviteUri}
                    </Text>
                  </View>
                  <Pressable
                    onPress={handleShareInvite}
                    style={styles.shareBtn}
                  >
                    <Text style={styles.shareBtnText}>SHARE INVITATION</Text>
                  </Pressable>
                </View>
              )}

              <View style={styles.importSection}>
                <Text style={[Type.hudLabel, { color: Palette.prismLime }]}>
                  IMPORT PEER INVITATION
                </Text>
                <TextInput
                  value={importUri}
                  onChangeText={setImportUri}
                  placeholder="veil://invite?v=1&ik=..."
                  placeholderTextColor={Palette.textMuted}
                  style={styles.importInput}
                  autoCapitalize="none"
                />
                {importError && (
                  <Text style={[Type.meta, { color: Palette.danger, marginTop: 4 }]}>
                    {importError}
                  </Text>
                )}
                <Pressable
                  onPress={handleImportInvite}
                  style={styles.importBtn}
                >
                  <Text style={styles.importBtnText}>PAIR WITH CONTACT</Text>
                </Pressable>
              </View>

              <Pressable
                onPress={() => setShowInviteModal(false)}
                style={styles.closeBtn}
              >
                <Text style={styles.closeBtnText}>CLOSE</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.voidMidnight },
  safe: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Space.lg,
    paddingVertical: Space.sm,
  },
  headerLeft: { flexDirection: 'column' },
  brandTitle: {
    fontSize: 22,
    lineHeight: 26,
    color: Palette.prismCyan,
    letterSpacing: 2,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
  statusDot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  statusOnline: { backgroundColor: Palette.prismEmerald, ...glow(Palette.prismEmerald, 6) },
  statusConnecting: { backgroundColor: Palette.prismAmber },
  statusOffline: { backgroundColor: Palette.textMuted },
  headerRight: { flexDirection: 'row', gap: Space.sm },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: Radius.bubble,
    borderWidth: Borders.width,
    borderColor: Borders.specularLow,
    backgroundColor: withAlpha(Palette.glassObsidian, 0.6),
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  btnPressed: {
    backgroundColor: withAlpha(Palette.prismCyan, 0.2),
  },
  iconBtnText: {
    fontSize: 18,
    color: Palette.prismCyan,
    lineHeight: 22,
  },
  identityCard: {
    marginHorizontal: Space.lg,
    marginVertical: Space.sm,
    padding: Space.md,
    borderRadius: Radius.md,
    borderWidth: Borders.width,
    borderColor: Borders.specularLow,
    backgroundColor: withAlpha(Palette.voidTrench, 0.6),
    overflow: 'hidden',
  },
  idCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: Space.xs,
  },
  idFp: { fontSize: 11, letterSpacing: 1.2 },
  listContent: { paddingHorizontal: Space.lg, paddingBottom: Space.xl },
  threadItem: {
    marginVertical: Space.xs,
    borderRadius: Radius.md,
    borderWidth: Borders.width,
    borderColor: Borders.specularLow,
    backgroundColor: withAlpha(Palette.glassObsidian, 0.5),
    padding: Space.md,
    overflow: 'hidden',
  },
  threadItemPressed: {
    borderColor: Borders.activeHigh,
  },
  threadRow: { flexDirection: 'row', alignItems: 'center' },
  threadAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: Borders.width,
    borderColor: Borders.specularLow,
    backgroundColor: withAlpha(Palette.glassElevated, 0.8),
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: Space.md,
  },
  avatarLetter: { color: Palette.prismCyan, fontSize: 18, fontWeight: 'bold' },
  threadInfo: { flex: 1 },
  threadTopLine: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  verifiedBadge: {
    backgroundColor: withAlpha(Palette.prismLime, 0.15),
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: Radius.sm,
  },
  verifiedText: { color: Palette.prismLime, fontSize: 9, fontFamily: 'monospace' },
  unreadPill: {
    backgroundColor: Palette.prismCyan,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.pill,
  },
  unreadText: { color: Palette.textInverse, fontSize: 11, fontWeight: 'bold' },
  emptyContainer: { alignItems: 'center', marginTop: Space.xxl, paddingHorizontal: Space.xl },
  emptyTitle: { color: Palette.textHud, marginBottom: Space.xs },
  emptySubtitle: { color: Palette.textMuted, textAlign: 'center', fontSize: 13 },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(5, 6, 16, 0.8)',
    justifyContent: 'center',
    padding: Space.xl,
  },
  modalCard: {
    borderRadius: Radius.md,
    borderWidth: Borders.width,
    borderColor: Borders.specularLow,
    backgroundColor: withAlpha(Palette.voidMidnight, 0.95),
    padding: Space.lg,
    overflow: 'hidden',
  },
  modalTitle: { color: Palette.prismCyan, textAlign: 'center', marginBottom: Space.md },
  inviteSection: { marginBottom: Space.lg },
  uriBox: {
    backgroundColor: withAlpha(Palette.voidTrench, 0.7),
    padding: Space.sm,
    borderRadius: Radius.sm,
    marginVertical: Space.xs,
  },
  uriText: { color: Palette.textPrimary, fontSize: 10 },
  shareBtn: {
    backgroundColor: withAlpha(Palette.prismCyan, 0.2),
    borderWidth: Borders.width,
    borderColor: Borders.activeHigh,
    paddingVertical: Space.sm,
    borderRadius: Radius.sm,
    alignItems: 'center',
    marginTop: Space.xs,
  },
  shareBtnText: { color: Palette.prismCyan, fontSize: 11, fontWeight: 'bold' },
  importSection: { marginBottom: Space.lg },
  importInput: {
    backgroundColor: withAlpha(Palette.voidTrench, 0.7),
    borderWidth: Borders.width,
    borderColor: Borders.specularLow,
    color: Palette.textPrimary,
    fontSize: 11,
    padding: Space.sm,
    borderRadius: Radius.sm,
    marginVertical: Space.xs,
  },
  importBtn: {
    backgroundColor: withAlpha(Palette.prismLime, 0.2),
    borderWidth: Borders.width,
    borderColor: withAlpha(Palette.prismLime, 0.5),
    paddingVertical: Space.sm,
    borderRadius: Radius.sm,
    alignItems: 'center',
    marginTop: Space.xs,
  },
  importBtnText: { color: Palette.prismLime, fontSize: 11, fontWeight: 'bold' },
  closeBtn: { alignItems: 'center', paddingVertical: Space.sm },
  closeBtnText: { color: Palette.textMuted, fontSize: 12 },
});

export default ThreadListScreen;
