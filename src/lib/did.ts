// did.ts — did:key, Ed25519, and Technocore canonicalisation.
//
// Pure and dependency-free on purpose: no DOM, no network, no imports. Everything
// here can be exercised from Node or a bare test page, which matters because this
// is the module that decides whether a receipt is genuine.
//
// Ported from js/did.js unchanged apart from types. The behaviour is the audited
// part; the annotations only write down what it already did.
//
// Foolscap trusts exactly one key: the referee DID pinned in contest.js. This
// module has no opinion about which DID that is — it only turns a did:key string
// into a public key and answers yes or no on a signature.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Anything that can be read as a byte sequence. */
export type BytesLike = Uint8Array | ArrayBuffer | ArrayBufferView | number[];

/**
 * A Uint8Array backed by a plain ArrayBuffer.
 *
 * WebCrypto will not accept a view over a SharedArrayBuffer, and since TS 5.7
 * Uint8Array carries its buffer type, so the distinction has to be written down
 * rather than assumed.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

export interface Canonicalised {
  room: string;
  nonce: string;
  /** The text after the sweep — this is what gets signed. */
  text: string;
  original: string;
  changed: boolean;
  canonical: string;
}

export interface SignatureCheck {
  ok: boolean;
  /** Empty when ok; otherwise says what to do about it. */
  reason: string;
  signature?: string;
}

export interface NonceCheck {
  ok: boolean;
  reason: string;
  nonce?: string;
}

/** The parts of a room message a signature is computed over. */
export interface VerifiableMessage {
  from?: string | null;
  /** Always a string: a nonce that has been through a double no longer verifies. */
  nonce?: string | null;
  text?: string | null;
  sig?: string | null;
  room?: string | null;
}

export interface VerifyResult {
  verified: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// base58btc
// ---------------------------------------------------------------------------

export const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const B58_MAP = (() => {
  const map = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE58_ALPHABET.length; i++) {
    map[BASE58_ALPHABET.charCodeAt(i)] = i;
  }
  return map;
})();

/** Decode a base58btc string to bytes. Throws naming the offending character. */
export function base58btcDecode(str: string): Bytes {
  if (typeof str !== 'string') throw new TypeError('base58btc: input must be a string');
  if (str.length === 0) throw new Error('base58btc: input is empty');

  const bytes = [0]; // little-endian accumulator
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const digit = code < 128 ? B58_MAP[code] : -1;
    if (digit < 0) {
      throw new Error(
        `base58btc: "${str[i]}" at position ${i} is not a base58btc character ` +
          '(0, O, I and l are excluded from the alphabet)'
      );
    }
    let carry = digit;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry = carry >>> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry = carry >>> 8;
    }
  }

  // Each leading '1' is a leading zero byte.
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);

  return Uint8Array.from(bytes.reverse()) as Bytes;
}

/** Encode bytes as base58btc. */
export function base58btcEncode(bytes: BytesLike): string {
  const input = toBytes(bytes);
  if (input.length === 0) return '';

  const digits = [0];
  for (let i = 0; i < input.length; i++) {
    let carry = input[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = '';
  for (let i = 0; i < input.length && input[i] === 0; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  return out;
}

// ---------------------------------------------------------------------------
// base64url — unpadded, the shape Technocore signatures use
// ---------------------------------------------------------------------------

const B64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const B64URL_MAP = (() => {
  const map = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64URL_ALPHABET.length; i++) {
    map[B64URL_ALPHABET.charCodeAt(i)] = i;
  }
  return map;
})();

/** Decode unpadded (or padded) base64url to bytes. */
export function base64urlDecode(str: string): Bytes {
  if (typeof str !== 'string') throw new TypeError('base64url: input must be a string');
  const s = str.replace(/=+$/, '');
  if (s.length % 4 === 1) {
    throw new Error(`base64url: length ${s.length} is not a valid base64 length`);
  }

  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const digit = code < 128 ? B64URL_MAP[code] : -1;
    if (digit < 0) {
      throw new Error(
        `base64url: "${s[i]}" at position ${i} is not a base64url character ` +
          '(base64url uses - and _, never + and /)'
      );
    }
    acc = (acc << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return out.subarray(0, o) as Bytes;
}

/** Encode bytes as unpadded base64url. */
export function base64urlEncode(bytes: BytesLike): string {
  const input = toBytes(bytes);
  let out = '';
  for (let i = 0; i < input.length; i += 3) {
    const b0 = input[i];
    const b1 = input[i + 1];
    const b2 = input[i + 2];
    out += B64URL_ALPHABET[b0 >>> 2];
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 || 0) >>> 4)];
    if (b1 === undefined) break;
    out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 || 0) >>> 6)];
    if (b2 === undefined) break;
    out += B64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** Decode hex (optionally 0x-prefixed) to bytes. */
