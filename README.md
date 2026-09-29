````markdown
# VEIL

### Privacy-first cryptographic messaging

Veil is a privacy-first, cryptographic messaging application built around
user-controlled identities, end-to-end encryption, contextual identities
("Masks"), dual-vault storage, and a metadata-minimized relay architecture.

> **Security status:** Veil is currently an internally security-hardened
> prototype. It has automated adversarial tests, but it has **not** been
> independently audited and should not yet be considered production-ready.

---

## ✦ Vision

Veil is designed around a simple principle:

> Your identity belongs to you — not to a phone number, email address,
> username directory, or centralized account.

Veil does not fundamentally depend on:

- Phone numbers
- Email addresses
- Server-side usernames
- Centralized contact directories
- Server-readable message content

Instead, identities are based on cryptographic key ownership.

---

## Core Concepts

### Cryptographic Identity

Each Veil identity is backed by cryptographic key material.

The system uses:

- Ed25519 for identity/signing operations
- X25519 for key agreement
- XChaCha20-Poly1305 for authenticated encryption
- BLAKE2-based derivation and hashing
- Argon2id for PIN-derived vault keys

---

### Masks

A single master identity can derive contextual sub-identities called
**Masks**.

Examples:

```text
PERSONAL
WORK
GAMING
FRIENDS
GHOST
````

Each Mask has its own cryptographic identity.

This allows users to maintain separate cryptographic personas without
creating separate accounts.

A Mask's identity is represented through its cryptographic fingerprint.

---

## Invitations

Veil uses cryptographic invitations rather than usernames or centralized
contact discovery.

An invitation contains cryptographically authenticated information
necessary to establish a relationship between two peers.

Example:

```text
veil://invite?v=1&...
```

The invitation contains:

* protocol version
* invitation key material
* exchange key material
* randomization/challenge data
* expiry
* cryptographic signature

Invitation signatures and expiration are validated before pairing.

### Current Web Limitation

The `veil://` scheme is intended for native deep-link handling.

A normal browser does not automatically know how to open:

```text
veil://invite?...
```

The current web/PWA experience therefore requires invitation
copy/import handling rather than assuming the custom scheme is
browser-clickable.

---

# End-to-End Encryption

Veil implements a custom ratcheting protocol for message encryption.

The current implementation includes:

* symmetric chain ratcheting
* DH ratchet transitions
* skipped-message key handling
* replay protection
* authenticated encryption
* authenticated additional data (AAD)
* persisted ratchet state
* rollback protection during unauthenticated state transitions

The implementation has automated tests covering:

* initial sessions
* ping-pong messaging
* DH ratchet transitions
* out-of-order messages
* duplicate messages
* replay attacks
* AAD tampering
* ciphertext tampering
* state serialization/restoration
* excessive counter gaps

### Important Security Note

Veil's ratchet implementation is custom and does not automatically inherit
the formal security properties of the Signal Double Ratchet specification.

Independent cryptographic review is still required before production
deployment.

---

# Dual Vault Architecture

Veil maintains two logical vault partitions:

```text
┌──────────────────────────────┐
│        VEIL VAULT            │
├──────────────────────────────┤
│                              │
│  MASTER PIN                  │
│      ↓                       │
│  PRIMARY VAULT               │
│                              │
│  Identity                    │
│  Contacts                    │
│  Messages                    │
│  Ratchet State               │
│                              │
├──────────────────────────────┤
│                              │
│  GHOST PIN                   │
│      ↓                       │
│  DECOY VAULT                 │
│                              │
│  Decoy Identity              │
│  Simulated History           │
│  Decoy Contacts              │
│                              │
└──────────────────────────────┘
```

The goal is to provide a plausible decoy environment under coercion.

### Current Security Status

Sensitive application data is protected with application-layer AEAD.

However, the current native SQLite configuration has an important
limitation:

**Native SQLCipher is not currently verified as active.**

