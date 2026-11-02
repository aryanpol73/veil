# 02 — Features, User Stories and Acceptance Criteria

**Date:** 2026-11-02 · **Depends on:** [00-audit.md](00-audit.md), [01-product-plan.md](01-product-plan.md) · **Status:** draft for approval

## How to read this

- **Priority:**
  - **P0** = required for the MVP (Phase 1 + Phase 2 P0).
  - **P1** = first release after MVP.
  - **P2** = later or only if cheap.
- **State** uses the audit tags: [implemented] / [partial] / [planned] / [unknown], plus **broken** where the code exists but is wrong.
- **Fixes** lists the audit findings (A-xx) that must close for the feature to pass.
- **Personas:** **J** journalist, **O** organiser, **L** NGO lawyer, **H** person in an abusive household, **E** examiner/coercer (adversary, used in negative stories).
- Acceptance criteria (AC) are written to become tests. "Test:" names the kind of test that proves each one. "Device" means a manual or automated run on a physical phone.
- Product decisions still open in `01` §11 are assumed at their recommended default and marked **(assumes P-x)**.

---

## Feature index

| ID | Feature | Priority | State | Fixes |
|---|---|---|---|---|
| F-01 | Provisioning (identity + dual vault) | P0 | [partial] | A-06, A-19 |
| F-02 | PIN unlock | P0 | **broken** | A-04, A-12 |
| F-03 | Decoy vault that passes inspection | P0 | [partial] | A-05, A-06, A-07 |
| F-04 | Auto-lock and session teardown | P0 | [partial] | A-10 |
| F-05 | At-rest encryption, verified | P0 | [unknown] | A-13 |
| F-06 | Invites: create, share, scan, expire, revoke | P0 | [partial] | A-03 (rz), A-22 |
| F-07 | Authenticated first contact | P0 | [partial] | A-03 |
| F-08 | Safety number verification and key-change warning | P0 | [partial] | A-11 |
| F-09 | 1:1 messaging with three retention modes | P0 | [partial] | A-15, A-23 |
| F-10 | Reliable delivery: offline queue, retry, delivery state | P0 | [planned] | A-08, A-15 |
| F-11 | Blind relay with no identity or metadata exposure | P0 | [partial] | A-01, A-02, A-09 |
| F-12 | Relay abuse resistance | P0 | [partial] | A-14, A-17 |
| F-13 | Transport security (TLS, relay choice) | P0 | [partial] | A-16 |
| F-14 | Encrypted backup and restore | P0 (assumes P-4) | [planned] | — |
| F-15 | Self-hostable relay | P0 | [planned] | A-28 |
| F-16 | Screen protection and watermark | P0 | [implemented] / [unknown] on device | — |
| F-17 | Attachments (images, files) | P1 | [planned] | — |
| F-18 | Small groups (≤ 20) | P1 | [planned] | — |
| F-19 | Notifications (content-free wake-up) | P1 | [planned] | — |
| F-20 | Panic wipe and duress shortcut | P1 | [partial] | — |
| F-21 | Tor / onion transport | P1 | [planned] | — |
| F-22 | Message search inside open vault | P2 | [planned] | — |
| F-23 | Localisation (Hindi + 2–3 languages) | P2 | [planned] | — |
| F-24 | Agent / bot contacts | P2 | [planned] | — |
| F-25 | Multi-device | P2 (non-goal for MVP) | [planned] | — |

---

## P0 — MVP

### F-01 Provisioning

**Stories**
- As **J**, I want to set up Veil without a phone number or email, so that nothing links the app to my legal identity.
- As **H**, I want setup to create my real space and a decoy space in one go, so that the decoy does not look newer than the real one.

**Acceptance criteria**
1. Setup asks for no phone number, email, name or network call before both vaults exist. *Test: unit + network-mock assertion.*
2. Both vault files are created in the same pass and have equal size after setup, within one SQLite page group. *Test: device, real SQLite.*
3. Primary and decoy identities come from **independent** 256-bit seeds; neither seed can be derived from the other. *Test: unit* (already true [implemented]).
4. Seeds, masks and PINs are wiped from JS memory when setup completes (best effort, documented as such). *Test: unit asserting buffers are zeroed.*
5. Setup copy explains the Ghost PIN once, and that explanation is never reachable again after setup unless the user opens it from a neutral help entry. *Test: UI snapshot; grep for "ghost/decoy/duress" in post-setup screens = 0.*
6. Setup rejects master = ghost PIN, and PINs shorter than the minimum (see F-02). *Test: unit.*

