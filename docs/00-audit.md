# 00 — Code vs README Audit (Phase 0, Step 0)

**Date:** 2026-11-02 · **Commit audited:** `2fa1e3e` (main, 12 commits) · **Scope:** `README.md`, `docs/*`, `client/`, `server/`, `tests/`

Status tags: **[implemented]** works as described · **[partial]** exists but incomplete or diverges from the claim · **[planned]** claimed or implied, no code · **[unknown]** cannot be confirmed without a device or build

Severity scale: **Critical** breaks a headline security or deniability promise, or locks users out · **High** real attack or data loss under normal use · **Medium** weakens defence in depth or correctness · **Low** hygiene

---

## 1. Summary

The cryptographic building blocks are sound and well-tested in isolation: key derivation, AEAD, the Double Ratchet state machine (including the commit-only-on-auth fix), invite signing, and the relay's challenge-response all behave as their unit tests say. **53/53 tests pass and both packages typecheck clean** (verified locally on this commit).

How those pieces are put together does not yet deliver what the README promises:

1. **The relay is not blind.** Each SUB sends the user's long-term Ed25519 identity key, and each envelope carries sender and recipient fingerprints, message ID, retention mode and exact payload length in cleartext JSON. Inbox rotation hides nothing from the relay. (A-01, A-02)
2. **First contact is unauthenticated.** Anyone holding an invite can open a session and claim to be any existing contact. (A-03)
3. **The decoy shows itself.** The thread list labels the decoy vault `GHOST`, the unlock screen advertises that a Ghost PIN exists, and every install seeds the same four decoy contacts, whose fingerprints are visibly shorter than real ones. (A-05, A-06, A-07)
4. **Users can lock themselves out.** Setup accepts 6–8 digit PINs, but the unlock screen only accepts exactly 6. (A-04)
5. **The production messaging pipeline has no tests.** `MessageService`, `RatchetManager`, `RelayClient` and `ContactManager.createFromInvite` are never run by the suite. The e2e test builds frames by hand, and storage tests run against a regex-based in-memory mock, not SQLite or SQLCipher. (§5)
6. **Offline delivery breaks after about one hour.** Senders target the current hour's inbox. Receivers only subscribe to ±1 hour around *now*, and only when they unlock. Mail queued under older inbox IDs is never claimed. (A-08)

None of these is a flaw in a primitive; all of them are fixable in Phase 1. The README overstates the current state, though, and must be reconciled (§3) before anyone relies on it.

---

## 2. Component status

