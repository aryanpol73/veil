/**
 * ============================================================================
 *  VEIL — PRISM BACKDROP (OBSIDIAN CHROMATIC VOID)
 * ============================================================================
 *  Chromatic void base gradient plus 3 parallax refraction orbs.
 * ============================================================================
 */

import React, { useEffect } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import {
  Motion,
  RefractionOrbs,
  VoidGradient,
} from '../theme/obsidianPrism';

interface OrbProps {
  orb: (typeof RefractionOrbs)[number];
  velocity: SharedValue<number>;
  viewport: { w: number; h: number };
}

const RefractionOrbView: React.FC<OrbProps> = ({ orb, velocity, viewport }) => {
  const idle = useSharedValue(0);

  useEffect(() => {
    idle.value = withRepeat(
      withTiming(1, { duration: orb.driftMs, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [idle, orb.driftMs]);

  const radius = Math.min(viewport.w, viewport.h) * orb.radius;
  const size = radius * 2;

  const style = useAnimatedStyle(() => {
    const scrollShift = velocity.value * orb.parallax;
    const idleX = interpolate(idle.value, [0, 1], [-18, 18]) * Math.sign(orb.parallax || 1);
    const idleY = interpolate(idle.value, [0, 1], [12, -12]);
    return {
      transform: [
        { translateX: withSpring(idleX + scrollShift * 0.6, Motion.ambient) },
        { translateY: withSpring(idleY + scrollShift, Motion.ambient) },
        { scale: withSpring(1 + Math.min(Math.abs(velocity.value) / 2600, 0.12), Motion.ambient) },
      ],
    };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          left: viewport.w * orb.anchor.x - radius,
          top: viewport.h * orb.anchor.y - radius,
          width: size,
          height: size,
        },
        style,
      ]}
    >
      <Svg width={size} height={size}>
        <Defs>
          <RadialGradient id={`orb-${orb.id}`} cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={orb.core} stopOpacity={1} />
            <Stop offset="45%" stopColor={orb.core} stopOpacity={0.45} />
            <Stop offset="100%" stopColor={orb.core} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={radius} cy={radius} r={radius} fill={`url(#orb-${orb.id})`} />
      </Svg>
    </Animated.View>
  );
};

export interface PrismBackdropProps {
  velocity?: SharedValue<number>;
}

export const PrismBackdrop: React.FC<PrismBackdropProps> = ({ velocity }) => {
  const { width, height } = useWindowDimensions();
  const fallbackVelocity = useSharedValue(0);
  const activeVelocity = velocity ?? fallbackVelocity;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient
        colors={VoidGradient.colors}
        locations={VoidGradient.locations}
        start={VoidGradient.start}
        end={VoidGradient.end}
        style={StyleSheet.absoluteFill}
      />
      {RefractionOrbs.map((orb) => (
        <RefractionOrbView
          key={orb.id}
          orb={orb}
          velocity={activeVelocity}
          viewport={{ w: width, h: height }}
        />
      ))}
    </View>
  );
};

export default PrismBackdrop;