### F-02 PIN unlock

**Stories**
- As **L**, I want to unlock with my PIN quickly, so that I actually keep the app locked.
- As **E**, I must not be able to tell from timing, UI or retries which vault a PIN opened, or whether a second vault exists.

**Acceptance criteria**
1. Any PIN accepted at setup can be entered at unlock. Length range is the same constant in both screens. *Test: unit on the shared constant + UI test with 6- and 8-digit PINs.* (Fixes A-04.)
2. Unlock time for master PIN, ghost PIN and wrong PIN differ by ≤ 5% (median of 20 runs) on the reference low-end Android device. *Test: device benchmark.*
3. Cold unlock completes in ≤ 3 s on the reference device; the UI shows progress and never freezes long enough to trigger an ANR. *Test: device.* (Argon2id parameters tuned against this, per Phase 1.)
4. Wrong attempts are limited with an escalating delay that is stored so it is **identical regardless of which vault exists or was last opened**. No counter or delay lives inside either vault. *Test: unit + device.* (Fixes A-12.)
5. The attempt limiter never wipes data on its own, unless the user turned that on at setup (see F-20).
6. Error text is the same for every failure ("Incorrect PIN"). *Test: unit.*

### F-03 Decoy vault that passes inspection

**Stories**
- As **H**, when I am forced to unlock, I want the decoy to look like an ordinary messenger I use, so that the person checking does not suspect anything.
- As **E**, I inspect the unlocked app for five minutes and look for anything unusual.

**Acceptance criteria**
1. No screen, label, accessibility string, log line or notification differs between vaults, except the user's own content. "GHOST", "decoy", "duress" and "partition" never render after setup. *Test: UI test run under both PINs; diff the accessibility trees.* (Fixes A-05, A-06.)
2. Decoy starting content is generated per install from a documented, seeded generator. Two installs never share contact names, message text or fingerprints. *Test: unit, 1 000 generated installs, no collisions.* (Fixes A-07.)
3. Decoy contact records are internally consistent: fingerprints are computed from the stored keys and have the same format as real ones. *Test: unit.*
4. The decoy identity can send and receive real messages with real contacts the user adds while in the decoy. *Test: e2e.*
5. The primary vault is never empty-looking next to a populated decoy; both start with comparable visible state (decision: both start empty, or both seeded; see open question 1). *Test: UI test.*
6. An examiner following the written drill (see `05`) identifies the decoy in ≤ 1 of 5 sessions. *Test: red-team drill, manual.*

### F-04 Auto-lock and session teardown

**Stories**
- As **J**, if my phone is grabbed while Veil is open, I want it locked the moment I switch away.
- As **J**, I don't want the app to lock while I'm sharing an invite through the system share sheet.

**Acceptance criteria**
1. Lock (manual, background, or timeout) closes the vault and purges: ratchet cache, message-service state, relay subscriptions, RAM vault and identity keys. After lock, no relay frame is ACKed. *Test: unit with spies on each component.* (Fixes A-10.)
2. Lock is awaited before navigation shows the unlock screen. *Test: unit.*
3. App-switcher thumbnail shows no content. *Test: device* ([unknown] today).
4. Transient system overlays (iOS Control Centre, permission prompts, the share sheet Veil itself opened) do not lock; real backgrounding does, with a configurable grace period (default 0 s). *Test: device.*
5. Messages that arrive while locked stay at the relay until the next unlock. *Test: e2e.*

### F-05 At-rest encryption, verified

**Stories**
- As **L**, if my phone is imaged in a lab, I want nothing readable on disk without my PIN.

**Acceptance criteria**
1. On native builds, the app refuses to provision or open a vault unless SQLCipher reports a version (`PRAGMA cipher_version`), and fails closed with a clear error otherwise. *Test: device + unit with a stub driver.* (Fixes A-13.)
2. A raw dump of both vault files shows no recognisable SQLite header, table names or plaintext. *Test: device; `strings`/entropy check on pulled files.*
3. Device salt is stored only in Keystore/Keychain with `THIS_DEVICE_ONLY`. If the keystore write fails, setup fails; it never falls back to RAM. *Test: unit with failing keystore stub.*
4. SQLCipher key and field-encryption key are separate subkeys derived from the vault key. *Test: unit.*
5. Vault files are excluded from OS cloud backups (Android `allowBackup=false` / backup rules; iOS no-backup attribute). *Test: device / manifest check.*

