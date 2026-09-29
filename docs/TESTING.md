# VEIL — TESTING, VERIFICATION & RUN GUIDE

This document provides the complete testing manual, verification evidence, build instructions, and operational differences for the **Veil** privacy messenger and blind relay.

---

## 1. Automated Test Suites Matrix

All tests run on Node.js using Node's native test runner (`node:test`) via `tsx`.

| Test Suite | File | Focus & Coverage | Status |
| :--- | :--- | :--- | :--- |
| **Cryptographic Primitives** | [`tests/crypto.test.ts`](file:///c:/Users/Aryan/OneDrive/Desktop/MyWork/Projects%20-%20Part2/veil/tests/crypto.test.ts) | 32-byte CSPRNG seeds, deterministic mask derivation, Crockford Base32 fingerprints, XChaCha20-Poly1305 AEAD, AAD tamper detection, canonical signed invitations, blinded inbox addresses, 4,096-byte constant padding. | **PASS** (17/17) |
| **Double Ratchet Protocol** | [`tests/ratchet.test.ts`](file:///c:/Users/Aryan/OneDrive/Desktop/MyWork/Projects%20-%20Part2/veil/tests/ratchet.test.ts) | Alice/Bob session initialization, authenticated X25519 DH transitions, symmetric chain advancements, out-of-order skipped message keys, duplicate replay detection, state serialization. | **PASS** (7/7) |
| **Dual-Partition Vault & Storage** | [`tests/storage.test.ts`](file:///c:/Users/Aryan/OneDrive/Desktop/MyWork/Projects%20-%20Part2/veil/tests/storage.test.ts) | Simultaneous primary/decoy provisioning, Argon2id PIN key derivation, Master PIN (Mask 0) canary unlock, Ghost PIN (Mask 1) decoy unlock, RamVault View-Once lifecycle, Timed message read TTL sweep. | **PASS** (7/7) |
| **Blind WebSocket Relay** | [`tests/relay.test.ts`](file:///c:/Users/Aryan/OneDrive/Desktop/MyWork/Projects%20-%20Part2/veil/tests/relay.test.ts) | Ephemeral WebSocket server lifecycle, HELLO 32-byte challenge nonce, first-claim Ed25519 inbox authorization, 4,096-byte uniform envelope transmission, volatile RAM delivery, ACK drops. | **PASS** (8/8) |
| **Adversarial & Security Penetration** | [`tests/adversarial.test.ts`](file:///c:/Users/Aryan/OneDrive/Desktop/MyWork/Projects%20-%20Part2/veil/tests/adversarial.test.ts) | Replay attacks, Poly1305 ciphertext bit-flipping, AAD context hijacking, forged challenge replay denial, inbox hijacking prevention, unauthorized ACK drop, malformed frames, oversized payloads, `CHANGED_IDENTITY` alerts, skipped keys DoS. | **PASS** (10/10) |
| **End-to-End Acceptance Pipeline** | [`tests/e2e.test.ts`](file:///c:/Users/Aryan/OneDrive/Desktop/MyWork/Projects%20-%20Part2/veil/tests/e2e.test.ts) | Complete 20-criteria acceptance pipeline verifying independent identities, signed invites, Double Ratchet sessions, blinded inboxes, 4,096-byte opaque relay delivery, retention modes, and zero plaintext on server. | **PASS** (1/1) |

**Total Automated Tests: 50 tests passing with 0 failures.**

---

## 2. Test Execution Commands

From the workspace root:

```bash
# Run all test suites
npm test

# Run individual test suites
npm run test:crypto
npm run test:ratchet
npm run test:storage
npm run test:relay
npm run test:adversarial
npm run test:e2e
```

### Type Checking

```bash
# Typecheck both client (tsc --noEmit) and server (tsc)
npm run typecheck

# Or individually
npm run typecheck:client
npm run typecheck:server
```

---

## 3. Running the System Locally

### Step 1: Start the Blind WebSocket Relay Server

```bash
# Development mode (auto-reload on save)
npm run server

# Or directly in server directory
cd server
npm run dev

# Production build and run
npm run build:server
npm --prefix server start
```

Default listening endpoint: `ws://127.0.0.1:8443` (HTTP healthcheck: `http://127.0.0.1:8443/healthz`).

### Step 2: Start the Client Application

```bash
# Expo Metro Bundler (Development)
npm run client

# Expo Web Preview (runs in browser with memoryDriver)
npm run web

# Native Mobile Emulators / Devices
npm --prefix client run android
npm --prefix client run ios
```

---

## 4. Environment Variables

| Variable | Target | Default | Description |
| :--- | :--- | :--- | :--- |
| `VEIL_PORT` | Server | `8443` | Port for WebSocket relay and healthcheck. |
| `VEIL_BUS` | Server | `memory` | Relay bus implementation: `memory` (single-node RAM) or `redis` (multi-node fanout). |
| `VEIL_REDIS_URL` | Server | `redis://127.0.0.1:6379` | Connection string for Redis pub/sub bus (fanout only, never persistent). |
| `EXPO_PUBLIC_RELAY_URL` | Client | `ws://127.0.0.1:8443` | WebSocket URL of the blind relay server. |

---

## 5. Development vs. Production Differences

| Feature | Development / Web Preview | Production Native (iOS / Android) |
| :--- | :--- | :--- |
| **Relay Bus** | `InMemoryRelayBus` (ephemeral volatile Map) | `RedisRelayBus` (Redis Pub/Sub only, no disk persistence, `save ""` configured) |
| **TLS / Transport** | Plain `ws://` on localhost | Strict `wss://` terminated via reverse proxy (TLS 1.3 only, certificate pinning) |
| **Local Storage** | `memoryDriver` (RAM Map for web preview/tests) | Encrypted SQLite / SQLCipher with master seed encrypted via `expo-secure-store` |
| **Screen Protection** | Software detection | Native hardware surface protection (`FLAG_SECURE` on Android, view-blurring on iOS) |
| **Key Derivation** | Argon2id in JS (64MB memory, 3 passes) | Argon2id native extension / hardware-backed keystore integration |

---

## 6. Known Security Limitations & Threat Model Disclosures

1. **Managed Runtime Memory (Hermes/V8 Garbage Collector)**:
   - Veil explicitly zeroizes sensitive secret arrays (`wipe(bytes)`) where possible. However, strings and JavaScript runtime objects allocated on the Hermes/V8 heap cannot be forcibly overwritten immediately; they persist until the engine triggers a garbage collection cycle.
2. **Decoy / Ghost Vault Boundaries**:
   - The dual-partition vault protects against casual physical inspection or coercion where the attacker does not possess forensic drive snapshots. It **cannot** defeat a compromised operating system, kernel keylogger, physical hardware implant, or repeated bit-level filesystem acquisitions.
3. **Camera & Optical Attribution**:
   - `DynamicWatermark` provides forensic attribution and subtle screen detection. It does not make screen capture "mathematically impossible" against external camera lenses.
4. **Relay Transport Metadata**:
   - While message bodies are 4,096-byte constant-padded and blinded inboxes rotate every hour, a global passive network adversary observing TCP traffic timing can correlate connection timestamps. Veil incorporates `NOOP` cover traffic to raise the cost of statistical timing correlation.