The current audit found that the Expo SQLite configuration does not yet
prove native SQLCipher compilation/linking, meaning SQLite database
structure and filesystem metadata may remain exposed even though sensitive
fields are encrypted at the application layer.

This must be fixed and verified on real Android and iOS builds.

---

# Blind Relay

Veil uses a relay architecture designed to minimize server knowledge.

The relay is responsible for:

```text
Client A
   │
   │ encrypted envelope
   ▼
┌───────────────┐
│ Blind Relay   │
└───────────────┘
   │
   │ encrypted envelope
   ▼
Client B
```

The relay does not need access to plaintext message bodies.

The transport includes:

* WebSocket communication
* authenticated inbox claiming
* challenge/response authentication
* first-claim inbox ownership
* fixed-size message envelopes
* offline buffering
* acknowledgements
* ping/pong
* NOOP/cover traffic
* Redis-compatible relay architecture

---

# Message Envelopes

Veil uses fixed-size envelopes.

Target envelope size:

```text
4096 bytes
```

Random padding is used to reduce message-size correlation.

However:

> Padding alone does not provide metadata confidentiality.

The current audit identified that sender and recipient fingerprints are
currently present in the outer envelope header.

Therefore a relay operator can potentially observe communication
relationships even without seeing message plaintext.

### Planned Security Improvement

Implement a sealed-sender style outer envelope so that the relay receives
only encrypted high-entropy envelope data.

---

# Message Retention

Veil supports multiple retention modes.

## Persistent

Messages remain available normally.

Visual language:

```text
Obsidian glass
Emerald status indicator
```

## Timed

Messages expire after a configured TTL.

Visual language:

```text
Smoked quartz
Amber countdown
```

## View-Once

Content is intended to exist only for a single viewing.

Visual language:

```text
Crystalline shroud
Magenta edge
Hold-to-reveal
```

### Security limitation

View-Once behavior cannot guarantee that plaintext never existed in
process memory or that a recipient cannot photograph or otherwise capture
the screen.

Managed mobile runtimes, operating systems, GPUs, screenshots, cameras,
and forensic tooling are outside the application's complete control.

---

# Privacy & Metadata

Veil is designed around **metadata minimization**, not the claim of
absolute zero metadata.

Even with encrypted message contents, infrastructure can potentially
observe information such as:

* network connections
* connection timing
* relay traffic
* delivery timing
* IP addresses
* device/network characteristics
* message frequency
* filesystem metadata

Future protocol work aims to reduce these signals further.

---

# Dynamic Watermark

Veil includes dynamic watermarking intended to discourage unauthorized
capture and provide contextual attribution.

The watermark may incorporate contextual identity information and
session-specific information.

Important:

> A watermark is an attribution/deterrence mechanism, not mathematical
> proof of who created a screenshot.

It cannot prevent photographs of the physical screen.

---

# Privacy-Focused UI

Veil uses the **Obsidian Prism** design language.

### Visual principles

* Midnight indigo
* Smoke pitch
* Cyan refraction
* Acid-lime accents
* Violet highlights
* Frosted glass
* Specular borders
* Controlled blur
* Cryptographic HUD typography

### Typography

Cryptographic information:

```text
JetBrains Mono / Fira Code
```

Normal application content:

```text
Inter / system sans-serif
```

The interface should feel like a privacy-focused cryptographic instrument,
rather than a conventional SaaS dashboard.

---

# Architecture

The project is organized into client and server components.

```text
veil/
│
├── client/
│   ├── src/
│   │   ├── crypto/
│   │   ├── identity/
│   │   ├── contacts/
│   │   ├── messaging/
│   │   ├── protocol/
│   │   │   └── ratchet/
│   │   ├── storage/
│   │   ├── transport/
│   │   ├── components/
│   │   └── screens/
│   │
│   ├── App.tsx
│   ├── app.json
│   └── package.json
│
├── server/
│   ├── relay/
│   ├── transport/
│   └── package.json
│
├── tests/
│
└── README.md
```

---

# Technology Stack

## Client