### F-06 Invites

**Stories**
- As **O**, I want to add someone by showing a QR code across the table, so that we don't need any server lookup.
- As **J**, I want to send an invite link over another channel when we can't meet, and have it stop working once used or after a short time.
- As **J**, I want to cancel an invite I shared by mistake.

**Acceptance criteria**
1. Invite QR renders with dark modules on a light background and scans with the stock camera on Android and iOS. *Test: device.*
2. The app can scan a QR invite with the camera, and opens `veil://invite` links. *Test: device.*
3. Copy and Share work on native. *Test: device.*
4. Each invite is single-use: after one successful first contact through it, further first-contact attempts with it are rejected by the inviter. *Test: e2e.*
5. Invites expire (default 1 h, user-selectable up to 7 days); the inviter can revoke any unexpired invite from a list. *Test: unit + e2e.*
6. Invites contain no plaintext nickname unless the user typed one, and the UI says the nickname is visible to anyone holding the invite. *Test: unit.*
7. `toqr` (or its replacement) is a declared dependency; `npm ci` succeeds from a clean checkout. *Test: CI.* (Fixes A-22.)

### F-07 Authenticated first contact

**Stories**
- As **J**, when someone messages me through my invite, I want proof of who they are, so that a third person holding the invite cannot pose as my source.

**Acceptance criteria**
1. The first message carries the initiator's identity, encrypted and authenticated, so the recipient can compute the initiator's real fingerprint. *Test: unit + e2e.* (Fixes A-03.)
2. A message claiming to be from an existing contact, but signed by a different key, never lands in that contact's thread. *Test: adversarial.*
3. Session keys depend on both parties' identity keys and on fresh ephemeral keys; compromise of the inviter's long-term key alone does not decrypt past first messages. *Test: unit with test vectors from `04`.*
4. A first contact appears as a pending request the user accepts or rejects; rejecting leaves no contact record. *Test: UI + unit.*
5. The protocol is specified in `04-protocol-and-api.md` with test vectors before implementation. *Test: spec-drift check (Phase 4).*

### F-08 Safety numbers and key-change warnings

**Stories**
- As **L**, I want to compare a short code with my client in person, so that I know no one is in the middle.
- As **L**, if a contact's keys ever change, I want a warning I can't miss before I send anything.

**Acceptance criteria**
1. A verification screen shows both parties' combined safety number, plus a QR to scan for automatic comparison. *Test: UI + unit.*
2. Verified state persists across restarts. *Test: unit with real SQLite.*
3. A key change on an existing contact sets `CHANGED_IDENTITY`, persists it, blocks sending until the user acknowledges, and clears "verified". *Test: adversarial, without hard-coded IDs.* (Fixes A-11.)
4. The warning copy follows the security-prompt rules in `06`.

### F-09 1:1 messaging with retention modes

**Stories**
- As **O**, I want to choose per message whether it stays, disappears after a time, or can be viewed once.
- As a sender, I want the recipient's app to honour my choice.

**Acceptance criteria**
1. Persistent messages survive restart; timed messages are deleted at `read + ttl` and never before they are read (receiver side). *Test: unit with real SQLite.* (Fixes A-23.)
2. View-once messages never touch disk on either side: no SQLite row, no WAL page, no log. *Test: unit (CHECK constraint) + device file scan.*
3. Messages up to the maximum size send successfully; over-size input is blocked in the composer with a visible limit, never silently failing or duplicating. *Test: unit + UI.* (Fixes part of A-15.)
4. Retention mode is authenticated (part of AEAD AAD) and is not visible to the relay. *Test: unit + relay-capture assertion.*
5. Deleted messages are vacuumed and the WAL truncated, as today. *Test: device file scan.*

### F-10 Reliable delivery

**Stories**
- As **J**, when I write without signal, I want the message to send by itself later.
- As **O**, I want to see if a message is queued, sent to the relay, or delivered to the phone, without that revealing more to the relay.

