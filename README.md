<div align="center">

# ❖ V E I L

### **Zero-Directory · Plausible Deniability · Ephemeral Cryptographic Messenger**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React Native](https://img.shields.io/badge/React_Native-Expo_52-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://reactnative.dev/)
[![Hermes](https://img.shields.io/badge/Engine-Hermes-99424F?style=for-the-badge)](https://hermesengine.dev/)
[![SQLCipher](https://img.shields.io/badge/Storage-SQLCipher_AES--256-003B57?style=for-the-badge&logo=sqlite&logoColor=white)](https://www.zetetic.net/sqlcipher/)
[![Cryptography](https://img.shields.io/badge/Primitives-@noble-00F2FE?style=for-the-badge)](https://paulmillr.com/noble/)
[![Tests](https://img.shields.io/badge/Tests-53%2F53_Passing-39FF14?style=for-the-badge&logo=jest&logoColor=white)](./tests)
[![Security](https://img.shields.io/badge/Security-Fail_Closed-FF007F?style=for-the-badge)](#threat-model)

<p align="center">
  <b>Veil</b> is a next-generation privacy-first communication client engineered for hostile environments.<br/>
  No phone numbers. No email registration. No central contact directory. No server-side identity graphs.<br/>
  Every persona is a derived mathematical curve; every database byte is ciphered; every message vanishes on your terms.
</p>

---

[Vision](#-vision) • [Core Pillars](#-core-pillars) • [Cryptography](#-cryptographic-architecture) • [Dual-Vault System](#-dual-partition-vault-coercion-defense) • [Protocol Flow](#-blind-relay-transport) • [Design System](#-obsidian-prism-ui) • [Quickstart](#-quickstart) • [Verification](#-verification--tests) • [Threat Model](#-threat-model--honest-limits)

---

</div>

## ✦ Vision

Traditional "encrypted" messengers still tether your identity to state-traceable identifiers: SIM phone numbers, carrier SMS verification, central contact address books, and observable friend graphs. 

**Veil inverts this paradigm:**
- **Identity is an Ed25519/X25519 keypair**, nothing else.
- **Invitations are signed, one-time cryptographic URIs** exchanged out-of-band.
- **Relays are blind packet conduits** receiving only rotating blinded inbox addresses and uniform 4096-byte high-entropy envelopes.
- **Physical coercion is mitigated** via simultaneous dual-vault partitioning: entering a decoy PIN mounts a fully functional alternate identity with realistic state.

> *"Losing your master seed is losing your identity — that is the product, not a bug."*

---

## ✦ Core Pillars

```
                     ┌──────────────────────────────────────────────────┐
                     │                 V E I L  C O R E                 │
                     └────────────────────────┬─────────────────────────┘
                                              │
         ┌─────────────────────────┬──────────┴──────────────┬─────────────────────────┐
         ▼                         ▼                         ▼                         ▼
  ╔═════════════════╗       ╔═════════════════╗       ╔═════════════════╗       ╔═════════════════╗
  ║   ZERO-TRUST    ║       ║   CONTEXTUAL    ║       ║  DUAL-PARTITION ║       ║  METADATA-BLIND ║
  ║    IDENTITY     ║       ║      MASKS      ║       ║  COERCION DEF   ║       ║      RELAY      ║
  ╠═════════════════╣       ╠═════════════════╣       ╠═════════════════╣       ╠═════════════════╣
  ║ • No phone #    ║       ║ • m/veil/mask/i ║       ║ • Master PIN    ║       ║ • BLAKE2b inbox ║
  ║ • No email      ║       ║ • Persona separation ║  ║ • Ghost PIN     ║       ║ • Uniform 4096B ║
  ║ • Ed25519 auth  ║       ║ • Personal / Decoy ║   ║ • Argon2id KDF  ║       ║ • No plaintext  ║
  ║ • Crockford FP  ║       ║ • Isolated keys ║       ║ • Page-balanced ║       ║ • Cover traffic ║
  ╚═════════════════╝       ╚═════════════════╝       ╚═════════════════╝       ╚═════════════════╝
```

### 1. Hierarchical Contextual Masks
A single 256-bit cryptographic root seed deterministically expands into an unlimited array of isolated personas via domain-separated BLAKE2b derivation:
- **Mask 0 (Personal):** Your primary authenticated identity.
- **Mask 1 (Ghost):** The duress-resistant decoy identity.
- **Mask N (Contextual):** Dedicated keys for specific workspaces, circles, or temporary liaisons.
Downstream ratchet keys, signing keys, and inbox rendezvous points never collide across masks.

### 2. Dual-Partition Vault with Coercion Defense
When compelled under duress to unlock the application, Veil features a cryptographic dual-vault:
- **Master PIN** $\rightarrow$ mounts `veil_vault_primary.db`.
- **Ghost PIN** $\rightarrow$ mounts `veil_vault_decoy.db`.
- **Timing-Balanced Unlock:** Both primary and decoy keys are unconditionally calculated using Argon2id and verified with constant-work execution to defeat side-channel timing attacks.
- **Page Ballast Padding:** Both database files are created simultaneously at initialization and padded with ballast pages toward matching on-disk footprints.

### 3. Ephemeral Retention Policies
Every conversation thread or individual dispatch supports three strict retention tiers:
- **Persistent:** Stored encrypted at rest within the active vault partition.
- **Timed (Auto-Destruct):** Countdown begins upon read confirmation, purging the message securely upon expiration.
- **View-Once (Ephemeral RAM Only):** Bypasses SQLite entirely. Kept exclusively in volatile memory (`RamVault`), revealed only on hold-to-view, and zeroized upon release or application defocus.

### 4. Hardware-Level Shielding & Lifecycle Hardening
- **Native Screen Capture Defense:** Enforces Android `FLAG_SECURE` / iOS screen shield across the root application container.
- **AppState Background Lock:** The microsecond Veil is blurred, minimized, or switched away, the active vault closes, identity keys are zeroized from memory, volatile RAM records are wiped, and navigation resets to the Lock screen.

---

## ✦ Cryptographic Architecture

Veil rejects bespoke homebrewed ciphers in favor of mathematically vetted primitives implemented via Paul Millr's audited `@noble` cryptographic suite.

| Purpose | Primitive | Standard / Source | Parameters / Key Length |
| :--- | :--- | :--- | :--- |
| **Root Identity & Signing** | **Ed25519** | RFC 8032 (`@noble/curves`) | 256-bit private / 256-bit public |
| **Ratchet Key Agreement** | **X25519** | RFC 7748 (`@noble/curves`) | 256-bit ECDH scalar mult |
| **Symmetric AEAD** | **XChaCha20-Poly1305** | RFC 8439 / libsodium | 256-bit key, 192-bit nonce, 128-bit MAC |
| **Key Derivation & Blind Index** | **BLAKE2b** | RFC 7693 (`@noble/hashes`) | Keyed KDF, domain labels, 160-bit FP |
| **Vault Key Stretching** | **Argon2id** | RFC 9106 (`@noble/hashes`) | $t=3$, $m=64\text{ MiB}$, $p=1$, 256-bit key |
| **At-Rest Storage Codec** | **SQLCipher** | AES-256-CBC + HMAC-SHA512 | 4096-byte cipher pages, native C/C++ engine |
| **Secure Randomness** | **CSPRNG** | Native `crypto.getRandomValues` | Polyfilled via `react-native-get-random-values` |

```
                              CRYPTOGRAPHIC DERIVATION PIPELINE
                              
       Master Entropy (256-bit CSPRNG) ───► generateMasterSeed()
                                                   │
                         ┌─────────────────────────┴─────────────────────────┐
                         ▼                                                   ▼
             m/veil/mask/0 (Personal)                            m/veil/mask/1 (Ghost)
                         │                                                   │
             BLAKE2b("ed25519.identity")                         BLAKE2b("ed25519.identity")
             BLAKE2b("x25519.exchange")                          BLAKE2b("x25519.exchange")
                         │                                                   │
                         ▼                                                   ▼
               Ed25519 / X25519                                    Ed25519 / X25519
             Fingerprint: 160-bit                                Fingerprint: 160-bit
             Crockford Base32                                    Crockford Base32
```

---

## ✦ Dual-Partition Vault (Coercion Defense)

```
                            ┌────────────────────────┐
                            │    USER PIN ENTRY      │
                            └───────────┬────────────┘
                                        │
                         Argon2id Stretching (Constant Work)
                                        │
                    ┌───────────────────┴───────────────────┐
                    ▼                                       ▼
        Candidate Primary Key                   Candidate Decoy Key
                    │                                       │
            AES-256 SQLCipher                       AES-256 SQLCipher
        veil_vault_primary.db                   veil_vault_decoy.db
                    │                                       │
        Canary AEAD Validation                  Canary AEAD Validation
                    │                                       │
                    ▼                                       ▼
         [ MATCH: MASTER PIN ]                   [ MATCH: GHOST PIN ]
                    │                                       │
            PRIMARY IDENTITY                         DECOY IDENTITY
         • Real conversation logs               • Plausible synthetic logs
         • Active ratchet states                • Autonomous decoy identity
         • Primary contact list                 • Zero leak of primary state
```

### Forensic Mitigation Characteristics
1. **No Verifier Stored:** Veil never hashes or stores a PIN verifier on disk. The only authentication oracle is an AEAD-sealed canary string (`veil.canary.v1`) with domain-separated AAD. An invalid PIN fails authenticated decryption with zero leakage.
2. **Page Ballast Inflation (`padToward`):** Attackers inspecting block allocation cannot distinguish partitions by byte size. During provisioning, a ballast table injects random high-entropy pages to balance both SQLite databases.
3. **Hardware Keystore Salt:** The 16-byte Argon2id salt resides in the device hardware Keystore/Keychain (`veil.vault.device_salt.v1`). Extracting an unencrypted filesystem image alone prevents an adversary from initiating an offline dictionary attack.

---

## ✦ Blind Relay Transport

Veil uses a zero-knowledge WebSocket transport designed to minimize server knowledge:

```
Alice                                        Relay Node                                         Bob
  │                                               │                                              │
  │─── 1. Query Blind Inbox ─────────────────────►│                                              │
  │    (BLAKE2b("veil.inbox.blind.v1|epochHour")) │                                              │
  │                                               │◄── 2. Authenticate Inbox Ownership ──────────│
  │                                               │    (Ed25519 Signature over Relay Nonce)      │
  │─── 3. Transmit Padded Envelope ──────────────►│                                              │
  │    [ Nonce: 24B | Ciphertext: 4056B | Tag ]   │                                              │
  │    (Uniform 4096-byte High-Entropy Block)     │─── 4. Deliver Fixed Envelope ───────────────►│
  │                                               │                                              │
  │◄── 5. Ephemeral Delivery Ack ─────────────────│                                              │
```

- **Rotating Blind Inboxes:** Inbox IDs rotate hourly via `BLAKE2b(key=receivingRatchetPk, msg="veil.inbox.blind.v1|<epochHour>")`.
- **Uniform Packet Sizes:** All messages are padded to exact **4096-byte** boundaries before transit, frustrating packet length fingerprinting and traffic analysis.
- **Decoupled Identity:** The relay node never receives public keys, identities, read receipts, or message contents.

---

## ✦ Obsidian Prism UI

Veil is designed with the **Obsidian Prism** design system — an atmospheric, high-contrast aesthetic crafted to look and feel like an advanced tactical cryptographic instrument.

```
       VOID MIDNIGHT            PRISM CYAN            PRISM MAGENTA           NEON LIME
         #04060A                 #00F2FE                #FF007F                #39FF14
     Deep Substrate           Primary Lens           Ghost / Alert          Secured State
```

- **PrismSurface:** Glassmorphic obsidian panels with specular border highlights, controlled radial blur, and elevation tints.
- **CryptoLabel:** Monospaced, space-separated status telemetry indicators with pulsing live beacons.
- **FingerprintDisplay:** Crockford Base32 split formatting with one-touch cryptographic clipboard masking.
- **Hold-to-Reveal Shroud:** Blur filters and specular borders protecting sensitive messages from over-the-shoulder snooping.

---

## ✦ Repository Layout

```text
veil/
├── client/
│   ├── android/                  # Native Android project with SQLCipher C++ CMake
│   ├── src/
│   │   ├── components/           # Obsidian Prism UI components (PrismSurface, PrismButton...)
│   │   ├── crypto/               # Core @noble cryptographic primitives (keys.ts)
│   │   ├── identity/             # Mask & persona lifecycle management
│   │   ├── messaging/            # Outbox/Inbox orchestration, message lifecycle
│   │   ├── protocol/
│   │   │   ├── contacts/         # Cryptographic contact verification & exchange
│   │   │   └── ratchet/          # Double Ratchet engine (DH ratchet, symmetric steps)
│   │   ├── screens/              # UnlockScreen, ProvisionScreen, ThreadList, ChatScreen
│   │   ├── storage/              # SQLCipher driver, dual-vault schema, RamVault
│   │   ├── theme/                # Obsidian Prism design tokens & typography
│   │   └── transport/            # Blind relay WebSocket client & envelope padding
│   ├── App.tsx                   # Root navigation, FLAG_SECURE & AppState lifecycle
│   ├── app.json                  # Expo configuration with useSQLCipher native plugin
│   └── package.json
│
├── server/
│   ├── relay/                    # Zero-knowledge blinded WebSocket relay node
│   ├── transport/                # Relay connection & challenge handlers
│   └── package.json
│
├── tests/
│   ├── adversarial.test.ts       # Tamper, replay, malleability, and timing attacks
│   ├── crypto.test.ts            # KDF, AEAD, Ed25519/X25519 unit verifications
│   ├── e2e.test.ts               # End-to-end multi-party messaging validation
│   ├── ratchet.test.ts           # Double Ratchet state transitions & skipped keys
│   ├── relay.test.ts             # Inbox claiming & envelope dispatch verification
│   └── storage.test.ts           # Dual-vault, page-padding & canary validation
│
└── README.md
```

---

## ✦ Quickstart

### Prerequisites
- **Node.js**: v18.x or v20.x LTS
- **JDK**: Version 17 (Required for native Android builds, e.g. Eclipse Adoptium Temurin 17)
- **Android SDK**: Build tools 36.x, NDK 27.x, CMake 3.22+ (with Ninja 1.12+)

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/aryanpol73/veil.git
cd veil

# Install root dependencies
npm install

# Install client packages
cd client && npm install

# Install server packages
cd ../server && npm install
cd ..
```

### 2. Start the Blind Relay Server
```bash
cd server
npm run dev
# Relay listening on ws://localhost:8080
```

### 3. Launch the Client

#### Running on Web Preview
```bash
cd client
npx expo start --web
```

#### Running on Android (Native Build with SQLCipher)
```bash
cd client/android
# Build the debug APK with x86_64 or arm64 architecture
./gradlew assembleDebug -PreactNativeArchitectures=x86_64

# Install and launch on an active emulator or connected device
adb install app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.veil.client/.MainActivity
```

---

## ✦ Verification & Tests

Veil enforces rigorous automated test coverage across all cryptographic boundaries.

```bash
# Run full Jest test suite
npm test

# Type-check TypeScript sources
npm run typecheck
```

### Automated Security Test Matrix

| Test Suite | Tests | Status | Verification Scope |
| :--- | :---: | :---: | :--- |
| **`tests/adversarial.test.ts`** | 10/10 | **PASS** | AAD tampering, forged Poly1305 tags, replay rejection, MITM envelope tampering |
| **`tests/crypto.test.ts`** | 17/17 | **PASS** | CSPRNG distribution, Ed25519 auth, X25519 ECDH, BLAKE2b KDF, Argon2id parameters |
| **`tests/ratchet.test.ts`** | 8/8 | **PASS** | Symmetric chain steps, out-of-order delivery, skipped key storage, forward secrecy |
| **`tests/storage.test.ts`** | 9/9 | **PASS** | Dual-vault creation, Canary verification, page ballast balance, contact blind index |
| **`tests/relay.test.ts`** | 8/8 | **PASS** | Blind inbox authorization, nonce challenge, fixed envelope padding |
| **`tests/e2e.test.ts`** | 1/1 | **PASS** | Full roundtrip provisioning, pairing, exchange, message decryption |
| **Total** | **53 / 53** | **100% PASS** | **0 errors, 0 warnings** |

---

## ✦ Threat Model & Honest Limits

Security engineering requires intellectual honesty. Veil is explicitly designed with known boundaries:

### What Veil Protects
- **Zero Centralized Directory:** No central database of phone numbers, user handles, or identity links exists to subpoena or breach.
- **E2EE Confidentiality & Integrity:** Message payloads cannot be decrypted or tampered with by network observers or relay operators.
- **At-Rest AES-256 Storage:** Vault records on disk are unreadable without the stretched Argon2id master key.
- **Plausible Deniability Under Physical Coercion:** Opening the Ghost PIN yields a completely functioning, decoy-populated messenger without leaking primary records.
- **Process & Overview Leakage:** Background minimization auto-locks state; OS app switchers are masked via `FLAG_SECURE`.

### Out-of-Scope / Honest Limits
- **Compromised Operating Systems:** If the host OS has a rootkit, kernel spyware, or hardware keylogger, no mobile software can guarantee security.
- **Physical Screen Capture:** Dynamic watermarking deters and attributes screenshots, but cannot prevent an adversary photographing the display with an external camera.
- **Traffic Correlation by Global Adversaries:** While envelopes are fixed at 4096 bytes and inboxes rotate, an adversary monitoring global ISP packet flow may observe network connection timing.
- **Prototype Status:** Veil has underwent internal adversarial testing, but has **not yet completed an independent third-party cryptographic audit**. Do not use for life-critical operations.

---

## ✦ Security Disclosure

If you identify a vulnerability or cryptographic weakness, please report it privately:

- **Email:** `security@veil.network` (or open an encrypted issue)
- Please provide reproducible steps and environment details. We follow a 90-day coordinated disclosure policy.

---

<div align="center">
  <sub>Built for sovereign privacy. Dedicated to cryptographic freedom.</sub>
</div>
