import QRCode from "qrcode";
import {
  startNostrConnect,
  connectWithBunkerString,
  installBunkerSigner,
  type BunkerSession,
  type NostrConnectHandle,
} from "../net/nip46";
import { establishNostrIdentity, signNostrAuth, hasNostrExtension, type NostrIdentity, type NostrPhase } from "../net/nostr";
import { saveSession } from "../net/nostrSession";
import { setActiveSession, getActiveIdentity, getActiveBunkerClient } from "../net/nostrSigner";
import type { NetworkClient } from "../net/NetworkClient";

/**
 * The unified Nostr login modal: a tabbed chooser used at the splash AND in-game.
 *
 *   • Extension     — NIP-07 (only shown when an extension is detected)
 *   • Remote signer — a nostrconnect:// QR (+ "Open in Amber" deep link) and a
 *                     paste field for a bunker:// connection string
 *
 * `open()` resolves with the chosen method (+ a connected bunker session), or null
 * if cancelled. `completeLogin()` then establishes identity, optionally upgrades the
 * live server session, and persists the session so it survives a refresh.
 */

export interface NostrLoginResult {
  method: "nip07" | "bunker";
  session?: BunkerSession;
}

type Tab = "extension" | "remote";

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
  #nostrLogin { position:fixed; inset:0; z-index:200; display:grid; place-items:center; background:rgba(6,8,12,.66); backdrop-filter:blur(3px); font:13px/1.5 system-ui,sans-serif; }
  #nostrLogin .nlPanel { width:min(400px,calc(100vw - 32px)); max-height:90vh; overflow:auto; color:#e8eef6; background:linear-gradient(180deg,#181c26,#0e1118); border:2px solid #4a9a52; border-radius:16px; box-shadow:0 18px 60px #000c; }
  #nostrLogin .nlHead { display:flex; justify-content:space-between; align-items:center; padding:13px 16px; border-bottom:1px solid #283245; }
  #nostrLogin .nlHead b { color:#9fe0a0; font-size:15px; }
  #nostrLogin .nlClose { cursor:pointer; background:#26303f; color:#fff; border:1px solid #4a5b72; border-radius:6px; padding:3px 9px; }
  #nostrLogin .nlTabs { display:flex; gap:4px; padding:14px 16px 0; border-bottom:1px solid #2c3a4e; }
  #nostrLogin .nlTab { flex:1; cursor:pointer; margin-bottom:-1px; padding:10px 12px; font:700 12px system-ui,sans-serif; color:#8fa0b5; background:transparent; border:1px solid transparent; border-radius:10px 10px 0 0; transition:color .15s, background .15s; }
  #nostrLogin .nlTab:hover { color:#cfe0d2; }
  /* Active tab merges into the content: its bottom border matches the content bg,
     punching through the tab-row divider so there's no line under the selected tab. */
  #nostrLogin .nlTab.active { color:#f3fff3; background:#12161e; border-color:#2c3a4e; border-bottom-color:#12161e; }
  #nostrLogin .nlContent { padding:16px; display:flex; flex-direction:column; gap:12px; background:#12161e; }
  #nostrLogin .nlText { color:#9fb0c0; font-size:12px; }
  #nostrLogin .nlPrimary { cursor:pointer; padding:11px; border-radius:9px; font-weight:700; color:#e8ffe8; background:linear-gradient(#234a2d,#14301c); border:2px solid #3f8c49; }
  #nostrLogin .nlGhost { cursor:pointer; padding:8px; border-radius:8px; font-weight:600; color:#cfe0f2; background:#1a2230; border:1px solid #35445e; }
  #nostrLogin .nlAmber { text-align:center; text-decoration:none; cursor:pointer; padding:10px; border-radius:9px; font-weight:700; color:#f0c98a; background:linear-gradient(#3a2c12,#241a0c); border:2px solid #c98a5a; }
  #nostrLogin .nlRemote { display:flex; flex-direction:column; gap:10px; align-items:stretch; }
  #nostrLogin .nlQr { align-self:center; border-radius:10px; background:#e9eef6; }
  #nostrLogin .nlDivider { text-align:center; color:#6f8192; font-size:11px; }
  #nostrLogin .nlPasteRow { display:flex; gap:6px; }
  #nostrLogin .nlPaste { flex:1; min-width:0; height:34px; border:1px solid #35445e; border-radius:7px; background:#0b0f16; color:#eef4fb; padding:0 10px; }
  #nostrLogin .nlStatus { padding:0 16px 14px; min-height:16px; color:#9fb0c0; font-size:12px; }
  #nostrLogin .nlStatus a { color:#9fe0a0; }`;
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
}

