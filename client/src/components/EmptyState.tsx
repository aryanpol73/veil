/**
 * ============================================================================
 *  VEIL — EMPTY STATE (DELIBERATE CRYPTOGRAPHIC LENS)
 * ============================================================================
 *  Displays when zero active channels are present in the current partition.
 *  Features an SVG prismatic aperture visualization, concise architecture note,
 *  and primary/secondary channel creation actions.
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
import Svg, {
  Polygon,
  Circle,
  Line,
  Defs,
  LinearGradient,
  Stop,
} from 'react-native-svg';
import {
  Borders,
  Palette,
  Radius,
  Space,
  Type,
  withAlpha,
} from '../theme/obsidianPrism';
import PrismButton from './PrismButton';
import CryptoLabel from './CryptoLabel';

export interface EmptyStateProps {
  onInvitePress: () => void;
  onImportPress: () => void;
  style?: StyleProp<ViewStyle>;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  onInvitePress,
  onImportPress,
  style,
}) => {
  return (
    <View style={[styles.container, style]}>
      {/* Prismatic Aperture Visualization */}
      <View style={styles.glyphContainer}>
        <Svg width={110} height={110} viewBox="0 0 100 100">
          <Defs>
            <LinearGradient id="apertureCyan" x1="0%" y1="0%" x2="100%" y2="100%">
              <Stop offset="0%" stopColor={Palette.prismCyan} stopOpacity={0.65} />
              <Stop offset="100%" stopColor={Palette.prismViolet} stopOpacity={0.15} />
            </LinearGradient>
            <LinearGradient id="apertureLime" x1="0%" y1="100%" x2="100%" y2="0%">
              <Stop offset="0%" stopColor={Palette.prismLime} stopOpacity={0.4} />
              <Stop offset="100%" stopColor="transparent" stopOpacity={0} />
            </LinearGradient>
          </Defs>

          {/* Outer Hexagon */}
          <Polygon
            points="50,6 88,28 88,72 50,94 12,72 12,28"
            stroke="url(#apertureCyan)"
            strokeWidth="1.2"
            fill="transparent"
          />

          {/* Inner Hexagon */}
          <Polygon
            points="50,22 74,36 74,64 50,78 26,64 26,36"
            stroke={withAlpha(Palette.hairline, 0.15)}
            strokeWidth="0.8"
            fill={withAlpha(Palette.voidTrench, 0.5)}
          />

          {/* Core Focus Ring */}
          <Circle
            cx="50"
            cy="50"
            r="12"
            stroke={Palette.prismCyan}
            strokeWidth="1"
            fill={withAlpha(Palette.voidMidnight, 0.8)}
          />
          <Circle
            cx="50"
            cy="50"
            r="4"
            fill={Palette.prismLime}
          />

          {/* Crosshair ticks */}
          <Line x1="50" y1="2" x2="50" y2="10" stroke={Palette.prismCyan} strokeWidth="1.5" />
          <Line x1="50" y1="90" x2="50" y2="98" stroke={Palette.prismCyan} strokeWidth="1.5" />
          <Line x1="4" y1="50" x2="12" y2="50" stroke={Palette.prismCyan} strokeWidth="1.5" />
          <Line x1="88" y1="50" x2="96" y2="50" stroke={Palette.prismCyan} strokeWidth="1.5" />
        </Svg>
      </View>

      <CryptoLabel variant="slate" size="xs" containerStyle={{ marginBottom: 6 }}>
        ENCRYPTED SUBSTRATE READY
      </CryptoLabel>

      <Text style={[Type.h2, styles.title]}>NO ACTIVE CHANNELS</Text>

      <Text style={[Type.body, styles.description]}>
        Veil maintains zero central directories. Channels are ephemeral, established on-demand
        through cryptographic invitation tokens.
      </Text>

      {/* Action Buttons */}
      <View style={styles.actions}>
        <PrismButton
          title="INVITE CONTACT"
          variant="primary"
          size="md"
          onPress={onInvitePress}
          style={styles.actionBtn}
        />
        <PrismButton
          title="PAIR WITH PEER"
          variant="ghost"
          size="md"
          onPress={onImportPress}
          style={styles.actionBtn}
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingHorizontal: Space.xl,
    paddingTop: Space.xxl,
    paddingBottom: Space.xl,
  },
  glyphContainer: {
    marginBottom: Space.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    color: Palette.textPrimary,
    letterSpacing: 1.5,
    textAlign: 'center',
    marginBottom: Space.sm,
  },
  description: {
    color: Palette.textHud,
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 19,
    maxWidth: 320,
    marginBottom: Space.xl,
  },
  actions: {
    flexDirection: 'row',
    gap: Space.md,
    justifyContent: 'center',
    flexWrap: 'wrap',
  },
  actionBtn: {
    minWidth: 140,
  },
});

export default EmptyState;
