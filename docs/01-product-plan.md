# 01 — Product Plan

**Date:** 2026-11-02 · **Depends on:** [00-audit.md](00-audit.md) · **Status:** draft for approval

Tags follow the audit: **[implemented]**, **[partial]**, **[planned]**, **[unknown]**. Finding IDs (A-xx) refer to `00-audit.md`.

---

## 1. One-line positioning

> **Veil is a messenger for people whose phone may be taken from them.** It has no phone number, no account and no directory, and if someone forces you to unlock it, a second PIN opens an ordinary-looking app.

The core is **device-seizure and coercion resistance**, with zero-directory messaging as the base layer. Network anonymity is a secondary goal that Veil gets from optional transports (Tor, self-hosted relays), not from its own design.

---

## 2. Who Veil is for

### Primary: at-risk individuals in small, trusted circles (MVP target)

| Persona | Situation | What they need from Veil |
|---|---|---|
| **Field journalist / fixer** | Crosses checkpoints and borders; phone inspected or seized; talks to sources who must not be linked to them | Contacts not tied to phone numbers; a believable unlocked state under duress; disappearing messages for sources |
| **Activist / organiser** | Protest or campaign group of 5–20; device seizure at arrests is routine | Group-scale chat (P1), panic wipe, no server-side member list |
| **Human-rights lawyer / NGO caseworker** | Holds client communications; office or devices may be raided | Strong at-rest encryption, timed retention, self-hosted relay for the organisation |
| **Person in an abusive household** | Partner or family checks the phone | A decoy that passes casual inspection; no tell-tale app behaviour |

These users share four traits: they **know each other in person** (so invites can be exchanged out-of-band), their main adversary **has physical access to the device**, they are **few per group**, and they will **accept some friction** for safety.

### Secondary (post-MVP): privacy-conscious general users

People who want a no-phone-number messenger without being at risk. They raise usage numbers but pull the product toward features (large groups, multi-device, cloud backup) that conflict with the primary users' safety. Phase 2 serves them only where that costs the primary user nothing.

### Not for (stated in-app and on the store listing)

- People who need anonymity against a **global network observer**: use Tor-based tools (Briar, or SimpleX over Tor).
- People whose **device is already compromised** (spyware, rooted by an adversary).
- Anyone relying on Veil for life-critical safety **before the independent audit is published** (README warning stays).

---

## 3. Threat model (product level)

`05-security-and-auth.md` will turn this into adversary tiers mapped to controls and tests. Here it defines scope.

| Adversary | Capability | In scope? | Veil's answer | Current state |
|---|---|---|---|---|
| **A1 Casual inspector** (family, employer, police at a stop) | Holds unlocked or coerced-unlocked phone for minutes | **Yes, core** | Ghost PIN opens a believable decoy; no visible tells | [partial]: tells exist (A-05, A-06, A-07) |
| **A2 Forensic examiner** | Locked phone, lab tools, filesystem image, unlimited time | **Yes, core** | Argon2id + Keystore-held salt; SQLCipher; no PIN verifier; equal-size vaults | [partial]: SQLCipher unverified, salt fail-open (A-13) |
| **A3 Repeat forensic examiner** | Images device before *and* after coerced unlock | Partly | Honest disclosure; reduce write tells (both vaults touched on every unlock) | [planned] |
| **A4 Malicious or compelled relay operator** | Sees all relay traffic and RAM; can drop, delay, replay | **Yes** | E2EE; blinded rotating inboxes; no identity at relay | [partial]: identity and metadata leak (A-01, A-02) |
| **A5 Network observer** (ISP, state firewall) | Sees IPs, timing, sizes | Partly | TLS, fixed-size frames, optional Tor transport | [partial]: no TLS enforcement (A-16); no Tor |
| **A6 Malicious contact or invite holder** | Has your invite or once chatted with you | **Yes** | Authenticated handshake; key-change warnings; cannot block your inboxes | [partial]: A-03, A-09, A-11 |
| **A7 App-store or platform vendor** | Push timing, distribution control | Partly | Push off by default; F-Droid / sideload path | [planned] |
| **A8 Global passive adversary** | Correlates all traffic worldwide | **No** | Out of scope; stated plainly | — |
| **A9 Compromised OS / spyware** | Reads screen, keystrokes, memory | **No** | Out of scope; stated plainly | — |
| **A10 Rubber-hose escalation** (adversary knows Veil has a decoy) | Demands every PIN | **No, can only be mitigated** | Deniability is a delay, not a guarantee; copy says so | Disclosed in `db.ts` header and `SECURITY_LIMITATIONS.md` |