export class NostrLoginModal {
  private overlay!: HTMLElement;
  private contentEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private tabBtns = new Map<Tab, HTMLButtonElement>();
  private active!: Tab;
  private handle: NostrConnectHandle | null = null;
  private pairedViaQr = false;
  private resolve?: (r: NostrLoginResult | null) => void;
  private settled = false;

  open(): Promise<NostrLoginResult | null> {
    injectStyles();
    const hasExt = hasNostrExtension();
    this.active = hasExt ? "extension" : "remote";
    this.build(hasExt);
    document.body.appendChild(this.overlay);
    this.renderTab();
    return new Promise((resolve) => (this.resolve = resolve));
  }

  private finish(result: NostrLoginResult | null) {
    if (this.settled) {
      // A paste connect that resolved after cancel — close its orphan client.
      if (result?.session)
        try {
          result.session.client.close();
        } catch {
          /* ignore */
        }
      return;
    }
    this.settled = true;
    // Tear down the QR pairing unless that's exactly what completed.
    if (!(result?.method === "bunker" && this.pairedViaQr)) this.handle?.cancel();
    this.overlay.remove();
    this.resolve?.(result);
  }

  private setTab(tab: Tab) {
    if (this.active === tab) return;
    // Leaving "remote" without pairing → tear down the relay subscription so it
    // doesn't keep streaming for the full pairing timeout. renderRemote re-creates.
    if (this.active === "remote" && this.handle) {
      this.handle.cancel();
      this.handle = null;
    }
    this.active = tab;
    for (const [t, b] of this.tabBtns) b.className = t === tab ? "nlTab active" : "nlTab";
    this.renderTab();
  }

  private setStatus(msg: string) {
    this.statusEl.textContent = msg;
  }

  private showAuthUrl(url: string) {
    if (this.settled) return; // modal already closed — don't write to a detached node
    this.statusEl.textContent = "Approve in your signer: ";
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "open approval ↗";
    this.statusEl.appendChild(a);
  }

  private renderTab() {
    this.contentEl.innerHTML = "";
    this.setStatus("");
    if (this.active === "extension") this.renderExtension();
    else this.renderRemote();
  }

  private renderExtension() {
    const text = document.createElement("div");
    text.className = "nlText";
    text.textContent = "Sign in with your browser extension (Alby, nos2x, …).";
    const btn = document.createElement("button");
    btn.className = "nlPrimary";
    btn.textContent = "🔌 Connect extension";
    btn.onclick = () => {
      if (!hasNostrExtension()) return this.setStatus("No extension detected — use a remote signer.");
      this.finish({ method: "nip07" });
    };
    this.contentEl.append(text, btn);
  }

  private renderRemote() {
    // Start the client-initiated pairing once; reuse the URI across tab switches.
    if (!this.handle) {
      this.handle = startNostrConnect({
        name: "Gorilator",
        url: location.origin,
        onAuthUrl: (u) => this.showAuthUrl(u),
      });
      this.handle.paired
        .then((s) => {
          this.pairedViaQr = true;
          this.finish({ method: "bunker", session: s });
        })
        .catch((e) => {
          if (!this.settled) this.setStatus((e as Error).message);
        });
    }
    const uri = this.handle.uri;

    const box = document.createElement("div");
    box.className = "nlRemote";
    box.innerHTML = `
      <div class="nlText">Scan with a phone signer, or paste a connection string.</div>
      <canvas class="nlQr" width="200" height="200"></canvas>
      <a class="nlAmber" target="_blank" rel="noopener">📲 Open in Amber</a>
      <button class="nlGhost nlCopy">Copy connection link</button>
      <div class="nlDivider">— or —</div>
      <div class="nlPasteRow"><input class="nlPaste" placeholder="bunker://…" /><button class="nlPrimary nlPasteBtn">Connect</button></div>`;
    this.contentEl.appendChild(box);

    void QRCode.toCanvas(box.querySelector(".nlQr") as HTMLCanvasElement, uri, {
      width: 200,
      margin: 1,
      color: { dark: "#0b0f16", light: "#e9eef6" },
    }).catch(() => this.setStatus("couldn't render QR — use copy/paste"));
    (box.querySelector(".nlAmber") as HTMLAnchorElement).href = uri;
    (box.querySelector(".nlCopy") as HTMLButtonElement).onclick = () =>
      void navigator.clipboard?.writeText(uri).then(() => this.setStatus("copied — paste into your signer"));
    const paste = box.querySelector(".nlPaste") as HTMLInputElement;
    (box.querySelector(".nlPasteBtn") as HTMLButtonElement).onclick = () => void this.onPaste(paste);
    paste.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") void this.onPaste(paste);
    });
    this.setStatus("Waiting for your signer to connect…");
  }

  private async onPaste(input: HTMLInputElement) {
    const v = input.value.trim();
    if (!v) return this.setStatus("Paste a bunker:// connection string first.");
    this.setStatus("Connecting to your signer…");
    try {
      const session = await connectWithBunkerString(v, (u) => this.showAuthUrl(u));
      this.finish({ method: "bunker", session }); // pairedViaQr stays false → QR handle cancelled
    } catch (e) {
      this.setStatus((e as Error).message);
    }
  }

  private build(hasExt: boolean) {
    const overlay = document.createElement("div");
    overlay.id = "nostrLogin";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.finish(null);
    });

    const panel = document.createElement("div");
    panel.className = "nlPanel";

    const head = document.createElement("div");
    head.className = "nlHead";
    head.innerHTML = `<b>Connect Nostr</b>`;
    const close = document.createElement("button");
    close.className = "nlClose";
    close.textContent = "✕";
    close.onclick = () => this.finish(null);
    head.appendChild(close);

    const tabs = document.createElement("div");
    tabs.className = "nlTabs";
    const addTab = (tab: Tab, label: string) => {
      const b = document.createElement("button");
      b.className = tab === this.active ? "nlTab active" : "nlTab";
      b.textContent = label;
      b.onclick = () => this.setTab(tab);
      this.tabBtns.set(tab, b);
      tabs.appendChild(b);
    };
    if (hasExt) addTab("extension", "🔌 Extension");
    addTab("remote", "📡 Remote signer");

    this.contentEl = document.createElement("div");
    this.contentEl.className = "nlContent";
    this.statusEl = document.createElement("div");
    this.statusEl.className = "nlStatus";

    panel.append(head, tabs, this.contentEl, this.statusEl);
    overlay.appendChild(panel);
    this.overlay = overlay;
  }
}