**Acceptance criteria**
1. Outgoing messages go to a persistent outbox and are retried with backoff until the relay accepts or the user deletes them. *Test: e2e with relay restart.*
2. States shown: queued → sent (relay accepted) → delivered (end-to-end receipt, encrypted). Delivery receipts can be turned off; turning them off sends none. *Test: e2e.*
3. Recipient offline for 24 h (relay TTL) then reconnecting receives every message sent in that window, in order. *Test: e2e soak with clock control.* (Fixes A-08.)
4. The client confirms receipt to the relay only after the message is decrypted **and** committed together with the ratchet state in one transaction. A crash at any point loses no message and causes no duplicate. *Test: fault-injection unit tests.* (Fixes A-15.)
5. Duplicate, out-of-order and replayed envelopes are handled through the real `RelayClient` and `MessageService` path. *Test: e2e rewritten to drive production classes.*

### F-11 Blind relay

**Stories**
- As **J**, I want the relay operator, even if compelled, to be unable to tell who I talk to.

**Acceptance criteria**
1. No frame the relay receives contains a long-term public key, fingerprint, contact identifier, message counter, retention mode or plaintext length. *Test: e2e capture of every relay frame, asserted against a deny-list of known identity values.* (Fixes A-01, A-02; replaces the plaintext-only criterion 20.)
2. Inbox addresses for one user are unlinkable across epochs and across contacts without session secrets. *Test: unit property test.*
3. Knowing a user's invite is not enough to compute or claim their inbox addresses. *Test: adversarial.* (Fixes A-09.)
4. A denied subscription is surfaced to the client and retried, and shown to the user if it persists. *Test: unit.*

### F-12 Relay abuse resistance

**Stories**
- As a relay operator, I want the relay to stay up under spam or floods without learning who users are.

**Acceptance criteria**
1. A global memory budget caps the total queued bytes; when full, the relay rejects new sends with `DROPPED` (never silent eviction). *Test: relay unit.* (Fixes A-14.)
2. Inbox creation and sending to a new inbox need a cheap proof-of-work or anonymous token (choice made in an ADR). *Test: relay unit.*
3. Per-connection and per-inbox rate limits, and a cap on claims; malformed inbox IDs are rejected on SUB as on SEND. *Test: relay unit.*
4. The relay logs no IPs or inbox IDs by default; aggregate counters only. *Test: log-capture test.*
5. Multi-node mode either works (bus initialised and tested with real Redis) or is removed until it does. *Test: integration in CI with a Redis container.* (Fixes A-17.)

### F-13 Transport security

**Acceptance criteria**
1. Release builds refuse `ws://` except to localhost; production default is `wss://`. *Test: unit.* (Fixes A-16.)
2. The user can add, choose and remove relays; the relay list is stored inside the vault (so the decoy can have different relays). *Test: unit + UI.*
3. Optional relay-key pinning per relay, configured from an invite or a relay QR. *Test: unit.*

### F-14 Encrypted backup and restore (assumes P-4)

**Stories**
- As **J**, if my phone is lost or seized, I want to restore my identity and contacts on a new phone.
- As **H**, a backup file found on my computer must not reveal that Veil, or a second vault, exists.

**Acceptance criteria**
1. Export creates one file encrypted under a user passphrase (Argon2id); the file is indistinguishable from random and has a fixed or bucketed size. *Test: unit (entropy, size buckets).*
2. A written recovery phrase (BIP-39-style word list) can restore the seed alone, giving identity without history. *Test: unit with vectors.*
3. Each vault is backed up separately, under the PIN that opened it; a primary backup reveals nothing about the decoy and vice versa. *Test: unit.*
4. Restoring on a new device works; the old device's sessions are re-keyed and contacts are told to re-verify (key-change flow, F-08). *Test: e2e with two devices.*
5. No cloud upload by default; the user chooses where the file goes. *Test: unit.*

### F-15 Self-hostable relay

**Stories**
- As an NGO tech lead, I want to run our own relay in under 30 minutes and point our phones at it.

**Acceptance criteria**
1. A Docker image builds and runs from a non-empty `server/Dockerfile`, with documented env vars, and exposes `/healthz`. *Test: CI builds and smoke-tests the image.* (Fixes A-28.)
2. A one-page deployment guide with TLS (Caddy or Nginx), tested by someone who has not seen the code, takes ≤ 30 min. *Test: manual timed run.*
3. Reverse-proxy templates disable access logs by default. *Test: config review.*

