# VEIL — THREAT MODEL & SECURITY EVALUATION

**Document Version:** 1.0.0  
**Status:** Canonical Security Reference  
**Scope:** Mobile Client (iOS / Android / Web Preview) and Blind WebSocket Relay

---

## 1. Security Philosophy

Veil adopts an **honest, threat-calibrated approach** to privacy and security. We reject cryptographic marketing clichés such as "military-grade", "zero metadata", "mathematically untraceable", or "100% anonymous".

Every security guarantee provided by Veil is scoped to specific adversary models, explicit assumptions, and clear physical and cryptographic limits.

---

## 2. Trust Boundaries & Entities

| Entity | Trust Level | Description & Boundary |
|---|---|---|
| **Local Client Application** | **Trusted (Subject to OS Integrity)** | Performs local key generation, Argon2id derivation, Double Ratchet state transitions, payload encryption/decryption, and local database storage. |
| **Host Operating System** | **Conditionally Trusted** | Android / iOS kernel, system memory allocator, secure hardware enclave (Keychain / Keystore). If rooted, jailbroken, or compromised with malware/keyloggers, all client security degrades. |
| **Network Path** | **Untrusted** | Any intermediary ISP, cellular carrier, TLS middlebox, or global passive adversary monitoring TCP/IP traffic. |
| **Relay Server** | **Semi-Trusted / Blind** | An untrusted mailbox holder. Knows only ephemeral blinded inbox hashes, 4096-byte ciphertext blobs, and connection nonces. Has no user accounts, passwords, or plaintext keys. |
| **Recipient Peer** | **Selectively Trusted** | Authenticated via cryptographic fingerprint. Trusted to read received messages, but untrusted regarding unauthorized physical photography or deliberate device extraction. |

---

## 3. Adversary Profiles & Defenses

### 3.1 Global Passive Network Observer
- **Adversary Capabilities**: Inspects all network packets across ingress/egress points, records timing, flow volume, and packet sizes.
- **Veil Defenses**:
  - Transport Layer Security (WSS/TLS 1.3).
  - Fixed-size envelopes (exactly 4,096 bytes); small messages are padded with randomized or structured null padding.
  - Client cover traffic (`NOOP` frames) sent during idle periods to disguise active send/receive bursts.
- **Residual Risks & Limitations**: A sophisticated adversary with end-to-end traffic timing visibility can correlate connection duration, burst frequencies, and packet delivery intervals between two online endpoints. Veil does not implement a multi-hop onion routing network or mixnet (e.g., Tor, Nym).

### 3.2 Compromised or Malicious Relay Operator
- **Adversary Capabilities**: Controls the relay server process, monitors all incoming WebSocket frames, inspects server RAM, and can attempt frame injection, dropping, or reordering.
- **Veil Defenses**:
  - **End-to-End Encryption**: Payloads are sealed using XChaCha20-Poly1305 with keys derived via the Double Ratchet. The relay never receives plaintext or ratchet keys.
  - **Blinded Inboxes**: Addresses are rotating BLAKE2b hashes derived from ratchet public keys and the current epoch hour. The relay cannot link consecutive epochs without compromising the ratchet keys.
  - **First-Claim Authentication**: The relay enforces Ed25519 signature verification against the connection nonce. A third party cannot subscribe to an inbox claimed by someone else within the epoch.
  - **Zero Persistent Logging**: The relay runs without databases or persistent message logs. Messages are purged from RAM immediately upon client `ACK`.
- **Residual Risks & Limitations**:
  - A malicious relay can drop messages (denial of service).
  - A relay pre-claiming an inbox before the legitimate subscriber can intercept ciphertext blobs (though cannot decrypt them).
  - A compromised relay can log IP addresses and subscription timing at the transport layer (e.g., via reverse proxy logs or packet captures), defeating application-level zero-logging.

### 3.3 Coercive Physical Attacker (Duress / Forced Unlock)
- **Adversary Capabilities**: Physically detains the user and compels entry of the unlock PIN under threat of coercion.
- **Veil Defenses**:
  - **Dual-Partition Vault**:
    - Master PIN unlocks `veil_vault_primary.db`.
    - Ghost PIN unlocks `veil_vault_decoy.db`.
  - **Indistinguishable Timing**: Both Argon2id key derivations (`partition.primary` and `partition.decoy`) are executed unconditionally on every unlock attempt.
  - **Plausible Decoy Content**: The decoy vault is pre-seeded with realistic, neutral conversations and simulated activity.
  - **Equalized File Size**: During provisioning and routine use, ballast records pad the smaller database so file sizes on disk converge.
  - **Absence of Stored PINs / Canary Oracle**: Only an AEAD-sealed canary record is stored. An entered PIN either succeeds in decrypting the canary or fails.
- **Residual Risks & Limitations**:
  - **Repeated Filesystem Imaging**: An adversary who captures device images before and after a coercion event can inspect filesystem inode timestamps, journal structures, and file modification times to detect disparity.
  - **Hardware Keyloggers / Malicious Keyboards**: If the adversary had prior physical or root access, a keylogger captures both PINs.
  - **Public Awareness**: If the adversary knows Veil supports Ghost PINs, they may demand both or assume any mundane content is a decoy.

### 3.4 Forensic Device Acquisition (Lost, Stolen, or Seized Phone)
- **Adversary Capabilities**: Acquires the device in a locked state, dumps the flash storage or extracts SQLite files.
- **Veil Defenses**:
  - Argon2id key stretching (`m=64MB, t=3`) prevents rapid brute-force dictionary attacks against high-entropy PINs.
  - Device salt stored in hardware-backed keystore (`SecureStore` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`). A flash dump without keystore access lacks the salt needed to compute Argon2id.
  - In-database message bodies are individually sealed with XChaCha20-Poly1305 and domain-separated AAD (`msg|${id}`).
  - Timed message deletion is followed by `PRAGMA incremental_vacuum` and `PRAGMA wal_checkpoint(TRUNCATE)` to wipe SQLite slack space and WAL lingering pages.
  - View-Once messages never touch flash storage (`RamVault` only).

### 3.5 Recipient Exfiltration / Screen Capture
- **Adversary Capabilities**: The recipient takes a screenshot, screen recording, or photographs the screen with an external camera.
- **Veil Defenses**:
  - **Dynamic Watermark**: A non-removable SVG lattice encodes `BLAKE2b(deviceFingerprint | sessionId | recipientFingerprint | UTC minute)`. Leaked captures can be forensically attributed to the exact originating session and minute.
  - **Moiré Amplification**: The 11.3px non-integer lattice pitch creates high-frequency interference patterns when photographed by external digital camera sensors.
  - **Active Capture Mitigation**: iOS and Android screenshot/recording listeners trigger an immediate burn of all View-Once content currently in the viewport.
  - Android activates `FLAG_SECURE` to block OS-level screenshots and blank task switcher thumbnails.
  - **Hold-to-Reveal View-Once**: Text is obscured by a frosted crystalline shroud until held with a finger. Releasing the finger permanently purges the message from memory.
- **Residual Risks & Limitations**:
  - Watermarks do not physically prevent an external analog camera from capturing exposed screen pixels.
  - On a managed runtime (React Native / Hermes / JavaScript engine), zeroizing memory buffers (`wipe()`) is advisory; garbage collection sweeps may leave orphaned string copies in heap pages until overwritten.