**Design consequence:** because A1 and A2 are the core, *anything that would be visible on the phone* (UI labels, file sizes, timestamps, notifications, app-switcher thumbnails, OS backups) matters as much as the cryptography.

---

## 4. Positioning against existing messengers

Competitor facts below reflect my knowledge as of mid-2026. They are **[unknown] until checked against each project's current docs**, which should happen before this goes into public material.

| | **Signal** | **Session** | **SimpleX Chat** | **Briar** | **Veil (target)** |
|---|---|---|---|---|---|
| Account identifier | Phone number (usernames can hide it) | Random account ID (public key) | **None**; per-contact queue addresses | Public key, added in person or via link | **None at the relay**; keypair shared only via invite |
| Server model | Central (Signal Foundation) | Decentralised node network, onion-routed | User-choosable SMP relays, self-hostable | **No servers**; P2P over Tor, Wi-Fi, Bluetooth | User-choosable blind relay, self-hostable |
| Forward secrecy | Yes (Double Ratchet, PQ extensions) | Historically **no**; check current status | Yes (Double Ratchet, PQ extension) | Yes | Yes (Double Ratchet) [implemented] |
| Metadata at server | Sealed sender; contact discovery via phone numbers | Onion routing hides IP from nodes | Per-contact queues; no user graph | None (no server) | Goal: blinded inboxes, encrypted headers. Today it leaks (A-01, A-02) |
| Device-seizure features | Screen lock, disappearing messages | Screen lock | **Hidden chat profiles with passwords; self-destruct passcode** | Account password; panic button via companion app | **Dual vault with a working decoy identity**; panic wipe; view-once in RAM |
| Platforms | All, multi-device | All | All | Android, desktop | Android first; iOS [unknown] |
| Maturity | Very high, audited | High | High, audited | High, audited | Prototype, unaudited |

### Where Veil actually differs

1. **A complete second identity, not a hidden profile.** SimpleX's hidden profiles and self-destruct passcode come closest. Veil's claim is narrower and stronger: a *coerced unlock looks like a normal, used, single-identity app*, with no "hidden profiles" setting for the coercer to ask about. Today, A-05, A-06 and A-07 break this claim; Phase 1 must fix them before the claim is made.
2. **Built around a seized phone.** Equal-size vaults, no PIN verifier, Keystore-bound salt, view-once in RAM only, and identical timing for both PINs. Others treat these as features; Veil treats them as the product.
3. **Zero directory.** This is the same idea SimpleX has, so it is *not* a differentiator on its own; it is the minimum bar.

### Where Veil should not compete

- **Network anonymity:** SimpleX-over-Tor and Briar are ahead. Veil adds an optional Tor transport (Phase 5) and points users to Briar for no-internet situations.
- **Scale and polish:** Signal wins. Veil should not chase large groups, stickers or multi-device for the MVP.

### Honest risk

If SimpleX ships a full decoy-profile feature, Veil's main differentiator narrows. **Mitigation:** win on *deniability done properly* (tested against an A1/A2 examiner protocol and published), plus a focus on one community.

---

## 5. MVP scope

**MVP definition:** two to ten people who met in person can message each other reliably for two weeks, through a relay on the public internet, with every security claim in the README backed by a test, and a coerced unlock that shows nothing unusual.

### In MVP (Phase 1 + Phase 2 P0)

