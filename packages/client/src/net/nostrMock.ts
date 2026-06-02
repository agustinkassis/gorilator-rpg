import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { decode } from "nostr-tools/nip19";

/**
 * DEV-ONLY: install a fake NIP-07 signer on `window.nostr` so the Nostr login
 * flow can be exercised without a browser extension (Alby/nos2x). Enabled by the
 * URL param `?mocknostr=<arg>` where <arg> is one of:
 *   • `gen`               — generate a throwaway key (default)
 *   • `nsec1…`            — sign as a specific nsec
 *   • 64-hex-char privkey — sign as that secret key
 * Gated behind `import.meta.env.DEV` at the call site — never shipped in prod.
 */
export function installMockSigner(arg: string): string {
  let sk: Uint8Array;
  try {
    if (arg && arg !== "gen" && arg.startsWith("nsec")) {
      sk = decode(arg).data as Uint8Array;
    } else if (/^[0-9a-f]{64}$/i.test(arg)) {
      sk = Uint8Array.from(arg.match(/../g)!.map((h) => parseInt(h, 16)));
    } else {
      sk = generateSecretKey();
    }
  } catch {
    sk = generateSecretKey();
  }
  const pubkey = getPublicKey(sk);
  window.nostr = {
    getPublicKey: async () => pubkey,
    signEvent: async (ev) => finalizeEvent(ev as never, sk) as never,
  };
  console.log("[nostrMock] installed dev signer; pubkey:", pubkey);
  return pubkey;
}
