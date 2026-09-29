# VEIL — PROTOCOL SPECIFICATION

**Document Version:** 1.0.0  
**Status:** Protocol Specification  
**Classification:** Cryptographic & Wire Protocol Standard

---

## 1. Cryptographic Primitives & Parameters

Veil relies on audited, high-assurance cryptographic primitives:

| Category | Primitive | Specification | Implementation |
|---|---|---|---|
| **Identity & Signatures** | Ed25519 | RFC 8032 (Ed25519 pure) | `@noble/curves/ed25519` |
| **Key Agreement** | X25519 | RFC 7748 (Curve25519 ECDH) | `@noble/curves/ed25519` (`x25519`) |
| **Payload AEAD** | XChaCha20-Poly1305 | 24-byte random nonce, 32-byte key, 16-byte Poly1305 tag | `@noble/ciphers/chacha` |
| **KDF & Digest** | BLAKE2b | Keyed BLAKE2b (variable digest length, 0–64 bytes) | `@noble/hashes/blake2` |
| **Password Stretching** | Argon2id | RFC 9106 (`t=3, m=64MB, p=1, dkLen=32`) | `@noble/hashes/argon2` |

---

## 2. Domain Separation & Derivation Keys

Every KDF execution in Veil uses explicit domain separation through distinct UTF-8 string labels passed as message or key inputs to BLAKE2b:

```
LBL.identity    = "ed25519.identity"
LBL.exchange    = "x25519.exchange"
LBL.fingerprint = "veil.fingerprint.v1"
LBL.vaultSalt   = "veil.vault.salt.v1"
LBL.inbox       = "veil.inbox.blind.v1"
LBL.chainStep   = "veil.ratchet.chain.v1"
LBL.msgKey      = "veil.ratchet.msgkey.v1"
LBL.watermark   = "veil.watermark.v1"
LBL.inviteSig   = "veil.invite.sig.v1"
```

### 2.1 Deterministic Mask Derivation
A user identity is represented by a single 32-byte master seed:
$$S_{master} \leftarrow \text{CSPRNG}(32)$$

Personas ("Masks") are derived by hierarchical index $i \ge 0$:
1. $Branch = \text{BLAKE2b}(msg = \text{"m/veil/mask/"} \parallel i, key = S_{master}, dkLen = 32)$
2. $Seed_{ed} = \text{BLAKE2b}(msg = \text{"ed25519.identity"}, key = Branch, dkLen = 32)$
3. $Seed_{x} = \text{BLAKE2b}(msg = \text{"x25519.exchange"}, key = Branch, dkLen = 32)$
4. $(IK_{pub}, IK_{priv}) \leftarrow \text{Ed25519.Keygen}(Seed_{ed})$
5. $(DH_{pub}, DH_{priv}) \leftarrow \text{X25519.Keygen}(Seed_{x})$
6. Intermediate seeds ($Branch, Seed_{ed}, Seed_{x}$) are zeroized immediately.

**Fingerprint**:
$$\text{Digest} = \text{BLAKE2b}(msg = IK_{pub} \parallel DH_{pub}, key = \text{"veil.fingerprint.v1"}, dkLen = 20)$$
Rendered as Crockford Base32 in five groups of 4 characters (e.g. `K7QP 4M2X 9WVE 3TNA 6HJD`).

---

## 3. Invitations & First-Contact Pairing

Invitations follow the canonical URI format:
```
veil://invite?v=1&ik=<b64u>&xk=<b64u>&rz=<b64u>&exp=<unix_sec>&sig=<b64u>[&nick=<str>]
```

1. **Parameters**:
   - `v`: Protocol version (`1`).
   - `ik`: Sender's Ed25519 identity public key ($IK_{pub}$, 32 bytes).
   - `xk`: Sender's X25519 exchange public key ($DH_{pub}$, 32 bytes).
   - `rz`: One-time 16-byte random rendezvous token.
   - `exp`: Unix timestamp (in seconds) after which the invite is invalid.
   - `nick`: Optional locally specified alias.
2. **Canonical Signing Preimage**:
   $$\text{Preimage} = \text{"veil.invite.sig.v1|" } \parallel \text{"v=1&ik="} \parallel ik \parallel \text{"&xk="} \parallel xk \parallel \text{"&rz="} \parallel rz \parallel \text{"&exp="} \parallel exp \parallel \text{"&nick="} \parallel nick$$
3. **Signature**:
   $$\sigma = \text{Ed25519.Sign}(Preimage, IK_{priv})$$
4. **Rendezvous Inbox**:
   $$Inbox_{rz} = \text{toB64}(\text{BLAKE2b}(msg = rz, key = \text{"veil.inbox.blind.v1"}, dkLen = 32))$$

---

## 4. Double Ratchet Protocol

Veil implements a full Double Ratchet combining a Diffie-Hellman ratchet and two symmetric key chains (sending and receiving).

### 4.1 Symmetric Chain Advancement
Given a symmetric chain key $CK$:
1. $CK_{next} = \text{BLAKE2b}(msg = \text{"veil.ratchet.chain.v1"}, key = CK, dkLen = 32)$
2. $MK = \text{BLAKE2b}(msg = \text{"veil.ratchet.msgkey.v1"}, key = CK, dkLen = 32)$
3. Replace $CK \leftarrow CK_{next}$.
4. $MK$ encrypts or decrypts a single message and is zeroized immediately.

