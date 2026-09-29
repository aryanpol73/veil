import React, { useEffect, useState } from 'react';
import { StyleSheet, View, ActivityIndicator } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';

import { initCrypto } from './src/crypto/keys';
import { isProvisioned } from './src/storage/db';
import { Palette } from './src/theme/obsidianPrism';
import type { RootStackParamList } from './src/types/navigation';

import { UnlockScreen } from './src/screens/UnlockScreen';
import { ProvisionScreen } from './src/screens/ProvisionScreen';
import { ThreadListScreen } from './src/screens/ThreadListScreen';
import { ChatScreen } from './src/screens/ChatScreen';

const Stack = createStackNavigator<RootStackParamList>();

const VeilNavTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: Palette.voidMidnight,
    card: Palette.voidMidnight,
    text: Palette.textPrimary,
    border: 'transparent',
  },
};

export default function App() {
  const [ready, setReady] = useState(false);
  const [provisioned, setProvisioned] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await initCrypto();
        const hasVaults = isProvisioned();
        if (mounted) {
          setProvisioned(hasVaults);
        }
      } catch (err) {
        console.error('[veil] init error', err);
      } finally {
        if (mounted) setReady(true);
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  if (!ready) {
    return (
      <View style={styles.loading}>
        <StatusBar style="light" />
        <ActivityIndicator color={Palette.prismCyan} size="large" />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <NavigationContainer theme={VeilNavTheme}>
          <Stack.Navigator
            initialRouteName={provisioned ? 'Unlock' : 'Provision'}
            screenOptions={{
              headerShown: false,
              animation: 'fade',
              cardStyle: { backgroundColor: Palette.voidMidnight },
            }}
          >
            <Stack.Screen name="Unlock" component={UnlockScreen} />
            <Stack.Screen name="Provision" component={ProvisionScreen} />
            <Stack.Screen name="ThreadList" component={ThreadListScreen} />
            <Stack.Screen name="Chat" component={ChatScreen} />
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Palette.voidMidnight,
  },
  loading: {
    flex: 1,
    backgroundColor: Palette.voidMidnight,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
