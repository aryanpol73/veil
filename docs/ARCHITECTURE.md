# VEIL — SYSTEM ARCHITECTURE AUDIT & ASSESSMENT

**Document Version:** 1.0.0  
**Status:** Audit & Baseline Assessment (Phase 0)  
**System Scope:** React Native (Expo 57 / React 19 / Hermes) Mobile Client & Node.js Blind WebSocket Relay

---

## 1. Executive Summary

Veil is an asynchronous, privacy-first cryptographic messenger designed to eliminate centralized metadata, phone/email identifiers, server-side message archives, and account directories.

Identity is rooted entirely in cryptographic key pairs derived deterministically from a 256-bit seed using keyed BLAKE2b KDF. Message exchange is facilitated through a blind WebSocket relay operating solely over short-lived, rotating blinded inboxes and fixed-size encrypted envelopes.

This document records the exact architectural baseline of the repository, distinguishing working production modules from placeholder stubs, identifying structural gaps, and outlining the target end-to-end pipeline.

---

## 2. Repository Layout & Component Status

```
veil/
├── package.json                 # Workspace root (monorepo scripts: server, client, web)
├── server/                      # Blind WebSocket Relay
│   ├── src/
│   │   ├── relay.ts             # [ACTIVE] WebSocket relay daemon (RAM queues, first-claim auth)
│   │   └── bus.ts               # [STUB: 0 bytes] Target: RelayBus, InMemoryRelayBus, RedisRelayBus
│   ├── Dockerfile               # Node 22 alpine container definition
│   ├── tsconfig.json            # ESNext / NodeNext strict TypeScript
│   └── package.json             # ws, libsodium-wrappers, ioredis, ioredis-mock
└── client/                      # Expo / React Native Client
    ├── App.tsx                  # [ACTIVE TEST HARNESS] Mounts ChatScreen with mock props
    ├── app.json                 # Expo SDK 57 configuration
    ├── tsconfig.json            # Strict TypeScript configuration
    └── src/
        ├── crypto/
        │   ├── keys.ts          # [ACTIVE] Ed25519, X25519, XChaCha20-Poly1305, Argon2id, BLAKE2b
        │   ├── ratchet.ts       # [STUB: 0 bytes] Target: Complete Double Ratchet state machine
        │   └── padding.ts       # [STUB: 0 bytes] Target: Fixed-size envelope padding (4096 bytes)
        ├── storage/
        │   ├── db.ts            # [ACTIVE] Dual-vault partition, AEAD record encryption, RamVault
        │   ├── sqliteDriver.ts  # [ACTIVE] expoSqliteDriver (native) & memoryDriver (web preview)
        │   └── keychain.ts      # [STUB: 0 bytes] Target: Device salt / secure hardware abstractions
        ├── transport/
        │   ├── protocol.ts      # [STUB: 0 bytes] Target: Frame types & envelope wire codecs
        │   └── socket.ts        # [STUB: 0 bytes] Target: Reconnecting RelayClient & connection manager
        ├── screens/
        │   ├── ChatScreen.tsx   # [ACTIVE] Obsidian Prism UI, flatlist, composer, retention themes
        │   ├── ProvisionScreen.tsx # [STUB: 0 bytes] Target: First-run master/ghost PIN & seed creation
        │   ├── UnlockScreen.tsx    # [STUB: 0 bytes] Target: Coercion-resistant PIN entry
        │   └── ThreadListScreen.tsx# [STUB: 0 bytes] Target: Conversation list & invite scanner/display
        ├── components/
        │   ├── DynamicWatermark.tsx # [ACTIVE] ScreenCapture listener, SVG lattice, forensic tag
        │   ├── BubbleShell.tsx     # [STUB: 0 bytes] (Inlined in ChatScreen)
        │   ├── PrismBackdrop.tsx   # [STUB: 0 bytes] (Inlined in ChatScreen)
        │   └── SpecularGlass.tsx   # [STUB: 0 bytes] (Inlined in ChatScreen)
        ├── theme/
        │   └── obsidianPrism.ts # [ACTIVE] Tokens, Blur intensities, Void gradients, Typography
        └── types/
            ├── models.ts        # [STUB: 0 bytes] Target: Domain types
            └── navigation.ts    # [STUB: 0 bytes] Target: Navigation route params
```

---

## 3. Subsystem Breakdown (What Actually Exists)

### 3.1 Client Cryptography (`client/src/crypto/keys.ts`)
- **Primitives**: Pure TypeScript implementations via `@noble/curves` (v2), `@noble/ciphers` (v2), and `@noble/hashes` (v2).
- **Master Seed**: 32 CSPRNG bytes (`generateMasterSeed()`).
- **Masks (Personas)**: Deterministic derivation via hierarchical paths `m/veil/mask/{index}` using keyed BLAKE2b. Mask 0 = Personal, Mask 1 = Ghost (decoy).
  - Each mask yields an Ed25519 signing keypair (`signPk`, `signSk`) and an X25519 key agreement keypair (`dhPk`, `dhSk`).
- **Fingerprints**: 160-bit Crockford Base32 strings grouped into 4-character blocks, computed as `BLAKE2b(signPk || dhPk)` with a domain label.
- **Payload AEAD**: XChaCha20-Poly1305 with 24-byte CSPRNG nonce and authenticated associated data (AAD). Wire packing format: `b64u(nonce).b64u(ciphertext||tag)`.
- **Vault Key Derivation**: Argon2id (`t=3, m=64MB, p=1, dkLen=32`) stretching PIN + device salt with partition domain separation (`partition.primary` vs `partition.decoy`).
- **Invitations**: Canonical `veil://invite?v=1&ik=...&xk=...&rz=...&exp=...&sig=...` signed by Ed25519, expiring, containing one-time rendezvous token.
- **Blinded Inbox Addressing**: `BLAKE2b("veil.inbox.blind.v1" || epochHour, key = ratchetPk)`. Hourly rotation with a ±1 hour subscription window.
- **Inbox Authorization**: Detached Ed25519 signature over `veil.inbox.auth.v1|{inboxId}|{serverNonce}` proving ownership without identifying the user.