| Area | Status | Notes / files |
|---|---|---|
| Master seed, mask derivation (BLAKE2b keyed KDF → Ed25519/X25519) | [implemented] | `client/src/crypto/keys.ts` |
| Fingerprint (BLAKE2b-160 over signPk‖dhPk, Crockford) | [implemented] | 32 chars / 8 groups — **not** "five groups of 4" as `docs/PROTOCOL.md` says |
| XChaCha20-Poly1305 AEAD, pack/unpack | [implemented] | `keys.ts` |
| Signed expiring invites | [partial] | Signed and expiring, but **not one-time**: nothing records consumption. The `rz` rendezvous token and `rendezvousInbox` are computed and never used (`keys.ts:626`) |
| First-contact handshake | [partial] | Unauthenticated ephemeral-static X25519 only (`protocol/ratchet/initialize.ts:52`); no X3DH and no initiator authentication |
| Double Ratchet (DH + symmetric, skipped keys, replay rejection, clone-then-commit) | [implemented] | `client/src/protocol/ratchet/*`. Header `pn` is not in the AAD (harmless today because of clone-then-commit) |
| Ratchet persistence (field-level AEAD) | [implemented] | `storage/db.ts` `saveRatchet`/`loadRatchet` |
| Blinded inbox IDs | [partial] | Keyed on the recipient's **static** mask `dhPk` (`messaging/MessageService.ts:97,151`), not the "receiving ratchet key" the README claims |
| Epoch roll / resubscription | [planned] | `refreshSubscriptions` runs only on `setActiveMask` (unlock) |
| Fixed 4096-byte envelopes | [partial] | Outer size is fixed, but the contents are cleartext JSON plus a cleartext length prefix (A-02). Max plaintext is about 2.7 KB, and larger sends throw |
| Cover traffic | [partial] | A fixed-interval 45 s `NOOP` of about 12 bytes vs about 5.5 KB for `SEND`, so the two are trivially told apart on the wire (`transport/RelayClient.ts:320`) |
| Relay: challenge nonce, Ed25519 SUB auth, first-claim, ACK-delete, RAM-only, no IP logging | [implemented] | `server/src/relay.ts` |
| Relay: multi-node Redis bus | [partial] | `RedisRelayBus` exists, but `initBus()` is never called. `startRelayServer` builds the bus without subscribing or connecting, so Redis mode silently drops fan-out (`relay.ts:178,435`) |
| Relay: `DROPPED` on full queue | [partial] | Client handles it, but the server never sends it; it silently evicts the oldest (`relay.ts:228`) |
| Delivery acks / retry / offline outbox | [planned] | "Delivered" means "relay accepted". Failed sends are not retried. The client ACKs before decoding or persisting (`RelayClient.ts:225`) |
| Dual vault: two files, Argon2id per partition, canary, both keys always derived | [implemented] | `storage/db.ts` |
| Decoy uses independent entropy | [implemented] | `ProvisionScreen` generates a separate `ghostSeed`. The README says both masks derive from one seed — **the README is wrong, the code is better** |
| Decoy content | [partial] | Static and identical on every install, internally inconsistent (A-07) |
| Page ballast | [partial] | Provisioning only; no rebalancing during use (THREAT_MODEL.md claims "routine use") |
| SQLCipher at-rest encryption | [unknown] | `PRAGMA key` is issued, but errors are swallowed and nothing checks `cipher_version`. A stock SQLite build accepts `PRAGMA key` as a no-op and writes plaintext metadata. `openDatabaseSync(name,{useSQLCipher:true})` is not a real runtime option (`sqliteDriver.ts:29`). No `client/android/` is committed, so the build cannot be checked |
| Device salt in Keychain/Keystore | [partial] | Falls back to a **RAM-only** salt if SecureStore throws (`keychain.ts:42,51`), so the vault becomes unopenable after restart |
| PIN attempt limiting | [planned] | None. No delay, no counter, no lockout |
| Retention: persistent / timed / view-once (RAM) | [implemented] | Timed `expires_at` is set at insert, then reset on render-as-read. Inbound timed messages can expire unread |
| FLAG_SECURE / screenshot listener / watermark | [implemented] | `App.tsx`, `components/DynamicWatermark.tsx`. Not verified on device: [unknown] |
| Background auto-lock | [partial] | Locks the vault and wipes the mask in place, but does not purge `ratchetManager` or `messageService` subscriptions (A-10) |
| Panic wipe | [partial] | `db.ts panicWipe` exists, with no UI entry point; it re-seeds the same static decoy |
| QR invite display | [partial] | Renders light-on-transparent (inverted, so many scanners fail). `toqr` is used but missing from `client/package.json` |
| QR scanning / NFC / deep links | [planned] | Import is paste-only. The Paste button and "Copy link" only work on web; native shows "TOKEN COPIED ✓" without copying |
| Safety-number verification UI, CHANGED_IDENTITY alert | [partial] | State exists in `ContactManager` but is never persisted or reachable (A-11) |
| Groups, attachments, push, multi-device, backup/restore, search, i18n | [planned] | No code |
| CI, lint, dependency audit | [planned] | No `.github/`, no ESLint config |
| Dockerfile | [planned] | `server/Dockerfile` is **0 bytes** |
| License | [unknown] | Only `client/LICENSE` exists, and it is Expo's template MIT (© 650 Industries). The project has no licence of its own |
| iOS build | [unknown] | Not attempted; README covers Android only |
| Argon2id cost on Hermes | [unknown] | Node: about 0.7 s per derivation, so about 1.4 s per unlock (measured in tests). Hermes has no JIT and runs pure-JS Argon2id synchronously on the JS thread, so expect several times slower plus UI freeze |

---

