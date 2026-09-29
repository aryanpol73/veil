/**
 * ============================================================================
 *  VEIL — NAVIGATION TYPES
 * ============================================================================
 */

import type { StackNavigationProp } from '@react-navigation/stack';
import type { RouteProp } from '@react-navigation/native';

export type RootStackParamList = {
  Unlock: undefined;
  Provision: undefined;
  ThreadList: undefined;
  Chat: {
    threadId: string;
    contactId?: string;
  };
};

export type RootNavigationProp = StackNavigationProp<RootStackParamList>;

export type ChatScreenRouteProp = RouteProp<RootStackParamList, 'Chat'>;
export type ThreadListScreenRouteProp = RouteProp<RootStackParamList, 'ThreadList'>;
export type UnlockScreenRouteProp = RouteProp<RootStackParamList, 'Unlock'>;
export type ProvisionScreenRouteProp = RouteProp<RootStackParamList, 'Provision'>;
