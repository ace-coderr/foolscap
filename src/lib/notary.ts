// notary.ts — Notary's own identity, pinned.
//
// The archive's whole claim above "trust my database" is the daily Merkle root:
// a commitment published into a public room before anyone asked, signed by a key
// that is demonstrably the service's. A root signed by an unknown key proves
// nothing, because anyone could have written it — so the key is PINNED here, the
// same way the referee's is pinned in contest.ts, and for the same reason.
//
// NEVER INFER IT. Not from who posts anchors, not from a room name, not from a
// `did` field inside an anchor message. An attacker who can post to the anchor
// room can claim any DID they like in the payload; the only thing that makes an
// anchor Notary's is that its signature verifies against exactly this string.
//
// THIS IS THE SERVICE'S KEY, NOT ITS AUTHOR'S. It signs on behalf of Foolscap
// Notary and nothing else: it never touches a user's message, never signs an
// attestation about a DID, and is not the key in the footer. Those are separate
// identities on purpose — a key that both vouches for the archive and belongs to
// a person invites exactly the conflation this product exists to refuse.
//
// Rotating it is a breaking change. Every root published under the old key stays
// verifiable only against the old key, so a rotation means publishing both and
// saying when the handover was.

/** Notary's public DID. The private seed lives only in the service's env. */
export const NOTARY_DID = 'did:key:z6MkfKBbxFt7RPRTbTUurCRKBuExVwfc9dJSqSZ19VAdc2K3';

/**
 * Where roots are published.
 *
 * A busy public room rather than one of Notary's own: the point of publishing is
 * witnesses, and a root in a room nobody reads is a root nobody can testify to
 * having seen before the fact.
 */
export const ANCHOR_ROOM = 'technocore';

export const ANCHOR_TYPE = 'foolscap.notary.anchor.v1';

/** The published message body. One shape, used by the publisher and the reader. */
export interface AnchorPayload {
  type: typeof ANCHOR_TYPE;
  day: string;
  root: string;
  records: number;
  first_capture: string | null;
  last_capture: string | null;
}

export function anchorPayload(anchor: {
  day: string;
  root: string;
  recordCount: number;
  firstCapture: string | null;
  lastCapture: string | null;
}): string {
  return JSON.stringify({
    type: ANCHOR_TYPE,
    day: anchor.day,
    root: anchor.root,
    records: anchor.recordCount,
    first_capture: anchor.firstCapture,
    last_capture: anchor.lastCapture,
  } satisfies AnchorPayload);
}

/**
 * Parse an anchor message's text. Shape only — it says nothing about whether the
 * message was really Notary's, which is the signature's job and is checked
 * separately against NOTARY_DID.
 */
export function parseAnchorPayload(text: string): AnchorPayload | null {
  try {
    const value = JSON.parse(text) as Partial<AnchorPayload>;
    if (value?.type !== ANCHOR_TYPE) return null;
    if (typeof value.day !== 'string' || typeof value.root !== 'string') return null;
    if (typeof value.records !== 'number') return null;
    return value as AnchorPayload;
  } catch {
    return null;
  }
}