// ---- shared completion (establish → optional server upgrade → persist) -------

export interface CompleteLoginOpts {
  upgrade?: NetworkClient; // in-game: upgrade the live server session in place
  onPhase?: (phase: NostrPhase, detail?: string) => void;
}

/**
 * Finish a login: mount the bunker shim (if any), establish identity, optionally
 * upgrade the server session, then **persist** it (so it's remembered on refresh —
 * see main.ts `restoreSession`). Cleans up the bunker client on failure.
 */
export async function completeLogin(result: NostrLoginResult, opts: CompleteLoginOpts = {}): Promise<NostrIdentity> {
  const prevBunker = getActiveBunkerClient(); // close any superseded client below
  let bunkerClient: BunkerSession["client"] | null = null;
  let bunkerInfo: { clientSecretKey: string; remotePubkey: string; relays: string[]; secret?: string } | null = null;
  if (result.method === "bunker" && result.session) {
    installBunkerSigner(result.session.client);
    bunkerClient = result.session.client;
    bunkerInfo = {
      clientSecretKey: result.session.clientSecretKeyHex,
      remotePubkey: result.session.remotePubkey,
      relays: result.session.relays,
      secret: result.session.secret ?? undefined,
    };
  }
  try {
    const identity = await establishNostrIdentity(opts.onPhase);
    if (opts.upgrade) {
      const auth = await signNostrAuth(opts.onPhase);
      await opts.upgrade.upgradeNostr({ auth, profile: identity.profile });
    }
    saveSession(
      bunkerInfo
        ? { v: 1, method: "bunker", pubkey: identity.pubkey, npub: identity.npub, meta: identity.meta, bunker: bunkerInfo }
        : { v: 1, method: "nip07", pubkey: identity.pubkey, npub: identity.npub, meta: identity.meta },
    );
    setActiveSession(identity, bunkerClient);
    // Close a previously-active bunker client we just replaced (avoid a leak).
    if (prevBunker && prevBunker !== bunkerClient) {
      try {
        prevBunker.close();
      } catch {
        /* ignore */
      }
    }
    return identity;
  } catch (e) {
    if (bunkerClient) {
      try {
        bunkerClient.close();
      } catch {
        /* ignore */
      }
      if (typeof window !== "undefined") delete window.nostr;
    }
    throw e;
  }
}

/**
 * Ensure the player is logged in, prompting the unified modal IN-GAME if needed and
 * upgrading the live server session. Returns the identity, or null if cancelled.
 */
export async function ensureNostrLogin(net: NetworkClient): Promise<NostrIdentity | null> {
  const existing = getActiveIdentity();
  if (existing) return existing;
  const result = await new NostrLoginModal().open();
  if (!result) return null;
  return completeLogin(result, { upgrade: net });
}
