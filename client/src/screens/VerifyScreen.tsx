/**
 * ============================================================================
 *  VEIL — SAFETY NUMBER VERIFICATION (feature F-08)
 * ============================================================================
 *  Shows the combined safety number for this contact. Both phones display
 *  the same 60 digits; if they match when compared in person or over a
 *  trusted call, nobody is in the middle.
 *
 *  When a contact's keys have changed, this is the only place to clear the
 *  CHANGED_IDENTITY state, and sending stays blocked until the user does.
 *  Copy rules: say what happened and what to do, never "secure" or "safe".
 * ============================================================================
 */

import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Palette, Radius, Space, Type, withAlpha } from '../theme/obsidianPrism';
import PrismBackdrop from '../components/PrismBackdrop';
import PrismSurface from '../components/PrismSurface';
import PrismButton from '../components/PrismButton';
import CryptoLabel from '../components/CryptoLabel';
import FingerprintDisplay from '../components/FingerprintDisplay';
import { safetyNumber } from '../crypto/keys';
import { identityManager } from '../identity/IdentityManager';
import { contactManager } from '../protocol/contacts/ContactManager';
import type { RootNavigationProp, VerifyScreenRouteProp } from '../types/navigation';

export interface VerifyScreenProps {
  route: VerifyScreenRouteProp;
  navigation: RootNavigationProp;
}

export const VerifyScreen: React.FC<VerifyScreenProps> = ({ route, navigation }) => {
  const { contactId } = route.params;
  const [version, setVersion] = useState(0);

  const contact = useMemo(() => contactManager.getContact(contactId), [contactId, version]);
  const me = identityManager.getActiveMask();

  const number = useMemo(
    () => (contact && me ? safetyNumber(me, contact) : null),
    [contact, me],
  );

  const setState = useCallback(
    (state: 'VERIFIED' | 'UNVERIFIED') => {
      contactManager.setVerificationState(contactId, state);
      setVersion((v) => v + 1);
    },
    [contactId],
  );

  if (!contact || !me || !number) {
    return (
      <View style={styles.root}>
        <PrismBackdrop />
        <SafeAreaView style={styles.safe}>
          <Text style={[Type.body, styles.center]}>This contact is no longer available.</Text>
          <PrismButton title="BACK" variant="ghost" onPress={() => navigation.goBack()} />
        </SafeAreaView>
      </View>
    );
  }

  const changed = contact.verificationState === 'CHANGED_IDENTITY';
  const verified = contact.verificationState === 'VERIFIED';
  // 12 groups of 5, shown as 3 rows of 4 for reading aloud.
  const rows = number.split(' ').reduce<string[][]>((acc, g, i) => {
    if (i % 4 === 0) acc.push([]);
    acc[acc.length - 1].push(g);
    return acc;
  }, []);

  return (
    <View style={styles.root}>
      <PrismBackdrop />
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={Type.h1}>{contact.alias}</Text>
          <CryptoLabel variant={verified ? 'lime' : changed ? 'magenta' : 'cyan'} dot size="xs">
            {verified ? 'VERIFIED' : changed ? 'KEYS CHANGED' : 'NOT VERIFIED'}
          </CryptoLabel>

          {changed && (
            <PrismSurface
              radius={Radius.md}
              style={styles.card}
              contentStyle={styles.cardContent}
              tint={withAlpha(Palette.prismMagenta, 0.12)}
              active
              glowColor={withAlpha(Palette.prismMagenta, 0.25)}
            >
              <Text style={Type.body}>
                {contact.alias}'s keys are different from the ones you had before. This happens
                when they reinstall Veil or move to a new phone. It also happens if someone is
                trying to pose as them.
              </Text>
              <Text style={[Type.body, styles.gap]}>
                Sending is paused. Compare the new safety number below with {contact.alias} in
                person or on a call you trust before you continue.
              </Text>
            </PrismSurface>
          )}

          <PrismSurface radius={Radius.md} style={styles.card} contentStyle={styles.cardContent}>
            <Text style={Type.hudLabel}>SAFETY NUMBER</Text>
            <View style={styles.number}>
              {rows.map((row, i) => (
                <Text key={i} style={[Type.fingerprint, styles.numberRow]} accessibilityLabel={row.join(' ')}>
                  {row.join('  ')}
                </Text>
              ))}
            </View>
            <Text style={[Type.meta, styles.gap]}>
              {contact.alias} sees the same number on their phone. If any digit differs, do not
              mark them as verified.
            </Text>
          </PrismSurface>

          <PrismSurface radius={Radius.md} style={styles.card} contentStyle={styles.cardContent}>
            <Text style={Type.hudLabel}>THEIR FINGERPRINT</Text>
            <FingerprintDisplay fingerprint={contact.fingerprint} size="sm" />
            <Text style={[Type.hudLabel, styles.gap]}>YOUR FINGERPRINT</Text>
            <FingerprintDisplay fingerprint={me.fingerprint} size="sm" />
          </PrismSurface>

          {verified ? (
            <PrismButton
              title="REMOVE VERIFICATION"
              variant="ghost"
              onPress={() => setState('UNVERIFIED')}
              style={styles.gap}
            />
          ) : (
            <PrismButton
              title={changed ? 'NUMBERS MATCH · RESUME SENDING' : 'NUMBERS MATCH · MARK VERIFIED'}
              variant="accent"
              onPress={() => setState('VERIFIED')}
              style={styles.gap}
            />
          )}
          {changed && (
            <PrismButton
              title="RESUME WITHOUT CHECKING"
              variant="ghost"
              onPress={() => setState('UNVERIFIED')}
              style={styles.gap}
            />
          )}
          <PrismButton title="BACK" variant="ghost" onPress={() => navigation.goBack()} style={styles.gap} />
        </ScrollView>
      </SafeAreaView>
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.voidMidnight },
  safe: { flex: 1 },
  scroll: { padding: Space.lg, gap: Space.md, maxWidth: 560, width: '100%', alignSelf: 'center' },
  center: { textAlign: 'center', marginVertical: Space.xl },
  card: { marginTop: Space.sm },
  cardContent: { padding: Space.md, gap: Space.xs },
  number: { marginTop: Space.sm, gap: Space.xs },
  numberRow: { letterSpacing: 1.5, textAlign: 'center' },
  gap: { marginTop: Space.sm },
});

export default VerifyScreen;