### F-16 Screen protection and watermark

**Acceptance criteria**
1. Screenshots and screen recording are blocked on Android (FLAG_SECURE) across all screens. *Test: device.*
2. On iOS, recording or mirroring blurs content and burns visible view-once messages. *Test: device.*
3. The watermark is on by default only in chat views, can be turned off, and its tag derivation is documented in `05`. *Test: unit for the tag; device for visibility.*

---

## P1 — First release after MVP

### F-17 Attachments
- **Story:** As **J**, I want to send a photo of a document without it revealing where or when it was taken.
- **AC:**
  1. Images and files are encrypted client-side and split into fixed-size envelopes; the relay sees only standard envelopes.
  2. EXIF, GPS and other metadata are stripped before encryption, and the user is told this.
  3. Large attachments have a size cap and a TTL at the relay; interrupted transfers resume.
  4. View-once applies to images (RAM only).

### F-18 Small groups (≤ 20)
- **Story:** As **O**, I want a group chat for my team, where only members know who is in it.
- **AC:**
  1. Pairwise fan-out over existing 1:1 sessions; the relay cannot tell a group message from a 1:1 message.
  2. Membership changes are signed by the admin and visible to members only.
  3. Removing a member stops delivery to them for all future messages.
  4. Maximum 20 members, enforced.

### F-19 Notifications
- **Story:** As **L**, I want to know a message arrived without Google or Apple seeing who it's from.
- **AC:**
  1. Off by default.
  2. When on, the push is content-free (no sender, no text, no thread).
  3. UnifiedPush/ntfy on Android first; FCM/APNs optional, with a disclosure that the vendor sees timing.
  4. The notification text is identical in both vaults.

### F-20 Panic wipe and duress shortcut
- **Story:** As **O**, if I'm about to be detained, I want one action that destroys my real data and leaves a normal-looking app.
- **AC:**
  1. Reachable from a configurable gesture or a "wipe PIN" set at setup (optional).
  2. Destroys the primary vault and rotates the salt (existing `panicWipe`).
  3. Afterwards the app opens normally with no "wiped" state.
  4. Does not re-seed fixed content (depends on F-03 AC 2).

### F-21 Tor / onion transport
- **AC:**
  1. Optional toggle, with a stated latency cost.
  2. Relay reachable as an onion service.
  3. The setting is per vault.

---

## P2 — Later

| ID | Feature | Summary acceptance |
|---|---|---|
| F-22 | Search | Index lives inside SQLCipher only, is built after unlock, and is wiped on lock; no plaintext index file |
| F-23 | Localisation | Hindi + 2–3 languages chosen with the partner community; security prompts reviewed by native speakers; no analytics |
| F-24 | Agent / bot contacts | Bots are ordinary identities added by invite; nothing reaches them without the user sending it (rules in `07`) |
| F-25 | Multi-device | Out of MVP; needs its own ADR (linked devices vs seed sharing) because it changes the threat model |

---

## Cross-cutting acceptance rules (apply to every feature)

1. Every security claim in the README links to at least one named test (`05` keeps the table).
2. Nothing in the UI, logs or notifications depends on which vault is open.
3. No feature adds a network request that carries identity, contact or content metadata in clear.
4. No third-party analytics, crash or ads SDK.
5. Tests for storage run against real SQLite (and SQLCipher on device), not only `memoryDriver`.

---

## Open questions for you

1. **Decoy starting state (F-03 AC 5):** both vaults start empty, or both start with generated per-install content? Empty is simpler and has fewer tells; generated looks "lived-in" sooner.
2. **PIN length (F-02):** fixed 6, a 6–10 digit range, or allow alphanumeric passphrases? The unlock UI must be identical for both vaults.
3. **Delivery receipts (F-10 AC 2):** default on or off?
4. **Recovery phrase (F-14 AC 2):** offer one at setup (safer, but a written phrase is itself a seizure risk), or backup file only?
5. **Anti-spam (F-12 AC 2):** proof-of-work (simple, costs battery) or anonymous tokens (better, needs an issuer)? This becomes an ADR.
6. **Wipe PIN (F-20):** acceptable as a P1 option, given that in some places destroying evidence is a separate offence?