export function hexDecode(str: string): Bytes {
  const s = String(str).trim().replace(/^0x/i, '');
  if (s.length % 2 !== 0) throw new Error('hex: odd number of characters');
  if (/[^0-9a-fA-F]/.test(s)) throw new Error('hex: input contains a non-hex character');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Encode bytes as lowercase hex. */
export function hexEncode(bytes: BytesLike): string {
  const input = toBytes(bytes);
  let out = '';
  for (let i = 0; i < input.length; i++) out += input[i].toString(16).padStart(2, '0');
  return out;
}

// ---------------------------------------------------------------------------
// did:key
// ---------------------------------------------------------------------------

/** Multicodec prefix for an Ed25519 public key: 0xed 0x01. */
export const MULTICODEC_ED25519_PUB = Uint8Array.from([0xed, 0x01]);

export const DID_KEY_ED25519_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]{40,}$/;

// Only so a wrong-key-type error can say which type it was.
const MULTICODEC_NAMES: Record<string, string> = {
  e701: 'secp256k1',
  '8024': 'P-256',
  '8124': 'P-384',
  eb01: 'X25519',
};

/** Cheap shape test. Use publicKeyFromDid when you need the real answer. */
export function looksLikeDid(value: unknown): value is string {
  return typeof value === 'string' && DID_KEY_ED25519_RE.test(value.trim());
}

/**
 * did:key:z... -> the 32 raw Ed25519 public key bytes.
 * Throws an error that names what is actually wrong with the string.
 */
export function publicKeyFromDid(did: string): Bytes {
  if (typeof did !== 'string') throw new TypeError('DID must be a string');
  const value = did.trim();

  if (!value.startsWith('did:key:')) {
    throw new Error('DID must start with did:key: — Foolscap only handles did:key');
  }
  const multibase = value.slice('did:key:'.length);
  if (multibase[0] !== 'z') {
    throw new Error('did:key must use the base58btc multibase prefix "z"');
  }

  const bytes = base58btcDecode(multibase.slice(1));

  // Prefix before length: a perfectly valid secp256k1 or P-256 did:key should be
  // told it is the wrong kind of key, not handed a byte count.
  if (bytes.length < 2 || bytes[0] !== 0xed || bytes[1] !== 0x01) {
    const p0 = (bytes[0] ?? 0).toString(16).padStart(2, '0');
    const p1 = (bytes[1] ?? 0).toString(16).padStart(2, '0');
    const named = MULTICODEC_NAMES[`${p0}${p1}`];
    throw new Error(
      `did:key is not Ed25519 — its multicodec prefix is 0x${p0} 0x${p1}` +
        (named ? ` (${named})` : '') +
        ', expected 0xed 0x01. Technocore signs with Ed25519 only.'
    );
  }
  if (bytes.length !== 34) {
    throw new Error(
      `did:key decoded to ${bytes.length} bytes; an Ed25519 did:key decodes to 34 ` +
        '(2 prefix bytes plus a 32-byte key)'
    );
  }
  return bytes.slice(2);
}

/** 32 raw Ed25519 public key bytes -> did:key:z... */
export function didFromPublicKey(publicKey: BytesLike): string {
  const key = toBytes(publicKey);
  if (key.length !== 32) {
    throw new Error(`An Ed25519 public key is 32 bytes; got ${key.length}`);
  }
  const prefixed = new Uint8Array(34);
  prefixed.set(MULTICODEC_ED25519_PUB, 0);
  prefixed.set(key, 2);
  return `did:key:z${base58btcEncode(prefixed)}`;
}

// ---------------------------------------------------------------------------
// The single-line sweep and the canonical string
// ---------------------------------------------------------------------------

// The server replaces every character in these Unicode categories with a space,
// then trims the ends. Sign what survives, not what was typed.
const SWEEP_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;