## 3. README and docs claims reconciliation

| Claim (source) | Reality |
|---|---|
| "The relay node never receives public keys, identities…" (README) | False. SUB carries `signPk` = the invite's `ik` (`keys.ts:515`); envelopes carry `senderFp`/`recipientFp` (A-01, A-02) |
| Inbox = BLAKE2b keyed by `receivingRatchetPk` (README) | Keyed by the static mask `dhPk` |
| "Invitations are signed, one-time" (README) | Signed, expiring, **reusable** |
| Ghost = `m/veil/mask/1` from the same master seed (README diagram) | Ghost uses an independent seed. Docs should be updated, not the code |
| "Cover traffic" pillar; "NOOP … to disguise active send/receive bursts" (THREAT_MODEL.md) | Fixed-timer tiny frame; does not disguise anything |
| "Ballast … during provisioning and routine use" (THREAT_MODEL.md) | Provisioning only |
| Cert pinning, TLS 1.3, native Argon2id, `RedisRelayBus` in production (TESTING.md §5) | None implemented; the Redis bus is not wired up |
| "Veil NEVER includes … in push notifications" (SECURITY_LIMITATIONS.md §6) | There is no push at all |
| Relay claim key "is itself an ephemeral per-inbox subkey" (`relay.ts` header comment) | It is the long-term identity key |
| `docs/ARCHITECTURE.md` lists ratchet, padding, transport and screens as "0-byte stubs" | Stale. Those files now exist |
| `docs/TESTING.md` totals "50 tests" and links `file:///c:/Users/Aryan/...` | 53 tests; links point to a local machine path |
| Badge "Expo 52" (README) | `expo ~57.0.20` |
| `adb … com.veil.client/.MainActivity` (README) | `app.json` package is `com.anonymous.client`; `client/android/` not in repo |
| README layout shows `server/relay/`, `server/transport/` | Only `server/src/relay.ts` and `bus.ts` exist |
| e2e criterion 20: "No plaintext message **or long-term identity** reaches the server" | The test only checks plaintext, and would fail on identity |
| `db.ts:133` "PRAGMA key and cipher_* pragmas are completely removed" | They are issued at `db.ts:270` |
| `security@veil.network` | [unknown] Domain ownership not established |

---

## 4. Findings

### Critical

**A-01 · The relay links every rotating inbox to the user's long-term identity.**
`RelayClient.resubscribeAll`/`subscribe` sign SUB with `mask.signSk` and send `pk = mask.signPk` (`keys.ts:515`). That key is the `ik` in every invite the user has ever shared. The relay, or anyone holding a relay log plus one invite, can join every hourly inbox to one identity, so rotation provides no unlinkability against the relay.
*Fix direction:* per-inbox auth keys derived from the ratchet or epoch (e.g. `deriveSubSeed(chainSecret, "veil.inbox.auth|epoch")`), never the identity key.

