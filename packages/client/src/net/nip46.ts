import { SimplePool } from "nostr-tools/pool";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import * as nip04 from "nostr-tools/nip04";
import * as nip44 from "nostr-tools/nip44";
import { parseBunkerInput, createNostrConnectURI, type BunkerPointer } from "nostr-tools/nip46";
import { RELAYS, type NostrEvent } from "./nostr";

/**
 * A minimal NIP-46 ("nsec bunker" / remote signer) client that speaks **NIP-04**
 * over the wire (Amber / nsecbunker compatibility), since nostr-tools' built-in
 * `BunkerSigner` is locked to NIP-44. It exposes the same surface the rest of the
 * app needs (`getPublicKey` + `signEvent`), so `installBunkerSigner` can mount it
 * as `window.nostr` and every existing signing call site works unchanged.
 *
 * Transport: kind-24133 events tagged `["p", <counterparty>]`, content =
 * NIP-04(JSON-RPC). Responses are decrypted tolerantly (NIP-04, then NIP-44) so a
 * signer that replies in NIP-44 still works. See docs — built per NIP-46.
 */

const NIP46_KIND = 24133;
export { type BunkerPointer };

export interface Nip46Options {
  clientSecretKey: Uint8Array;
  remotePubkey: string; // "" until learned (client-initiated nostrconnect pairing)
  relays: string[];
  secret?: string | null;
  onAuthUrl?: (url: string) => void; // signer wants the human to approve at this URL
}

interface Pending {
  resolve: (v: string) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
  waitingAuth?: boolean;
  authUrl?: string; // last approval URL surfaced (dedupe repeated auth_url frames)
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => Uint8Array.from(h.match(/.{2}/g)!.map((x) => parseInt(x, 16)));
const nowSec = () => Math.floor(Date.now() / 1000);
function randomId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return toHex(b);
}

export class Nip46Client {
  readonly clientSecretKey: Uint8Array;
  readonly clientPubkey: string;
  remotePubkey: string;
  readonly relays: string[];
  private secret?: string | null;
  private onAuthUrl?: (url: string) => void;
  private pool = new SimplePool();
  private sub: { close: () => void } | null = null;
  private pending = new Map<string, Pending>();
  private closed = false;

  // client-initiated pairing (nostrconnect://) — resolved when the signer replies
  // with result === this.pairingSecret.
  private pairingSecret?: string;
  private pairingResolve?: (remotePubkey: string) => void;

  constructor(opts: Nip46Options) {
    this.clientSecretKey = opts.clientSecretKey;
    this.clientPubkey = getPublicKey(opts.clientSecretKey);
    this.remotePubkey = opts.remotePubkey;
    this.relays = opts.relays.length ? opts.relays : RELAYS;
    this.secret = opts.secret;
    this.onAuthUrl = opts.onAuthUrl;
  }

  /** Open the relay subscription for inbound RPC responses (idempotent). */
  start(): void {
    if (this.sub || this.closed) return;
    this.sub = this.pool.subscribe(
      this.relays,
      { kinds: [NIP46_KIND], "#p": [this.clientPubkey], since: nowSec() - 5 },
      { onevent: (e) => this.onEvent(e as NostrEvent) },
    );
  }

  /** Decrypt an inbound event with NIP-04, falling back to NIP-44; null on failure. */
  private tryDecrypt(counterparty: string, content: string): string | null {
    try {
      return nip04.decrypt(this.clientSecretKey, counterparty, content);
    } catch {
      /* fall through to nip44 */
    }
    try {
      return nip44.decrypt(content, nip44.getConversationKey(this.clientSecretKey, counterparty));
    } catch {
      return null;
    }
  }

  private onEvent(ev: NostrEvent): void {
    // Once we know the remote signer, only accept its events.
    if (this.remotePubkey && ev.pubkey !== this.remotePubkey) return;
    const counterparty = this.remotePubkey || ev.pubkey;
    const plain = this.tryDecrypt(counterparty, ev.content);
    if (plain === null) return; // not for us / undecryptable — drop silently
    let msg: { id?: string; result?: string; error?: string };
    try {
      msg = JSON.parse(plain);
    } catch {
      return;
    }

    // Client-initiated pairing: the signer acks with result === our secret.
    if (!this.remotePubkey && this.pairingResolve && msg.result && msg.result === this.pairingSecret) {
      this.remotePubkey = ev.pubkey;
      const resolve = this.pairingResolve;
      this.pairingResolve = undefined;
      resolve(ev.pubkey);
      // some signers send the connect-ack under an id too — fall through to settle it
    }

    if (!msg.id) return;
    const p = this.pending.get(msg.id);
    if (!p) return;

    // The signer asks the human to approve in a browser tab; keep waiting. Re-arm
    // the approval window on EVERY auth_url frame (sliding deadline — a slow human
    // shouldn't time out while the signer keeps signalling), but only surface a URL
    // we haven't shown yet. A frame with no URL is malformed → ignore it.
    if (msg.result === "auth_url") {
      if (!msg.error) return;
      p.waitingAuth = true;
      clearTimeout(p.timer);
      p.timer = setTimeout(() => {
        this.pending.delete(msg.id!);
        p.reject(new Error(`${p.method} timed out waiting for approval`));
      }, 120_000);
      if (p.authUrl !== msg.error) {
        p.authUrl = msg.error;
        this.onAuthUrl?.(msg.error);
      }
      return;
    }

    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result ?? "");
  }

  private sendRequest(method: string, params: string[], timeoutMs: number): Promise<string> {
    if (this.closed) return Promise.reject(new Error("signer closed"));
    if (!this.remotePubkey) return Promise.reject(new Error("not paired with a signer yet"));
    this.start();
    const id = randomId();
    const payload = JSON.stringify({ id, method, params });
    const content = nip04.encrypt(this.clientSecretKey, this.remotePubkey, payload);
    const event = finalizeEvent(
      { kind: NIP46_KIND, created_at: nowSec(), tags: [["p", this.remotePubkey]], content },
      this.clientSecretKey,
    );
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      // Best-effort publish; the response arrives over the subscription.
      Promise.any(this.pool.publish(this.relays, event)).catch(() => {
        /* a relay rejecting publish isn't fatal as long as one delivers */
      });
    });
  }

  /** bunker:// flow: ask the signer to authorize this client. */
  async connect(): Promise<void> {
    await this.sendRequest("connect", [this.remotePubkey, this.secret ?? ""], 30_000);
  }

  async getPublicKey(): Promise<string> {
    return this.sendRequest("get_public_key", [], 15_000);
  }

  async signEvent(template: { kind: number; created_at: number; tags: string[][]; content: string }): Promise<NostrEvent> {
    const result = await this.sendRequest("sign_event", [JSON.stringify(template)], 30_000);
    return JSON.parse(result) as NostrEvent;
  }

  async ping(): Promise<string> {
    return this.sendRequest("ping", [], 7_000);
  }

  /** Wait for the signer to connect back (client-initiated nostrconnect:// flow). */
  awaitPairing(secret: string, timeoutMs = 180_000, signal?: AbortSignal): Promise<string> {
    this.pairingSecret = secret;
    this.start();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pairingResolve = undefined;
        reject(new Error("pairing timed out — the signer didn't connect"));
      }, timeoutMs);
      const done = (pk: string) => {
        clearTimeout(timer);
        resolve(pk);
      };
      this.pairingResolve = done;
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        this.pairingResolve = undefined;
        reject(new Error("pairing cancelled"));
      });
    });
  }

  close(): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("signer closed"));
    }
    this.pending.clear();
    try {
      this.sub?.close();
    } catch {
      /* already closed */
    }
    try {
      this.pool.close(this.relays);
    } catch {
      /* ignore */
    }
  }
}