/**
 * Apply the server's single-line sweep.
 *
 * Note what this deliberately does NOT do: it never normalises Unicode. NFC and
 * NFD of the same word are different messages with different signatures, so user
 * text passes through unchanged apart from the sweep itself.
 */
export function sweep(text: string): string {
  return String(text).replace(SWEEP_RE, ' ').replace(/^\s+|\s+$/gu, '');
}

/** True when the sweep would change the text — worth showing before they sign. */
export function sweepChanges(text: string): boolean {
  return sweep(text) !== String(text);
}

/**
 * The exact string that gets signed: `<room>|<nonce>|<text>`, UTF-8.
 * `text` must already be swept — call sweep() first, or use canonicalize().
 */
export function canonicalString(room: string, nonce: string | number, text: string): string {
  return `${room}|${nonce}|${text}`;
}

/**
 * One call for the whole write lane: sweep the text, build the canonical string,
 * and report whether the sweep changed anything so the UI can show the difference.
 */
export function canonicalize({ room, nonce, text }: { room: string; nonce: string | number; text: string }): Canonicalised {
  const original = String(text);
  const swept = sweep(original);
  return {
    room,
    nonce: String(nonce),
    text: swept,
    original,
    changed: swept !== original,
    canonical: canonicalString(room, String(nonce), swept),
  };
}

// ---------------------------------------------------------------------------
// Signature and nonce shape
// ---------------------------------------------------------------------------

export const SIGNATURE_LENGTH = 86;

// A 64-byte Ed25519 signature in unpadded base64url is 86 characters, and the
// last character carries only two meaningful bits — so a canonical encoding
// always ends in A, Q, g or w.
export const SIGNATURE_RE = /^[A-Za-z0-9_-]{85}[AQgw]$/;

/**
 * Validate a pasted signature's shape. Returns { ok, reason, signature } with a
 * reason that says what to do, because this is the box users get wrong.
 */
export function validateSignature(sig: unknown): SignatureCheck {
  if (typeof sig !== 'string' || sig.trim().length === 0) {
    return {
      ok: false,
      reason: 'Paste the 86-character signature you produced for the canonical string.',
    };
  }
  const value = sig.trim();
  if (/=/.test(value)) {
    return { ok: false, reason: 'Technocore signatures are unpadded — drop the trailing "=" characters.' };
  }
  if (/[+/]/.test(value)) {
    return {
      ok: false,
      reason: 'This is standard base64. Technocore uses base64url: "+" becomes "-" and "/" becomes "_".',
    };
  }
  const bad = value.match(/[^A-Za-z0-9_-]/);
  if (bad) {
    return {
      ok: false,
      reason: `"${bad[0]}" is not a base64url character. Expected only A–Z, a–z, 0–9, "-" and "_".`,
    };
  }
  if (value.length !== SIGNATURE_LENGTH) {
    return {
      ok: false,
      reason: `A signature is ${SIGNATURE_LENGTH} characters; this is ${value.length}. Check for a truncated or doubled paste.`,
    };
  }
  if (!SIGNATURE_RE.test(value)) {
    return {
      ok: false,
      reason: `The last character of a canonical signature is always A, Q, g or w; this one is "${value[85]}". The signer emitted a non-canonical encoding.`,
    };
  }
  return { ok: true, reason: '', signature: value };
}

export const NONCE_RE = /^[0-9]{1,19}$/;

/** Validate nonce shape. Nonces are 1–19 digits and are handled as strings throughout. */
export function validateNonce(nonce: unknown): NonceCheck {
  const value = String(nonce ?? '').trim();
  if (value.length === 0) {
    return { ok: false, reason: 'Nonce is required. Press New nonce for a clock-based one.' };
  }
  if (!/^[0-9]+$/.test(value)) {
    return { ok: false, reason: 'Nonce is digits only — no spaces, signs or separators.' };
  }
  if (value.length > 19) {
    return { ok: false, reason: `Nonce is at most 19 digits; this is ${value.length}.` };
  }
  return { ok: true, reason: '', nonce: value };
}

/**
 * Compare two decimal nonce strings without going through Number — nonces can
 * exceed 2^53, and a rounded nonce produces a signature that will not re-verify.
 * Returns -1, 0 or 1.
 */