* React Native
* Expo
* TypeScript
* React
* Expo SecureStore
* Expo SQLite
* Expo Screen Capture

## Cryptography

* Ed25519
* X25519
* XChaCha20-Poly1305
* BLAKE2
* Argon2id
* Cryptographically secure random generation

## Transport

* WebSocket
* WSS in production
* Redis-compatible relay infrastructure

## Testing

* TypeScript type checking
* Automated unit tests
* Protocol tests
* Relay tests
* Storage tests
* Adversarial security tests
* End-to-end tests

---

# Security Model

Veil's security model assumes that:

### Protected

* Message plaintext
* Private identity keys
* Ratchet secrets
* Vault secrets
* Contact private metadata
* Application-layer encrypted fields

### Potentially Observable

Depending on deployment and native hardening:

* Network metadata
* Connection timing
* Relay activity
* Filesystem metadata
* SQLite structural metadata
* OS-level artifacts
* Device-level forensic information

Veil does not claim protection against a fully compromised operating
system.

---

# Threat Model

Veil considers threats including:

* Relay compromise
* Malicious relay operators
* Network observers
* Message replay
* Ciphertext modification
* AAD manipulation
* Inbox hijacking
* Forged acknowledgements
* Identity replacement
* Ratchet state desynchronization
* Excessive ratchet counter jumps
* Local database extraction
* PIN coercion
* Screen capture
* Crash artifacts
* Device forensic extraction

---

# Current Security Verification

The latest internal verification run reported:

```text
53 tests
6 suites
53 passed
0 failed
0 skipped
```

Coverage includes:

```text
Adversarial Security      10/10
Crypto Core               17/17
End-to-End                 1/1
Double Ratchet             8/8
Relay                      8/8
Storage / Dual Vault       9/9
```

The TypeScript typecheck also passed with zero reported errors at the time
of the audit.

### Important

Passing automated tests does **not** constitute an independent security
audit.

---

# Security Verification Levels

Veil deliberately distinguishes between:

```text
IMPLEMENTED
    ↓
TESTED
    ↓
NATIVE-TESTED
    ↓
SECURITY-REVIEWED
    ↓
INDEPENDENTLY-AUDITED
    ↓
PRODUCTION-VERIFIED
```

These states are not equivalent.

The current project has not reached independent audit or production
verification.

---

# Known Security Gaps

The current security audit identified several remaining issues.

## P0

### Native SQLCipher

Native SQLCipher is not currently verified as linked into Android/iOS
builds.

### Sealed Sender

Sender and recipient fingerprints are currently visible in the outer
envelope.

### Background Locking

The application does not yet reliably auto-lock and purge sensitive
runtime state when backgrounded.

### Ghost PIN Timing

Sequential primary/decoy vault probing can potentially create a timing
difference that distinguishes the two PIN types.

---

## P1

### Custom Ratchet Review

The custom ratchet requires independent cryptographic review.

### TLS Enforcement

Production builds must enforce secure WebSocket transport.

```text
wss://
```

must be used rather than insecure:

```text
ws://
```

### Filesystem Forensics

Vault timestamps, WAL files, and other filesystem artifacts require
additional hardening.

---

## P2

### Timed Message Clock Manipulation

TTL expiration currently depends on device wall-clock time and requires
additional protection against clock manipulation.

### Screen Shielding

Screen-capture protection must cover the entire sensitive application
surface rather than only the chat screen.

---

# Development

## Install

Clone the repository:

```bash
git clone https://github.com/aryanpol73/veil.git
cd veil
```

Install client dependencies:

```bash
cd client
npm install
```

Install server dependencies:

```bash
cd ../server
npm install
```

---

# Running the Development Environment

## Backend

```bash
cd server
npm run dev
```

## Frontend

In another terminal:

```bash
cd client
npx expo start
```

For Android:

```bash
npx expo start --android
```

For iOS:

```bash
npx expo start --ios
```

For the web development build:

```bash
npx expo start --web
```

