/**
 * ============================================================================
 *  VEIL — THREAD LIST SCREEN (OBSIDIAN PRISM)
 * ============================================================================
 *  Displays active encrypted conversations, relay status, identity telemetry,
 *  deliberate cryptographic empty state, and polished invitation flow.
 * ============================================================================
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  FlatList,
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
import CryptoLabel from '../components/CryptoLabel';
import MaskHeader from '../components/MaskHeader';
import FingerprintDisplay from '../components/FingerprintDisplay';
import EmptyState from '../components/EmptyState';
import InviteModal from '../components/InviteModal';
import { getDb, lockVault } from '../storage/db';
import { identityManager } from '../identity/IdentityManager';
import { contactManager } from '../protocol/contacts/ContactManager';
import { createInvite, type ParsedInvite } from '../crypto/keys';
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
    if (Platform.OS !== 'web') {
      try {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      } catch {
        /* ignore */
      }
    }
    await lockVault();
    identityManager.lock();
    navigation.replace('Unlock');
  };

  const handleOpenInvite = () => {
    if (!activeMask) return;
    if (Platform.OS !== 'web') {
      try {
        Haptics.selectionAsync().catch(() => {});
      } catch {
        /* ignore */
      }
    }
    const { uri } = createInvite(activeMask);
    setGeneratedInviteUri(uri);
    setShowInviteModal(true);
  };

  const handlePairSuccess = (parsedInvite: ParsedInvite) => {
    try {
      const { thread } = contactManager.createFromInvite(
        parsedInvite,
        activeMask?.index ?? 0,
      );
      setShowInviteModal(false);
      loadThreads();
      navigation.navigate('Chat', {
        threadId: thread.id,
        contactId: thread.contactId,
      });
    } catch (err: any) {
      console.error('[ThreadList] Pair error:', err);
    }
  };

  return (
    <View style={styles.root}>
      <PrismBackdrop />
      <SafeAreaView style={styles.safe}>
        <View style={styles.responsiveShell}>
          {/* Top App Bar */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Text style={[Type.h1, styles.brandTitle]}>VEIL</Text>
              <CryptoLabel variant="cyan" size="xs">
                OBSIDIAN PRISM LENS
              </CryptoLabel>
            </View>

            <View style={styles.headerRight}>
              <PrismButton
                title="+ INVITE"
                variant="primary"
                size="sm"
                onPress={handleOpenInvite}
                style={styles.headerBtn}
              />

              <PrismButton
                title="⚿ LOCK"
                variant="ghost"
                size="sm"
                onPress={handleLock}
                style={styles.headerBtn}
              />
            </View>
          </View>

          {/* Compact Identity Telemetry Header */}
          {activeMask && (
            <MaskHeader
              maskLabel={activeMask.index === 0 ? 'PERSONAL' : 'GHOST'}
              fingerprint={activeMask.fingerprint}
              relayStatus={relayStatus}
              deviceFingerprint={identityManager.getDeviceFingerprint()}
            />
          )}

          {/* Active Conversation Threads */}
          <FlatList
            data={threads}
            keyExtractor={(item) => item.id}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.listContent}
            renderItem={({ item }) => {
              const alias = item.contact?.alias ?? 'Unknown Peer';
              const fp = item.contact?.fingerprint ?? '';
              const verified = item.contact?.verificationState === 'VERIFIED';
              const retention = item.defaultRetention ?? 'persistent';

              const retentionDotColor =
                retention === 'viewOnce'
                  ? Palette.prismMagenta
                  : retention === 'timed'
                  ? Palette.prismAmber
                  : Palette.prismEmerald;

              return (
                <PrismSurface
                  interactive
                  onPress={() => {
                    navigation.navigate('Chat', {
                      threadId: item.id,
                      contactId: item.contactId,
                    });
                  }}
                  style={styles.threadItem}
                  contentStyle={styles.threadInner}
                  radius={Radius.md}
                  tint={withAlpha(Palette.glassObsidian, 0.6)}
                >
                  <View style={styles.avatarPlate}>
                    <Text style={styles.avatarLetter}>
                      {alias.slice(0, 1).toUpperCase()}
                    </Text>
                    <View
                      style={[
                        styles.retentionDot,
                        { backgroundColor: retentionDotColor },
                      ]}
                    />
                  </View>

                  <View style={styles.threadInfo}>
                    <View style={styles.threadTopLine}>
                      <Text style={[Type.h2, styles.aliasText]}>{alias}</Text>
                      {verified && (
                        <View style={styles.verifiedBadge}>
                          <Text style={styles.verifiedText}>✓ VERIFIED</Text>
                        </View>
                      )}
                    </View>

                    <FingerprintDisplay
                      fingerprint={fp}
                      truncate
                      size="sm"
                      style={{ marginTop: 2 }}
                    />
                  </View>

                  {item.unreadCount > 0 && (
                    <View style={styles.unreadPill}>
                      <Text style={styles.unreadText}>{item.unreadCount}</Text>
                    </View>
                  )}
                </PrismSurface>
              );
            }}
            ListEmptyComponent={
              <EmptyState
                onInvitePress={handleOpenInvite}
                onImportPress={handleOpenInvite}
              />
            }
          />

          {/* Polished Invitation Modal */}
          <InviteModal
            visible={showInviteModal}
            inviteUri={generatedInviteUri}
            onClose={() => setShowInviteModal(false)}
            onPairSuccess={handlePairSuccess}
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
    maxWidth: 540,
    alignSelf: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Space.md,
    paddingTop: Space.xs,
    paddingBottom: Space.xs,
  },
  headerLeft: {
    flexDirection: 'column',
  },
  brandTitle: {
    fontSize: 22,
    lineHeight: 26,
    color: Palette.prismCyan,
    letterSpacing: 3,
  },
  headerRight: {
    flexDirection: 'row',
    gap: Space.xs,
    alignItems: 'center',
  },
  headerBtn: {
    minWidth: 72,
  },
  listContent: {
    paddingHorizontal: Space.md,
    paddingBottom: Space.xl,
  },
  threadItem: {
    marginVertical: Space.xs,
  },
  threadInner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Space.md,
  },
  avatarPlate: {
    width: 42,
    height: 42,
    borderRadius: Radius.sm,
    borderWidth: Borders.width,
    borderColor: Borders.specularLow,
    backgroundColor: withAlpha(Palette.voidTrench, 0.7),
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: Space.md,
    position: 'relative',
  },
  avatarLetter: {
    color: Palette.prismCyan,
    fontSize: 18,
    fontWeight: 'bold',
  },
  retentionDot: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 7,
    height: 7,
    borderRadius: 3.5,
    borderWidth: 1,
    borderColor: Palette.voidMidnight,
  },
  threadInfo: {
    flex: 1,
  },
  threadTopLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs + 2,
  },
  aliasText: {
    fontSize: 15,
    color: Palette.textPrimary,
  },
  verifiedBadge: {
    backgroundColor: withAlpha(Palette.prismLime, 0.15),
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    borderWidth: Borders.width,
    borderColor: withAlpha(Palette.prismLime, 0.3),
  },
  verifiedText: {
    color: Palette.prismLime,
    fontSize: 8.5,
    fontFamily: 'monospace',
    letterSpacing: 1,
  },
  unreadPill: {
    backgroundColor: Palette.prismCyan,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.pill,
    ...glow(Palette.prismCyan, 6),
  },
  unreadText: {
    color: Palette.textInverse,
    fontSize: 11,
    fontWeight: 'bold',
  },
});

export default ThreadListScreen;
