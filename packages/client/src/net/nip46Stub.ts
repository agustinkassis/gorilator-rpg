import { SimplePool } from "nostr-tools/pool";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import * as nip04 from "nostr-tools/nip04";
import * as nip44 from "nostr-tools/nip44";

// Re-exported so browser/preview test evals (which can't resolve bare specifiers)
// can generate keys + verify signatures through this Vite-served module.
export { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";

/**
 * DEV/TEST ONLY: a loopback NIP-46 "remote signer" (stands in for Amber /
 * nsecbunker) so the bunker round-trip can be verified over a real relay without
 * a phone. Not imported by the app bundle — only by tests / preview evals.
 */

const KIND = 24133;
const nowSec = () => Math.floor(Date.now() / 1000);
function randomId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export interface LoopbackSignerOpts {
  signerSecretKey: Uint8Array; // the "bunker" device key
  userSecretKey: Uint8Array; // the user's key the bunker holds + signs with
  relays: string[];
  clientPubkey: string; // the app's NIP-46 client pubkey
  secret?: string; // nostrconnect: ack back with this to complete pairing
  replyNip44?: boolean; // reply in NIP-44 (test tolerant decrypt)
  authUrlOnceFor?: string; // emit one auth_url before answering this method
}

export function startLoopbackSigner(opts: LoopbackSignerOpts): { close: () => void; signerPubkey: string } {
  const signerPubkey = getPublicKey(opts.signerSecretKey);
  const userPubkey = getPublicKey(opts.userSecretKey);
  const pool = new SimplePool();
  const authedMethods = new Set<string>();

  const send = (obj: Record<string, unknown>) => {
    const json = JSON.stringify(obj);
    const content = opts.replyNip44
      ? nip44.encrypt(json, nip44.getConversationKey(opts.signerSecretKey, opts.clientPubkey))
      : nip04.encrypt(opts.signerSecretKey, opts.clientPubkey, json);
    const ev = finalizeEvent(
      { kind: KIND, created_at: nowSec(), tags: [["p", opts.clientPubkey]], content },
      opts.signerSecretKey,
    );
    void Promise.any(pool.publish(opts.relays, ev)).catch(() => {});
  };

  // Client-initiated pairing: proactively ack with the secret so the client learns
  // our pubkey (mirrors a signer scanning a nostrconnect:// URI).
  if (opts.secret) setTimeout(() => send({ id: randomId(), result: opts.secret }), 300);

  const sub = pool.subscribe(
    opts.relays,
    { kinds: [KIND], authors: [opts.clientPubkey], "#p": [signerPubkey], since: nowSec() - 5 },
    {
      onevent(ev) {
        let req: { id?: string; method?: string; params?: string[] };
        try {
          const plain = nip04.decrypt(opts.signerSecretKey, opts.clientPubkey, ev.content);
          req = JSON.parse(plain);
        } catch {
          return;
        }
        const { id, method, params = [] } = req;
        if (!id || !method) return;

        // One-shot auth_url to exercise the human-approval path.
        if (opts.authUrlOnceFor === method && !authedMethods.has(method)) {
          authedMethods.add(method);
          send({ id, result: "auth_url", error: "https://example.test/approve" });
          setTimeout(() => answer(id, method, params), 400);
          return;
        }
        answer(id, method, params);
      },
    },
  );

  function answer(id: string, method: string, params: string[]) {
    switch (method) {
      case "connect":
        return send({ id, result: "ack" });
      case "get_public_key":
        return send({ id, result: userPubkey });
      case "ping":
        return send({ id, result: "pong" });
      case "sign_event": {
        try {
          const tmpl = JSON.parse(params[0]);
          const signed = finalizeEvent(tmpl, opts.userSecretKey);
          return send({ id, result: JSON.stringify(signed) });
        } catch (e) {
          return send({ id, error: String(e) });
        }
      }
      default:
        return send({ id, error: `unknown method ${method}` });
    }
  }

  return {
    signerPubkey,
    close: () => {
      try {
        sub.close();
      } catch {
        /* ignore */
      }
      try {
        pool.close(opts.relays);
      } catch {
        /* ignore */
      }
    },
  };
}