---

# Testing

Run the client test suite:

```bash
cd client
npm test
```

Run TypeScript validation:

```bash
npx tsc --noEmit
```

Before submitting changes, verify:

```text
✓ TypeScript
✓ Unit tests
✓ Crypto tests
✓ Ratchet tests
✓ Relay tests
✓ Storage tests
✓ Adversarial tests
✓ Native Android behavior
✓ Native iOS behavior
✓ Web behavior
```

---

# Development Principles

Veil follows several engineering principles.

### 1. Security over convenience

Do not weaken cryptographic or privacy properties to make UI behavior
simpler.

### 2. Explicit trust

Identity changes must be visible to the user.

### 3. No fake cryptography

Do not describe hashing, obfuscation, or encoding as encryption.

Do not describe a hash as zero-knowledge proof.

### 4. Minimize metadata

Protect message contents while continuously reducing unnecessary metadata.

### 5. Fail closed

Invalid cryptographic state should result in rejection rather than silent
fallback.

### 6. No plaintext at the relay

The relay should never require message plaintext to perform delivery.

### 7. Native verification matters

A passing Node/JavaScript test does not prove equivalent Android/iOS
security.

---

# Roadmap

## Phase 1 — Core Protocol

* [x] Cryptographic identity
* [x] Masks
* [x] Invitations
* [x] E2EE messaging
* [x] Ratchet implementation
* [x] Replay protection
* [x] Blind relay
* [x] Fixed-size envelopes

## Phase 2 — Security Hardening

* [x] Ratchet rollback protection
* [x] Contact encryption
* [x] Ratchet persistence
* [x] Adversarial testing
* [x] Dual-vault architecture
* [ ] Native SQLCipher verification
* [ ] Sealed sender
* [ ] Global background locking
* [ ] Ghost-vault timing hardening
* [ ] Native forensic validation

## Phase 3 — Native Hardening

* [ ] Android real-device verification
* [ ] iOS real-device verification
* [ ] Android ↔ Android E2E
* [ ] iOS ↔ iOS E2E
* [ ] Android ↔ iOS E2E
* [ ] Production WSS enforcement
* [ ] TLS/certificate hardening
* [ ] Crash/logging audit
* [ ] Dependency/supply-chain audit

## Phase 4 — Independent Security Review

* [ ] Independent cryptographic review
* [ ] Protocol review
* [ ] Native storage review
* [ ] Mobile security assessment
* [ ] Relay infrastructure assessment
* [ ] Penetration testing
* [ ] Remediation verification

---

# Project Status

```text
                 VEIL
                   │
          ┌────────┴────────┐
          │                 │
       CLIENT             RELAY
          │                 │
      E2EE Core         Blind Transport
          │                 │
      Dual Vault        WebSocket
          │                 │
       Masks              Redis
          │
       Ratchet
```

Current status:

```text
Core architecture       ████████████████░░░░
Crypto implementation   ███████████████░░░░░
Automated testing       ██████████████████░░
Native hardening        ████████░░░░░░░░░░░░
Independent audit       ░░░░░░░░░░░░░░░░░░░░
Production verification ░░░░░░░░░░░░░░░░░░░░
```

Veil is actively under security hardening.

---

# Responsible Security Disclosure

If you discover a security vulnerability, do not publicly disclose
exploitable details before the issue has been investigated.

Provide:

* affected component
* reproduction steps
* security impact
* affected platform/version
* proof of concept where appropriate

---

# License

License information will be added before public production release.

---

## Disclaimer

Veil is experimental security software.

Do not rely on the current implementation for protection against
high-risk adversaries or coercive situations.

Cryptographic software requires independent review, native-platform
verification, and operational security testing before it can be considered
production-ready.

```

**One change I'd strongly recommend:** don't put the current security gaps in a hidden document only. Keeping them in the README makes the project much more credible because it clearly separates **what Veil has implemented** from **what has actually been security-verified**. :contentReference[oaicite:1]{index=1}
```
