/**
 * ============================================================================
 *  VEIL — MASK HEADER (COMPACT IDENTITY HUD)
 * ============================================================================
 *  Displays active mask partition, formatted fingerprint, connection status,
 *  and device tag in a compact, non-dominating HUD surface.
 * ============================================================================
 */

import React from 'react';
import {
  StyleSheet,
  Text,
  View,
  ViewStyle,
  StyleProp,
} from 'react-native';
import {
  Borders,
  Fonts,
  Palette,
  Radius,
  Space,
  Type,
  withAlpha,
} from '../theme/obsidianPrism';
import PrismSurface from './PrismSurface';
import CryptoLabel from './CryptoLabel';
import FingerprintDisplay from './FingerprintDisplay';
import StatusIndicator from './StatusIndicator';
import type { ConnectionStatus } from '../transport/RelayClient';

export interface MaskHeaderProps {
  maskLabel?: string;
  fingerprint: string;
  relayStatus: ConnectionStatus;
  deviceFingerprint: string;
  style?: StyleProp<ViewStyle>;
}

export const MaskHeader: React.FC<MaskHeaderProps> = ({
  maskLabel = 'PERSONAL',
  fingerprint,
  relayStatus,
  deviceFingerprint,
  style,
}) => {
  return (
    <PrismSurface
      style={[styles.container, style]}
      contentStyle={styles.content}
      radius={Radius.md}
      tint={withAlpha(Palette.voidTrench, 0.65)}
    >
      {/* Top telemetry row */}
      <View style={styles.topRow}>
        <View style={styles.maskTag}>
          <CryptoLabel variant="lime" dot size="xs">
            {`MASK · ${maskLabel}`}
          </CryptoLabel>
        </View>

        <StatusIndicator status={relayStatus} />
      </View>

      {/* Identity row */}
      <View style={styles.bottomRow}>
        <FingerprintDisplay
          fingerprint={fingerprint}
          truncate
          copyable
          size="sm"
          style={styles.fpContainer}
        />

        <View style={styles.deviceTag}>
          <Text style={styles.deviceText}>
            DEV {deviceFingerprint.slice(0, 8)}
          </Text>
        </View>
      </View>
    </PrismSurface>
  );
};

const styles = StyleSheet.create({
  container: {
    marginHorizontal: Space.md,
    marginVertical: Space.xs,
  },
  content: {
    paddingHorizontal: Space.md,
    paddingVertical: Space.sm,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Space.xs,
  },
  maskTag: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fpContainer: {
    flex: 1,
    marginRight: Space.sm,
  },
  deviceTag: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 3,
    backgroundColor: withAlpha(Palette.glassElevated, 0.8),
    borderWidth: Borders.width,
    borderColor: Borders.specularLow,
  },
  deviceText: {
    fontFamily: Fonts.mono,
    fontSize: 9,
    color: Palette.textMuted,
    letterSpacing: 1.1,
  },
});

export default MaskHeader;