| Capability | Today | Needed for MVP |
|---|---|---|
| 1:1 E2EE messaging, persistent / timed / view-once | [partial] | Fix delivery (A-08, A-15), lock teardown (A-10) |
| Authenticated first contact via invite (QR + link) | [partial] | X3DH-style handshake (A-03); QR scan; one-time invites |
| Safety-number verification + key-change warning | [partial] | Persist state, add UI (A-11) |
| Blind relay with no identity or metadata exposure | [partial] | A-01, A-02, A-09, A-14 |
| Dual vault with believable, per-install decoy | [partial] | A-05, A-06, A-07; attempt limiting identical for both vaults (A-12) |
| PIN unlock that cannot lock users out | **broken** | A-04 |
| Verified at-rest encryption | [unknown] | A-13 |
| Offline queue, retry, delivery state | [planned] | Phase 2 P0 |
| Encrypted backup / restore of seed and vault | [planned] | Phase 2 P0. Without it, a lost phone means a lost identity, and testers will churn |
| Self-hostable relay (Docker) | [planned] | Phase 2/5. Organisations will ask first |
| Android release build; iOS build | [unknown] | Android required; iOS strongly preferred for testers |

### P1 after MVP

Small groups (≤20, pairwise fan-out), image and file attachments, content-free wake-up notifications (UnifiedPush first), panic wipe UI.

---

## 6. Non-goals

These are explicit so that scope pressure has an answer.

1. **Anonymity against a global passive adversary.** No mixnet; optional Tor only.
2. **Large groups or channels** (>20 members) and broadcast.
3. **Multi-device sync** in MVP. One device, one identity; backup handles moving phones.
4. **Server-side anything about users:** accounts, contact discovery, profiles, read receipts stored on the server, analytics, crash SDKs.
5. **Cloud backup by default.**
6. **Voice and video calls** (MVP).
7. **Web as a production client.** The web build is a dev preview only (`memoryDriver` has no security properties).
8. **Cryptocurrency, tokens or payments** inside the app.
9. **AI features that see plaintext by default** (see `07-agents-and-mcp.md`).
10. **Defeating a compromised OS** or an adversary who knows and demands every PIN.

---

## 7. Success metrics

No analytics are shipped, so every metric is either computed on the relay (aggregate counts, never per-inbox) or reported by testers by hand.

### Phase 1 exit (engineering)

| Metric | Target | Source |
|---|---|---|
| Audit Critical and High findings closed | 15/15 (A-01…A-15) | `00-audit.md` tracker |
| README claims backed by a named test | 100% | Claim → test table in `05` |
| CI green on every push | 100% | GitHub Actions |
| Cold unlock time on a low-end Android phone | ≤ 3 s, both PINs within ±5% | Benchmark on device |
| Messages delivered after recipient was offline 24 h | 100% in soak test | Localhost + public relay soak |

### Phase 2 exit (closed tester group, 5–10 people, 2 weeks)

| Metric | Target | Source |
|---|---|---|
| Messages lost (sender sent, recipient never got) | 0 | Tester reports + paired test script |
| Unexplained crashes | 0 open at exit | Tester-shared local logs |
| Testers still using it at day 14 | ≥ 70% | Hand count |
| Pairing success without help | ≥ 90% of attempts | Observation |
| Coerced-unlock drill: examiner identifies decoy | ≤ 1 in 5 examiners, using a written protocol | Red-team session |

### Phase 6 (product)

- 100+ weekly active users on self-chosen relays, estimated from aggregate relay connection counts.
- At least one organisation running its own relay.
- Independent audit published with findings.
- Answer published to "How does Veil sustain itself without user data?"

---

## 8. Business model options

The constraint: **no revenue that requires knowing who users are, what they say, or who they talk to.** That rules out ads, data sales, and "free tier, pay with metadata".