export function compareNonce(a: string | number, b: string | number): -1 | 0 | 1 {
  const x = String(a).replace(/^0+(?=\d)/, '');
  const y = String(b).replace(/^0+(?=\d)/, '');
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

/** A millisecond clock reading, as a string. Strictly increasing in practice. */
export function newNonce(now: number = Date.now()): string {
  return String(now);
}

/**
 * The next nonce to use in a room, given the highest one this key has already
 * used there. The clock is normally ahead; when it is not, step past by one.
 */
export function nextNonce(lastUsed: string | null | undefined, now: number = Date.now()): string {
  const clock = String(now);
  if (lastUsed == null || lastUsed === '') return clock;
  return compareNonce(clock, lastUsed) > 0 ? clock : incrementDecimal(String(lastUsed));
}

function incrementDecimal(value: string): string {
  const digits = value.split('');
  let i = digits.length - 1;
  for (; i >= 0; i--) {
    if (digits[i] === '9') {
      digits[i] = '0';
    } else {
      digits[i] = String(Number(digits[i]) + 1);
      break;
    }
  }
  if (i < 0) digits.unshift('1');
  return digits.join('');
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

const ED25519 = { name: 'Ed25519' };
const publicKeyCache = new Map<string, Promise<CryptoKey>>();
const encoder = new TextEncoder();

/** UTF-8 encode a string. */
export function utf8(value: string): Bytes {
  return encoder.encode(String(value)) as Bytes;
}

function subtle(cryptoImpl?: Crypto): SubtleCrypto {
  const c = cryptoImpl || globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error(
      'WebCrypto is unavailable. Foolscap needs a secure context (https or localhost) to verify signatures.'
    );
  }
  return c.subtle;
}

const UNSUPPORTED =
  'This browser cannot verify Ed25519 in WebCrypto. Use a current Chrome, Edge, Safari or Firefox — ' +
  'Foolscap will not show a signature as verified without checking it.';

/** Is Ed25519 usable in this browser's WebCrypto? Cached after the first call. */
let ed25519Support: boolean | null = null;
export async function ed25519Available(cryptoImpl?: Crypto): Promise<boolean> {
  if (ed25519Support !== null) return ed25519Support;
  try {
    // An all-zero 32-byte value is a well-formed point encoding for import purposes.
    await subtle(cryptoImpl).importKey('raw', new Uint8Array(32), ED25519, false, ['verify']);
    ed25519Support = true;
  } catch {
    ed25519Support = false;
  }
  return ed25519Support;
}

/** Import 32 raw public key bytes as a WebCrypto verify key. */
export async function importPublicKey(publicKey: BytesLike, cryptoImpl?: Crypto): Promise<CryptoKey> {
  const key = toBytes(publicKey);
  if (key.length !== 32) throw new Error(`An Ed25519 public key is 32 bytes; got ${key.length}`);
  try {
    return await subtle(cryptoImpl).importKey('raw', key, ED25519, false, ['verify']);
  } catch (err) {
    if (!(await ed25519Available(cryptoImpl))) throw new Error(UNSUPPORTED);
    throw err;
  }
}

/** Import (and cache) the verify key for a did:key string. */
export async function keyForDid(did: string, cryptoImpl?: Crypto): Promise<CryptoKey> {
  const value = String(did ?? '').trim();
  let cached = publicKeyCache.get(value);
  if (!cached) {
    cached = importPublicKey(publicKeyFromDid(value), cryptoImpl);
    publicKeyCache.set(value, cached);
  }
  try {
    return await cached;
  } catch (err) {
    publicKeyCache.delete(value);
    throw err;
  }
}

/**
 * Verify a signature against a DID. `message` is a string (UTF-8 encoded here)
 * or bytes; `signature` is 86 base64url characters or 64 raw bytes.
 *
 * Returns a boolean; a malformed DID or signature throws. For anything claiming
 * to be a referee receipt the caller should treat both as the same answer: not
 * authentic.
 */
export async function verify(
  did: string,
  message: string | BytesLike,
  signature: string | BytesLike,
  cryptoImpl?: Crypto
): Promise<boolean> {
  const key = await keyForDid(did, cryptoImpl);
  const sig = typeof signature === 'string' ? base64urlDecode(signature.trim()) : toBytes(signature);
  if (sig.length !== 64) {
    throw new Error(`An Ed25519 signature is 64 bytes; this one decodes to ${sig.length}`);
  }
  const data = typeof message === 'string' ? utf8(message) : toBytes(message);
  return subtle(cryptoImpl).verify(ED25519, key, sig, data);
}

/**
 * Verify a room message exactly as the server saw it: the canonical string is
 * rebuilt from the room, the nonce as a string, and the stored text.
 *
 * Returns { verified, error } and never throws, so a wall of messages can be
 * checked without one bad record stopping the render.
 */
export async function verifyMessage(
  message: VerifiableMessage,
  { room, cryptoImpl }: { room?: string | null; cryptoImpl?: Crypto } = {}
): Promise<VerifyResult> {
  try {
    const roomName = room ?? message.room;
    if (!roomName) return { verified: false, error: 'No room name — the canonical string cannot be rebuilt.' };
    if (!message.sig) return { verified: false, error: 'Message carries no signature.' };
    if (message.nonce == null) return { verified: false, error: 'Message carries no nonce.' };
    const canonical = canonicalString(roomName, String(message.nonce), message.text ?? '');
    const verified = await verify(message.from ?? '', canonical, message.sig, cryptoImpl);
    return {
      verified,
      error: verified ? null : 'Signature does not match this DID over <room>|<nonce>|<text>.',
    };
  } catch (err) {
    return { verified: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Local key mode — opt-in only, never the default on a hosted copy
// ---------------------------------------------------------------------------

// PKCS#8 wrapper for a bare Ed25519 seed: SEQUENCE, version 0, Ed25519 OID,
// OCTET STRING (32) — then the seed.
const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/** Wrap a 32-byte Ed25519 seed in the PKCS#8 envelope WebCrypto wants. */
export function seedToPkcs8(seed: BytesLike): Bytes {
  const bytes = toBytes(seed);
  if (bytes.length !== 32) throw new Error(`An Ed25519 seed is 32 bytes; got ${bytes.length}`);
  const out = new Uint8Array(PKCS8_PREFIX.length + 32);
  out.set(PKCS8_PREFIX, 0);
  out.set(bytes, PKCS8_PREFIX.length);
  return out;
}

/**
 * Accept a seed as 64 hex characters, or as base64/base64url of 32 bytes.
 * Returns 32 bytes or throws saying what was expected.
 */
export function parseSeed(input: unknown): Bytes {
  const value = String(input ?? '').trim();
  if (value.length === 0) throw new Error('No key material given.');
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(value)) return hexDecode(value);
  const b64 = value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (/^[A-Za-z0-9_-]{43}$/.test(b64)) {
    const bytes = base64urlDecode(b64);
    if (bytes.length === 32) return bytes;
  }
  throw new Error('Expected a 32-byte Ed25519 seed as 64 hex characters or 43 base64url characters.');
}

/** Import a seed as a WebCrypto signing key. Extractable so the DID can be derived. */
export async function importSeed(seed: BytesLike, cryptoImpl?: Crypto): Promise<CryptoKey> {
  try {
    return await subtle(cryptoImpl).importKey('pkcs8', seedToPkcs8(seed), ED25519, true, ['sign']);
  } catch (err) {
    if (!(await ed25519Available(cryptoImpl))) throw new Error(UNSUPPORTED);
    throw err;
  }
}

/** The did:key a seed corresponds to — show it so the user can confirm the key is theirs. */
export async function didFromSeed(seed: BytesLike, cryptoImpl?: Crypto): Promise<string> {
  const key = await importSeed(seed, cryptoImpl);
  const jwk = await subtle(cryptoImpl).exportKey('jwk', key);
  // An Ed25519 private JWK always carries the public half in `x`; this says so
  // rather than trusting it silently.
  if (typeof jwk.x !== 'string') {
    throw new Error('WebCrypto returned an Ed25519 key with no public component.');
  }
  return didFromPublicKey(base64urlDecode(jwk.x));
}

/** Sign a message with a raw seed. Returns 86 base64url characters. */
export async function signWithSeed(seed: BytesLike, message: string | BytesLike, cryptoImpl?: Crypto): Promise<string> {
  const key = await importSeed(seed, cryptoImpl);
  const data = typeof message === 'string' ? utf8(message) : toBytes(message);
  const sig = await subtle(cryptoImpl).sign(ED25519, key, data);
  return base64urlEncode(new Uint8Array(sig));
}

// ---------------------------------------------------------------------------

function toBytes(value: BytesLike): Bytes {
  if (value instanceof Uint8Array) return value as Bytes;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength) as Bytes;
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new TypeError('Expected bytes (Uint8Array, ArrayBuffer or number array)');
}
