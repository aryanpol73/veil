# VEIL — SECURITY LIMITATIONS & NON-CLAIMS

**Document Version:** 1.0.0  
**Status:** Mandatory Security Disclosure  
**Scope:** Client Application, Cryptographic Implementation, Relay Infrastructure

---

## 1. Managed Runtime & Memory Forensics

Veil's mobile client is built on React Native and the Hermes JavaScript engine.

### 1.1 Inability to Guarantee Cryptographic Memory Erasure
- **Limitation**: While Veil implements a `wipe(...buffers)` function that fills typed arrays (`Uint8Array.fill(0)`), JavaScript engines (including Hermes and V8) frequently duplicate strings and array buffers internally during string operations, JSON serialization, and message passing across the React Native bridge.
- **Consequence**: A physical memory extraction or cold-boot attack performed on an active or recently suspended device may discover plaintext fragments, decrypted message bodies, or intermediate KDF outputs that have been freed by JavaScript but not yet zeroed by the OS memory allocator.
- **Guidance**: Do NOT claim "forensic memory erasure" or "zero-trace RAM". RAM-only persistence (such as `RamVault` for View-Once) mitigates persistent flash storage leaks, but does not provide hardware-isolated security against memory dumping.

---

## 2. Screen Capture & Physical Photography

### 2.1 External Cameras (Analog Hole)
- **Limitation**: No software overlay can prevent an external digital camera, DSLR, or secondary smartphone from photographing an active OLED/LCD display.
- **Forensic Role of Dynamic Watermark**: The watermark is an attribution tool, NOT an anti-photography force field. It embeds a deterministic carrier lattice so that leaked photographs can be traced to the device fingerprint, session ID, and UTC minute.
- **Moiré Effect**: While high-frequency lattice spacing creates moiré interference on most sensor grids, this does not render text completely unreadable under all camera lenses or post-processing algorithms.

### 2.2 OS Screen Recording & Modified Operating Systems
- **Limitation**: Active capture detection relies on standard OS APIs (`expo-screen-capture`, `UIScreen.isCaptured`, `FLAG_SECURE`).
- **Consequence**: On a rooted, jailbroken, or custom-ROM Android/iOS device, the adversary can modify the OS display compositor (SurfaceFlinger or QuartzCore) to record the framebuffer without triggering any client-side callbacks.

---

## 3. Dual-Partition Vault (Ghost PIN / Decoy Mode)

### 3.1 Repeated Filesystem Imaging
- **Limitation**: Dual partitions (`veil_vault_primary.db` and `veil_vault_decoy.db`) reside in the application's sandboxed document directory.
- **Consequence**: An adversary who captures an initial flash backup, coerces the user to provide a PIN, unlocks the device, and then takes a second flash backup can compare SQLite filesystem metadata (modification timestamps, inode numbers, journal sector writes). If only the decoy database changed, the adversary can deduce that the primary vault was untouched.

### 3.2 Coercion with Public Knowledge of Feature
- **Limitation**: Deniability mechanisms fail when the adversary already knows the software architecture supports decoy modes. An informed interrogator can demand all PINs or simply refuse to release the subject until the primary content is revealed.

---

## 4. Blind Relay & Network Traffic Analysis

### 4.1 End-to-End Traffic Correlation
- **Limitation**: Veil uses a single blind relay rather than a decentralized multi-hop mixnet (like Tor or Nym).
- **Consequence**: While payloads are end-to-end encrypted and uniform in size (4,096 bytes), a global passive network adversary (or an adversary monitoring both sender and recipient network connections) can correlate packet timestamps and burst patterns to deduce who is communicating with whom.

### 4.2 Transport-Layer IP Logging
- **Limitation**: The Veil relay server application logs no IP addresses and uses no persistent storage. However:
- **Consequence**: Any reverse proxy (Nginx, Cloudflare, AWS ALB) or host cloud provider placed in front of the relay can log incoming IP addresses and TLS session handshakes independently of the application layer.

### 4.3 Pre-Claiming Attacks
- **Limitation**: The relay uses first-claim authorization in RAM for blinded inboxes.
- **Consequence**: If an active adversary controls the relay before an epoch begins and predicts or monitors an inbox ID subscription attempt, they can pre-claim the inbox with their own key, causing legitimate subscriptions to be `DENIED`.

---

## 5. Web Preview Environment Limitations

### 5.1 Lack of Secure Enclave & File Encryption
- **Limitation**: The web build (`Platform.OS === 'web'`) is strictly a development and functional preview environment.
- **Consequence**: Web browsers do not offer equivalent hardware-backed keystores (`Keychain` / `Android Keystore`). The web driver uses an in-memory database (`memoryDriver`) and cannot guarantee secure multi-partition isolation.
- **Policy**: The web build must NEVER be marketed or deployed as a production privacy messenger. Production security guarantees apply only to native iOS and Android builds.

---

## 6. Push Notifications & Metadata

### 6.1 Platform Push Service Inherent Leakage
- **Limitation**: Apple Push Notification service (APNs) and Firebase Cloud Messaging (FCM) route through Apple and Google infrastructure.
- **Consequence**: Veil NEVER includes message plaintext, sender aliases, or conversation IDs in push notifications. However, the mere delivery of a wake-up push notification discloses to the platform vendor that a specific device received a message at a specific timestamp.