| Option | How it works | Fit | Risks |
|---|---|---|---|
| **1. Managed relays for organisations** | NGOs, newsrooms and law firms pay for a hosted, monitored relay in a region they choose; uptime SLA; no admin access to content | **Strong**: matches the self-hosted relay design | Paying-customer records identify organisations. Keep billing separate from relay infrastructure and minimal |
| **2. Enterprise / NGO deployment kit** | Paid support, deployment help, staff training, policy layer (e.g. enforced retention defaults) with no admin backdoor | Strong, later | Pressure to add "compliance" features that break E2EE. Write a refusal policy |
| **3. Security audits and assessments as a service** | Sell threat-model workshops, device-seizure training and red-team drills to at-risk organisations | Medium: uses domain expertise; funds the core | Time competes with product work |
| **4. Grants** | Open Technology Fund, NLnet / NGI, Ford, Mozilla, regional digital-rights funds | **Strong for years 0–2**; these funders back exactly this category | Grant cycles are slow; some funders have political exposure in certain countries |
| **5. Donations** | Open Collective / GitHub Sponsors / direct | Weak alone, good supplement | Small and unpredictable |
| **6. Paid convenience features** | Optional paid relay capacity (attachment storage TTL, more queue depth) | Medium | Payment itself identifies; would need anonymous tokens (e.g. Privacy Pass-style) |

**Starting recommendation:** grants (option 4) plus a pilot of managed relays (option 1) with two or three friendly organisations in Phase 6. Revisit after the audit.

**Licence matters here:** AGPL protects the relay from closed forks but may deter some organisations; Apache/MPL is friendlier to enterprise. That decision belongs in an ADR before Phase 6 (open question 7 in `00-audit.md`).

---

## 9. Beyond India

The threat model changes by market. Each target country needs a short regional note **before** any outreach there. A template follows; content needs local legal review, so none of it is filled in here.

| Topic | Question to answer per market |
|---|---|
| Network blocking | Is WebSocket/TLS to unknown hosts blocked or throttled? Is Tor blocked? Do we need domain fronting or bridges? |
| Device-seizure law | Can authorities compel PIN disclosure? Is lying about a second PIN a separate offence? (This directly affects whether the decoy helps or harms the user.) |
| Encryption law | Licensing, registration or lawful-access obligations on developers or relay operators? |
| App distribution | Is Play Store / App Store reliable? Is F-Droid or a sideloaded APK the realistic channel? |
| Relay hosting | Where can a relay be hosted without local data-retention mandates? |
| Language and copy | Which languages first; are security prompts understood as intended? |

**Initial candidates**, to validate with partners rather than assume: India (home market, Hindi + English), then one or two markets chosen by where the first partner organisation works.

**Important:** in some jurisdictions a discovered decoy could make things *worse* for the user. The in-app explanation of the Ghost PIN must say so, and regional notes must flag it.

---

## 10. Decisions this document proposes

Each becomes an ADR in `docs/adr/` once you approve it.

| # | Decision | Proposal |
|---|---|---|
| P-1 | Primary user | At-risk individuals in small trusted circles; general privacy users second |
| P-2 | Core differentiator | Coercion and seizure resistance (dual vault done properly), not network anonymity |
| P-3 | MVP size | 1:1 only, up to about 10 testers, Android required, iOS preferred |
| P-4 | Backup in MVP | Yes: passphrase-encrypted seed + vault export (identity loss would otherwise kill retention) |
| P-5 | Telemetry | None. Relay aggregate counts only; tester reports by hand |
| P-6 | Business model | Grants + managed organisational relays; no user-identifying revenue |
| P-7 | Web client | Dev preview only, never marketed |

---

## 11. Open questions for you

1. **Primary community:** which real group will the first 5–10 testers come from? Journalists, student organisers, NGO staff, someone else? Copy, language and the decoy content all depend on it.
2. **iOS in MVP?** It roughly doubles device testing and needs a Mac and an Apple developer account. Is that available to you?
3. **Decoy honesty in setup copy:** do you accept stating in-app that a discovered decoy can make things worse in some places (§9)?
4. **Backup in MVP (P-4):** agree it is P0, or ship without it and accept "lose phone = lose identity" for the tester phase?
5. **Funding route:** are you open to applying for grants (OTF, NLnet), which require public, open-source work and reporting?
6. **Solo or team:** is this staying one part-time developer through Phase 2? Estimates in `09-roadmap.md` will assume yes unless you say otherwise.
