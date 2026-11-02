/**
 * ============================================================================
 *  VEIL — QR SCANNER
 * ============================================================================
 *  Full-screen camera view that reads one QR code and hands back its text.
 *  Frames are processed on-device by expo-camera; nothing is recorded or
 *  stored, and the camera is released as soon as a code is read or the
 *  scanner closes.
 * ============================================================================
 */

import React, { useEffect, useRef } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { Palette, Radius, Space, Type, withAlpha } from '../theme/obsidianPrism';
import PrismButton from './PrismButton';

export interface QrScannerProps {
  visible: boolean;
  /** Return true to accept the code and close; false to keep scanning. */
  onScanned: (data: string) => boolean;
  onClose: () => void;
}

export const QrScanner: React.FC<QrScannerProps> = ({ visible, onScanned, onClose }) => {
  const [permission, requestPermission] = useCameraPermissions();
  // The camera fires many callbacks per second for the same code.
  const handled = useRef(false);

  useEffect(() => {
    if (visible) handled.current = false;
  }, [visible]);

  const handleScan = (result: BarcodeScanningResult) => {
    if (handled.current) return;
    if (onScanned(result.data)) {
      handled.current = true;
      onClose();
    }
  };

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={styles.root}>
        {!permission ? null : permission.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={visible ? handleScan : undefined}
          />
        ) : (
          <View style={styles.permission}>
            <Text style={[Type.body, styles.text]}>
              Veil needs the camera to read invite codes. Frames stay on this phone and are not
              recorded.
            </Text>
            {permission.canAskAgain ? (
              <PrismButton title="ALLOW CAMERA" onPress={() => void requestPermission()} />
            ) : (
              <Text style={[Type.meta, styles.text]}>
                Camera access is off for Veil. Turn it on in system settings, or paste the invite
                link instead.
              </Text>
            )}
          </View>
        )}

        {permission?.granted && (
          <View pointerEvents="none" style={styles.frameWrap}>
            <View style={styles.frame} />
            <Text style={[Type.hudLabel, styles.hint]}>POINT AT A VEIL QR CODE</Text>
          </View>
        )}

        <Pressable
          onPress={onClose}
          style={styles.close}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Close scanner"
        >
          <Text style={[Type.h2, { color: Palette.textPrimary }]}>✕</Text>
        </Pressable>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.voidMidnight },
  permission: { flex: 1, justifyContent: 'center', padding: Space.xl, gap: Space.lg },
  text: { textAlign: 'center' },
  frameWrap: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  frame: {
    width: 240,
    height: 240,
    borderRadius: Radius.md,
    borderWidth: 2,
    borderColor: withAlpha(Palette.prismCyan, 0.8),
  },
  hint: { marginTop: Space.lg, color: Palette.textPrimary },
  close: {
    position: 'absolute',
    top: Space.xl * 2,
    right: Space.lg,
    padding: Space.sm,
    borderRadius: Radius.pill,
    backgroundColor: withAlpha(Palette.voidMidnight, 0.6),
  },
});

export default QrScanner;