### 3.2 Client Storage (`client/src/storage/db.ts` & `sqliteDriver.ts`)
- **Dual Partition Architecture**:
  - `veil_vault_primary.db` (Master PIN)
  - `veil_vault_decoy.db` (Ghost PIN)
- **Key Derivation Timing**: Both partition keys derived unconditionally on every unlock attempt to prevent side-channel timing analysis.
- **Canary Record**: Sealed record `meta['canary']` decrypted with AAD. No plaintext PIN or verifier hash is ever stored.
- **Record Encryption**: SQLite table `messages` stores payload bodies sealed with XChaCha20-Poly1305 using the active vault key and AAD `msg|${id}`.
- **View-Once (`RamVault`)**: Stored purely in memory (`Map<string, StoredMessage>`) with a 10-minute unopened ceiling. Burned irreversibly on user finger release, lock, or app background. Hard check constraint in SQLite schema prevents persistence of View-Once messages.
- **Timed Messages**: Expiration TTL armed on read; background timer sweeps expired records every 5 seconds. Followed by `PRAGMA incremental_vacuum` and `PRAGMA wal_checkpoint(TRUNCATE)` to wipe slack space.
- **Driver Layer**: Abstraction separating `expoSqliteDriver` (native Android/iOS) and in-memory `memoryDriver` (web preview).

### 3.3 Dynamic Forensic Watermark (`client/src/components/DynamicWatermark.tsx`)
- Low-opacity (0.035) SVG micro-tick lattice encoding `BLAKE2b(deviceFp | sessionId | recipientFp | UTC minute)`.
- Sub-pixel breathing animation (sinusoidal drift) preventing naive frame-differencing.
- Active screenshot detection via `expo-screen-capture` on iOS/Android; flashes lattice, triggers haptic, and signals parent to burn View-Once messages.
- Android uses `FLAG_SECURE` (`preventScreenCaptureAsync`) to block hardware screen capture.

### 3.4 Server Blind Relay (`server/src/relay.ts`)
- WebSocket daemon on port 8443 (HTTP `/healthz` endpoint returns raw 200).
- **RAM-Only State**:
  - `queues`: Inboxes mapped to envelopes (max 256 depth per inbox, max 200,000 inboxes, 24-hour TTL).
  - `claims`: Inboxes mapped to first-claim owner Ed25519 key (2-hour TTL).
  - `subscribers`: Inboxes mapped to active socket connections.
- **First-Claim Inbox Ownership**: Initial subscriber claims the inbox for the epoch. Subsequent subscriptions must sign the per-connection challenge nonce with the claiming public key.
- **Fixed Envelope Constraint**: Rejects any message where base64 payload does not decode to exactly 4,096 bytes (`CONFIG.envelopeBytes`).
- **Immediate ACK Deletion**: `dropAcked` purges envelopes from RAM immediately upon client acknowledgment.
- **Zero Logging**: No IP addresses, user agents, inbox IDs, or message contents are logged.
- **Identified Gap**: Redis pub/sub integration currently hardcoded to `ioredis-mock`. Needs abstraction into `server/src/bus.ts` with explicit production Redis configuration.

---

## 4. Architectural Gaps & Implementation Roadmap

| Subsystem | Existing State | Gap / Target State |
|---|---|---|
| **Double Ratchet** | Skeleton helpers in `keys.ts` (`advanceChain`, `dhRatchet`) | Full state machine in `src/protocol/ratchet/`: session setup, DH ratchets, symmetric chains, skipped message keys cache, out-of-order handling, duplicate detection, state serialization into `ratchets` table. |
| **Message Pipeline** | Disconnected UI mock `onTransmit` | Complete orchestration: `Composer` -> `MessageService` -> `RatchetManager` -> `EnvelopeCodec` (with 4096-byte padding) -> `RelayClient` -> Blind Relay -> `RelayClient` -> Decrypt -> `RetentionManager` -> `Vault/RamVault` -> UI. |
| **Relay Client** | `socket.ts` and `protocol.ts` are 0 bytes | Fully typed WebSocket client implementing `HELLO`, `SUB`, `SEND`, `DELIVER`, `ACK`, `PING`, `NOOP` with exponential backoff, jitter, and automatic inbox resubscription on epoch roll. |
| **Relay Bus** | `server/src/bus.ts` is 0 bytes | `RelayBus` interface with `InMemoryRelayBus` (development/testing) and `RedisRelayBus` (real `ioredis` cluster/standalone for production multi-node fan-out). |
| **Screen Navigation** | Direct mount of `ChatScreen` in `App.tsx` | React Navigation flow: `UnlockScreen` -> `ThreadListScreen` -> `ChatScreen`, plus `ProvisionScreen` on first boot, and modal for QR invite creation/scanning. |
| **Contacts & Pairing** | Hardcoded mock peer in `App.tsx` | `ContactManager`: store contacts, verify fingerprints, scan/display QR invitations (`veil://invite?...`), identity change alerts (`CHANGED IDENTITY`). |
| **Testing** | No test files, `"test"` script fails | Full test suites covering crypto test vectors, double ratchet sequencing, relay WebSocket interactions, storage partitions, and security invariants. |
