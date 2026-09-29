/**
 * ============================================================================
 *  VEIL — SPECULAR GLASS EDGE
 * ============================================================================
 *  Asymmetric specular hairlines that turn flat rectangles into bevelled
 *  prismatic glass.
 * ============================================================================
 */

import React from 'react';
import { View } from 'react-native';
import { Borders, Surface } from '../theme/obsidianPrism';

export interface SpecularGlassProps {
  active?: boolean;
  color?: string;
}

export const SpecularGlass: React.FC<SpecularGlassProps> = ({ active, color }) => (
  <>
    <View
      style={[
        Surface.specularTop,
        active && { backgroundColor: color ?? Borders.activeHigh },
      ]}
      pointerEvents="none"
    />
    <View
      style={[
        Surface.specularLeft,
        active && { backgroundColor: color ?? Borders.activeHigh },
      ]}
      pointerEvents="none"
    />
  </>
);

export default SpecularGlass;