**A-02 · Envelope metadata is in cleartext inside the "opaque" 4096-byte blob.**
`EnvelopeCodec.encode` JSON-serialises the whole ratchet header (`EnvelopeCodec.ts:79`): `dhPk`, `pn`, `n`, `retention`, `ttlMs`, `msgId`, `senderFp`, `recipientFp`. It then pads with a cleartext 2-byte length (`padding.ts:37`). The relay can read who-to-whom by fingerprint, message counters, retention choice and exact ciphertext length. Padding only hides size from a TLS network observer, not from the relay.
*Fix direction:* header encryption (Signal's header-key variant, or seal the header under a key derived from the inbox secret); drop `senderFp`/`recipientFp` from the wire; pad *inside* the AEAD.

**A-03 · First contact is unauthenticated, so impersonation is possible.**
Alice's session is `X25519(ephemeral, Bob.dhPk)` only (`initialize.ts:52`). Nothing proves Alice's identity. On receive, `MessageService.handleInboundEnvelope` trusts the cleartext, attacker-supplied `header.senderFp` to pick the contact. If that contact's thread has no ratchet yet (e.g. Bob imported Carol's invite but hasn't messaged), `RatchetManager.decrypt` calls `initIncomingSession` with the attacker's key, and the attacker's messages appear in Carol's thread. Unknown senders get an auto-created contact with `signPk = dhPk = ephemeral` (`MessageService.ts:216`), so the inviter can never verify the initiator's real fingerprint.
*Fix direction:* X3DH-style handshake (static-static + ephemeral DH, initiator identity sealed and signed in the first message), using a one-time prekey carried in the invite (`rz`), and binding the session to the verified contact.

**A-04 · PINs longer than 6 digits lock users out permanently.**
`ProvisionScreen` accepts 6–8 digits (`maxLength={8}`, lines 190/230). `UnlockScreen` auto-submits at exactly 6 (`UnlockScreen.tsx:111`) and caps input at 6 (`:245`). Any 7–8 digit PIN can never be entered again, and there is no recovery.

**A-05 · The decoy vault labels itself `GHOST`.**
`ThreadListScreen.tsx:171` renders `maskLabel = index === 0 ? 'PERSONAL' : 'GHOST'`. That breaks the file's own rule (`db.ts` header, rule 5: nothing in the UI may branch on the partition). A coerced unlock shows the attacker the word GHOST.

**A-06 · The unlock and setup screens advertise the duress feature.**
`UnlockScreen.tsx:232`: "Independent Master & Ghost PINs unlock separate partitions…". Anyone holding the phone learns a second PIN exists. Provisioning copy ("GHOST DECOY PARTITION", "DURESS SAFE", "GHOST RECOVERY PIN") is acceptable during setup but must never appear post-setup.

**A-07 · Decoy content is identical on every install and internally inconsistent.**
`seedDecoy` (`db.ts:895`) always inserts the same four contacts (Dana R., Marco, Cycling Group, Aunt Lily) with the same messages. Once the source is public, that content *identifies* a decoy. Their fingerprints are 20 characters (`db.ts:900`), real ones are 32. They do not match the random keys stored with them, and those contacts can never reply. The primary vault, by contrast, starts empty.

### High

**A-08 · Messages are lost if the recipient is offline for more than about one hour.**
The sender targets `blindedInboxId(contact.dhPk)` for the current hour (`MessageService.ts:151`). The receiver subscribes to `[h-1, h, h+1]` computed at unlock and never refreshes. The relay holds mail 24 h under the *old* inbox ID, but the client never asks for it.
*Fix direction:* an overlap and catch-up window bounded by relay TTL (subscribe to the last N epochs on connect), plus an hourly resubscribe timer.

**A-09 · Inbox pre-claim lets anyone holding an invite block a user.**
Inbox IDs depend only on the static `dhPk` and the hour, so anyone with the invite can compute all future inbox IDs and SUB them first with any key. The rightful owner then gets `DENIED` (ignored silently by the client), and the squatter receives the victim's envelopes along with the cleartext metadata from A-02.

**A-10 · Lock and background do not fully tear down session state.**
`App.tsx:87–90` and `ThreadListScreen.handleLock` close the vault and zero the mask's key bytes *in place*, but:
- `ratchetManager.activeRatchets` keeps every loaded ratchet's keys in RAM across lock and across a primary→decoy switch.
- `messageService.activeMask` and relay subscriptions stay live, so the client keeps receiving and ACKing while locked. Messages go to `RamVault` (lost on exit) and ratchets advance without persisting.
- After reconnecting, SUB is signed with a zeroed key and is denied.
- `lockVault()` is not awaited.
- On iOS, `inactive` fires for Control Centre and system prompts, and Android may background on the Share sheet [unknown]. The app would then lock mid-invite.

**A-11 · Identity-change detection is unreachable.**
`ContactManager.saveContact` only detects a key change when `input.id` is passed, and `createFromInvite` never passes one (`ContactManager.ts:70`). `recordToContact` maps every row back to VERIFIED or UNVERIFIED (`:167`), so `CHANGED_IDENTITY` is never persisted. Adversarial test 9 passes only because it hard-codes `id: 'ct_bob'`. There is also no safety-number verification screen.

**A-12 · No PIN attempt limiting.**
Unlimited online guesses. A 6-digit PIN space is 10⁶ attempts × 2 Argon2id each. Any limiter must behave identically for both vaults and must not reveal which one exists.

**A-13 · At-rest encryption is unverified and fails open.**
- SQLCipher activation is never checked. On stock SQLite, `PRAGMA key` succeeds as a no-op, leaving plaintext table names (`ballast`!), timestamps, direction, retention, counters, `verified_at` and thread structure on disk. Field-level AEAD still protects bodies, keys and contact fields.
- If SecureStore fails, the device salt silently lives only in RAM, and the vaults become unrecoverable after restart.
- The same raw key is used for SQLCipher *and* XChaCha field encryption. Derive separate subkeys.

**A-14 · Relay abuse and resource exhaustion.**
- No proof of work or token on SEND or SUB.
- Rate limits are per connection only, with unlimited connections.
- `claims` grows without bound, and SUB has no inbox-format check.
- The worst-case queue memory is `200 000 inboxes × 256 × ~5.5 KB ≈ 280 GB`, with no global cap.
- The full-queue path silently evicts the oldest envelope instead of sending `DROPPED`.

**A-15 · Delivery is not reliable.**
- The client ACKs (which deletes the relay copy) before it decodes, decrypts or persists. A crash or a thrown insert loses the message.
- The ratchet is persisted before `insertMessage`, and not atomically with it.
- The inbound message ID comes from the attacker-controlled `header.msgId`, and it collides with plain `INSERT` (`db.ts:1152`), so the insert throws and the message is lost.
- Sends over the plaintext limit throw *after* local insert; `ChatScreen.handleSend` then inserts a second local copy that is never sent.
- Relay errors are swallowed, with no retry or outbox.

### Medium

- **A-16** The default relay URL is `ws://127.0.0.1:8443` and there is no `wss://` enforcement or pinning (`RelayClient.ts`).
- **A-17** The Redis bus is never initialised (`relay.ts:178` `initBus` unused). Multi-node mode is broken, and silently so.
- **A-18** Ratchet hygiene:
  - Header `pn` is not authenticated.
  - Failed-decrypt working state is not wiped.
  - Replaced skipped-key buffers are not wiped on commit.
  - Skipped keys have no time-based expiry.
  - `dhRatchet` in `keys.ts` duplicates `protocol/ratchet/dhRatchet.ts` (two sources of truth).
  - Root key is used as the BLAKE2b *message*, not the key. That is acceptable for a PRF, but should be specified.
- **A-19** Secrets lingering in JS memory: `ProvisionScreen` keeps both seeds and masks alive in `useMemo`, and seeds returned by `loadSealedMasterSeed` are never wiped.
- **A-20** Message-body AAD is `msg|id` with no thread binding, so rows can be swapped between threads by anyone with write access to the DB.
- **A-21** The e2e test and docs reference a "20-criteria" acceptance list from a "Master Prompt" that is not in the repo.
- **A-22** `client/package-lock.json` includes `toqr` but `client/package.json` does not, so `npm ci` can fail.
- **A-23** Timed messages: `expires_at` is set at insert for inbound messages, so TTL can lapse unread. That contradicts "armed on read".

### Low

- **A-24** IDs use `Math.random` (contacts, messages). That is not a secret today, but it should use the CSPRNG.
- **A-25** `index.ts` and `index.js` are both entry points; only `index.js` imports the RNG polyfill.
- **A-26** `client/.claude/settings.json` and `client/AGENTS.md` are tooling files committed into the app folder.
- **A-27** Two TypeScript majors (root `^7`, client `~6`, server `^5`) and two libsodium versions. Pin and align them.
- **A-28** `server/Dockerfile` is empty.

---

## 5. What the tests really cover

| Suite | Count | What it really exercises | Gaps |
|---|---|---|---|
| `crypto.test.ts` | 17 | Primitives, invites, inbox ID, padding | No known-answer test vectors; property/fuzz testing absent |
| `ratchet.test.ts` | 8 | State machine directly | Not through `RatchetManager` |
| `storage.test.ts` | 9 | `db.ts` over **`memoryDriver`**, a regex-matching Map that ignores DDL, constraints, transactions and pragmas | No real SQLite, no SQLCipher, no CHECK-constraint test, no padToward size check |
| `relay.test.ts` | 8 | Real relay on localhost via raw `ws` | Memory bus only; no reconnect, duplicate or order tests; the BAD_ENVELOPE name in the test title doesn't match `ENVELOPE_SIZE` |
| `adversarial.test.ts` | 10 | Tamper/replay at primitive level, relay auth | Test 9 only passes because of a hard-coded ID (A-11) |
| `e2e.test.ts` | 1 | Hand-built frames and direct ratchet calls against the real relay | **Never runs `MessageService`, `RelayClient`, `RatchetManager`, `EnvelopeCodec.decode` in the inbound path, or `ContactManager.createFromInvite`**. No UI. Criterion 20 only checks plaintext |

All 53 pass; `npm run typecheck` is clean for client and server. No coverage tool is configured. Nothing runs on a device or in a React Native runtime.

---

## 6. Answers to the continuation plan's open questions

1. **Specs in repo?** Partly. `docs/PROTOCOL.md`, `THREAT_MODEL.md`, `SECURITY_LIMITATIONS.md`, `TESTING.md` and `ARCHITECTURE.md` exist but have drifted from the code (§3). Treat them as drafts and supersede them with `docs/04` and `docs/05`.
2. **First-contact handshake:** undefined in spec; in code, an unauthenticated ephemeral-static DH (A-03).
3. **Inbox rotation vs offline:** broken beyond about 1 h (A-08), and keyed on the static key rather than the ratchet key.
4. **Cover traffic:** exists only as a fixed 45 s tiny NOOP, so it is ineffective.
5. **Ghost seed independence:** **already independent** in code (`ProvisionScreen` → separate `ghostSeed`). Only the README is wrong. The real deniability problems are A-05, A-06 and A-07.
6. **PIN strength and limiting:** 6 digits effective, no limiting (A-04, A-12).
7. **Daily-use features:** none of groups, attachments, push, multi-device, backup, QR scan or deep links exist.
8. **Smaller checks:**
   - Watermarking does exist (`DynamicWatermark.tsx`).
   - The security contact domain is unverified.
   - Build steps cover Android only, the Android project is not committed, and the package name is `com.anonymous.client`.
   - Argon2id on Hermes is unmeasured.
   - There is no CI.
   - The commit count is 12, not 5.

---

## 7. Recommended Phase 1 order (input to `09-roadmap.md`)

1. Fix the lockout and deniability tells: A-04, A-05, A-06 (small, high impact).
2. Fix identity leaks to the relay: A-01, A-02.
3. Authenticate first contact: A-03, A-11.
4. Fix inbox lifecycle and delivery: A-08, A-09, A-15, A-10.
5. Real-storage tests on device, SQLCipher verification, salt fail-closed: A-13.
6. Decoy generator, attempt limiting: A-07, A-12.
7. Relay hardening and CI: A-14, A-16, A-17, A-22.
8. Rewrite the e2e test to drive `MessageService` + `RelayClient` end to end.

---

## 8. Open questions for you

1. **Header encryption approach (A-02):** Signal's header-encryption variant, or seal the header under a per-inbox key? This changes the wire format, so it needs an ADR.
2. **Inbox addressing:** keep a per-contact inbox derived from a shared session secret (unlinkable across contacts; needs one SUB per contact), or one inbox per user with header encryption (fewer SUBs; the relay sees fan-in)?
3. **Ghost PIN copy:** should setup still explain the feature openly (and accept that the app's existence implies it), or hide it behind an "advanced" step?
4. **Should the decoy start empty and grow organically** (fewer tells, less "lived-in"), or use a seeded per-install generator?
5. **PIN policy:** allow longer PINs or passphrases, given that unlock UX must be identical for both vaults?
6. **Is the web build worth keeping** given `memoryDriver` has no security properties, or should it become a storybook-only target?
7. **Licence:** which open-source licence (AGPL, GPL, MPL, Apache)? It affects business options in `01-product-plan.md`.
8. **Do you own `veil.network`?**
