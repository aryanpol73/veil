/**
 * ============================================================================
 *  VEIL — QR INVITE (OBSIDIAN PRISM VECTOR QR CODE)
 * ============================================================================
 *  Renders a crisp vector QR code using `toqr` and `react-native-svg` path batching.
 *  Uses an obsidian frosted plate with specular edges and cyan corner brackets.
 * ============================================================================
 */

import React, { useMemo } from 'react';
import {
  StyleSheet,
  View,
  ViewStyle,
  StyleProp,
} from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { toQR } from 'toqr';
import {
  Borders,
  Palette,
  Radius,
  Space,
  glow,
  withAlpha,
} from '../theme/obsidianPrism';
import SpecularGlass from './SpecularGlass';

export interface QrInviteProps {
  value: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
}

export const QrInvite: React.FC<QrInviteProps> = ({
  value,
  size = 180,
  style,
}) => {
  // Generate QR matrix and single optimized SVG path
  const { pathData, matrixSize } = useMemo(() => {
    if (!value) return { pathData: '', matrixSize: 0 };
    try {
      const matrix = toQR(value, 1); // 1 = ECLevel.L for high-capacity URL
      const mSize = Math.round(Math.sqrt(matrix.length));

      // Build combined path string
      let d = '';
      for (let y = 0; y < mSize; y++) {
        for (let x = 0; x < mSize; x++) {
          if (matrix[y * mSize + x]) {
            d += `M${x},${y}h1v1h-1z `;
          }
        }
      }
      return { pathData: d, matrixSize: mSize };
    } catch (err) {
      console.warn('[QrInvite] QR generation error', err);
      return { pathData: '', matrixSize: 0 };
    }
  }, [value]);

  const padding = 12;
  const innerSize = size - padding * 2;

  return (
    <View
      style={[
        styles.plate,
        {
          width: size,
          height: size,
        },
        glow(Palette.prismCyan, 12),
        style,
      ]}
    >
      <SpecularGlass />

      {/* Decorative corner brackets */}
      <View style={[styles.corner, styles.cornerTL]} />
      <View style={[styles.corner, styles.cornerTR]} />
      <View style={[styles.corner, styles.cornerBL]} />
      <View style={[styles.corner, styles.cornerBR]} />

      <View style={styles.qrContainer}>
        {matrixSize > 0 && pathData ? (
          <Svg
            width={innerSize}
            height={innerSize}
            viewBox={`0 0 ${matrixSize} ${matrixSize}`}
          >
            {/* Background plate */}
            <Rect
              x={0}
              y={0}
              width={matrixSize}
              height={matrixSize}
              fill="transparent"
            />
            {/* Single batched path for all dark cells */}
            <Path
              d={pathData}
              fill="#E0F7FA" // Soft ice-cyan high contrast
            />
          </Svg>
        ) : (
          <View style={{ width: innerSize, height: innerSize }} />
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  plate: {
    borderRadius: Radius.md,
    borderWidth: Borders.width,
    borderColor: withAlpha(Palette.prismCyan, 0.3),
    backgroundColor: withAlpha(Palette.voidTrench, 0.85),
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
  },
  qrContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
  },
  corner: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderColor: Palette.prismCyan,
  },
  cornerTL: {
    top: 4,
    left: 4,
    borderTopWidth: 1.5,
    borderLeftWidth: 1.5,
  },
  cornerTR: {
    top: 4,
    right: 4,
    borderTopWidth: 1.5,
    borderRightWidth: 1.5,
  },
  cornerBL: {
    bottom: 4,
    left: 4,
    borderBottomWidth: 1.5,
    borderLeftWidth: 1.5,
  },
  cornerBR: {
    bottom: 4,
    right: 4,
    borderBottomWidth: 1.5,
    borderRightWidth: 1.5,
  },
});

export default QrInvite;