### 4.2 DH Ratchet Step
When receiving a message containing a new remote DH public key $DH_{remote}$:
1. Shared secret: $SS_{recv} = \text{X25519}(DH_{local.priv}, DH_{remote})$
2. Mixed: $Root_{next} \parallel CK_{recv} = \text{BLAKE2b}(msg = Root_{current} \parallel SS_{recv}, key = \text{"x25519.exchange"}, dkLen = 64)$
3. Generate new local ephemeral keypair: $(DH'_{local.pub}, DH'_{local.priv}) \leftarrow \text{X25519.Keygen}()$
4. Shared secret: $SS_{send} = \text{X25519}(DH'_{local.priv}, DH_{remote})$
5. Mixed: $Root'_{next} \parallel CK_{send} = \text{BLAKE2b}(msg = Root_{next} \parallel SS_{send}, key = \text{"x25519.exchange"}, dkLen = 64)$
6. Zeroize $SS_{recv}$ and $SS_{send}$.

### 4.3 Authenticated Associated Data (AAD) Construction
Every encrypted message binds the cryptographic context into the AEAD AAD:
$$\text{AAD} = \text{utf8}(\text{"veil.msg.v1|" } \parallel \text{ThreadId} \parallel \text{"|" } \parallel \text{Counter} \parallel \text{"|" } \parallel \text{RetentionMode} \parallel \text{"|" } \parallel \text{SenderFp} \parallel \text{"|" } \parallel \text{MessageId})$$

Any modification of the message ID, sequence counter, thread, or retention mode causes AEAD decryption to fail.

---

## 5. Message Envelope & Wire Format

Envelopes transmitted across the blind relay are strictly padded to **4,096 bytes** uniform size.

### 5.1 Logical Envelope Structure
```typescript
interface MessageEnvelope {
  v: 1;                       // Version
  id: string;                 // Server-assigned tracking ID (base64url)
  inbox: string;              // Target blinded inbox ID
  header: {
    dhPk: string;             // Ephemeral sender DH public key (base64url, 32 bytes)
    pn: number;               // Previous sending chain length
    n: number;                // Message counter in current sending chain
    retention: 'persistent' | 'timed' | 'viewOnce';
    ttlMs?: number;           // Armed TTL duration for timed messages
    msgId: string;            // Unique message identifier
  };
  nonce: string;              // XChaCha20 nonce (base64url, 24 bytes)
  ciphertext: string;         // Sealed payload + Poly1305 tag (base64url)
  padding: string;            // Structured padding to reach 4096 bytes
}
```

---

## 6. Blind WebSocket Relay Protocol

Communication occurs via JSON-framed WebSocket messages over WSS.

### 6.1 Client -> Relay Frames
- **`HELLO`**: Handshake initialization.
  ```json
  { "t": "HELLO", "v": 1 }
  ```
- **`SUB`**: Blinded inbox subscription with nonced signature.
  ```json
  { "t": "SUB", "inbox": "<inbox_id>", "pk": "<signPk_b64u>", "sig": "<sig_b64u>" }
  ```
- **`UNSUB`**: Unsubscribe from inbox.
  ```json
  { "t": "UNSUB", "inbox": "<inbox_id>" }
  ```
- **`SEND`**: Dispatch fixed-size envelope.
  ```json
  { "t": "SEND", "inbox": "<inbox_id>", "env": "<base64_4096_bytes>" }
  ```
- **`ACK`**: Confirm receipt and trigger permanent purge from server RAM.
  ```json
  { "t": "ACK", "inbox": "<inbox_id>", "ids": ["<msg_id>"] }
  ```
- **`NOOP`**: Cover traffic (accepted and silently dropped).
  ```json
  { "t": "NOOP" }
  ```
- **`PING`**: Liveness probe.
  ```json
  { "t": "PING" }
  ```

### 6.2 Relay -> Client Frames
- **`HELLO`**: Server greeting with connection challenge nonce.
  ```json
  { "t": "HELLO", "v": 1, "nonce": "<nonce_32_b64u>", "envelopeBytes": 4096 }
  ```
- **`SUBBED`**: Subscription accepted.
  ```json
  { "t": "SUBBED", "inbox": "<inbox_id>" }
  ```
- **`DENIED`**: Subscription rejected (invalid signature, wrong key for claimed inbox, or limit exceeded).
  ```json
  { "t": "DENIED", "inbox": "<inbox_id>" }
  ```
- **`DELIVER`**: Inbound envelope delivery.
  ```json
  { "t": "DELIVER", "inbox": "<inbox_id>", "id": "<msg_id>", "env": "<base64_4096_bytes>" }
  ```
- **`ACCEPTED`**: Outbound envelope queued for delivery.
  ```json
  { "t": "ACCEPTED", "inbox": "<inbox_id>", "id": "<msg_id>" }
  ```
- **`DROPPED`**: Envelope dropped due to full queue.
  ```json
  { "t": "DROPPED", "inbox": "<inbox_id>", "reason": "full" }
  ```
- **`PONG`**: Liveness response.
  ```json
  { "t": "PONG" }
  ```
- **`ERR`**: Protocol error (`RATE`, `PARSE`, `ENVELOPE_SIZE`, `INBOX_FORM`, `UNKNOWN`).
  ```json
  { "t": "ERR", "code": "<code>" }
  ```