/** Mount a bunker client as `window.nostr` so every signing call site uses it. */
export function installBunkerSigner(client: Nip46Client): void {
  window.nostr = {
    getPublicKey: () => client.getPublicKey(),
    signEvent: (e) => client.signEvent(e),
  };
}

// ---- pairing entry points --------------------------------------------------

export interface BunkerSession {
  client: Nip46Client;
  clientSecretKeyHex: string;
  remotePubkey: string;
  relays: string[];
  secret?: string | null;
}

/** Paste flow: connect to a `bunker://…` (or NIP-05) connection string. */
export async function connectWithBunkerString(
  input: string,
  onAuthUrl?: (url: string) => void,
): Promise<BunkerSession> {
  const pointer = await parseBunkerInput(input.trim());
  if (!pointer) throw new Error("Not a valid bunker:// connection string.");
  const clientSecretKey = generateSecretKey();
  const client = new Nip46Client({
    clientSecretKey,
    remotePubkey: pointer.pubkey,
    relays: pointer.relays,
    secret: pointer.secret,
    onAuthUrl,
  });
  await client.connect();
  return {
    client,
    clientSecretKeyHex: toHex(clientSecretKey),
    remotePubkey: pointer.pubkey,
    relays: client.relays,
    secret: pointer.secret,
  };
}

export interface NostrConnectHandle {
  uri: string;
  clientPubkey: string;
  /** Resolves once a signer connects (QR scanned / Amber opened). */
  paired: Promise<BunkerSession>;
  cancel: () => void;
}

/**
 * QR / "open Amber" flow (client-initiated): build a `nostrconnect://` URI and
 * wait for the signer to connect back. Returns the URI to display immediately +
 * a promise that resolves when pairing completes.
 */
export function startNostrConnect(opts: {
  relays?: string[];
  name?: string;
  url?: string;
  image?: string;
  onAuthUrl?: (url: string) => void;
}): NostrConnectHandle {
  const relays = opts.relays?.length ? opts.relays : RELAYS;
  const clientSecretKey = generateSecretKey();
  const clientPubkey = getPublicKey(clientSecretKey);
  const secret = randomId();
  const uri = createNostrConnectURI({
    clientPubkey,
    relays,
    secret,
    name: opts.name ?? "Gorilator",
    url: opts.url ?? location.origin,
    ...(opts.image ? { image: opts.image } : {}),
  });
  const client = new Nip46Client({ clientSecretKey, remotePubkey: "", relays, secret, onAuthUrl: opts.onAuthUrl });
  const ctrl = new AbortController();
  const paired = client.awaitPairing(secret, 180_000, ctrl.signal).then((remotePubkey) => ({
    client,
    clientSecretKeyHex: toHex(clientSecretKey),
    remotePubkey,
    relays,
    secret,
  }));
  // If pairing never completes (timeout/abort), close the client so its relay
  // subscription doesn't linger even when the caller forgets to cancel().
  paired.catch(() => {
    try {
      client.close();
    } catch {
      /* ignore */
    }
  });
  return {
    uri,
    clientPubkey,
    paired,
    cancel: () => {
      ctrl.abort();
      client.close();
    },
  };
}

/** Rebuild a bunker client from a persisted session (startup restore). */
export function restoreBunkerClient(saved: {
  clientSecretKey: string;
  remotePubkey: string;
  relays: string[];
  secret?: string;
}, onAuthUrl?: (url: string) => void): Nip46Client {
  return new Nip46Client({
    clientSecretKey: fromHex(saved.clientSecretKey),
    remotePubkey: saved.remotePubkey,
    relays: saved.relays,
    secret: saved.secret,
    onAuthUrl,
  });
}
