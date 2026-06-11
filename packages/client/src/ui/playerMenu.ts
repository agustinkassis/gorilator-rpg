import type { NostrIdentity } from "../net/nostr";

/** The local player's live synced fields the profile card reads. */
export interface PlayerMenuPlayer {
  name: string;
  level: number;
  picture: string;
  nostrVerified: boolean;
  attack?: number;
  armor?: number;
  hp?: number;
  maxHp?: number;
}

export interface PlayerMenuDeps {
  getIdentity: () => NostrIdentity | null; // active Nostr identity, or null (anonymous)
  getPlayer: () => PlayerMenuPlayer | null; // live synced player (for level/stats)
  onLogout: () => void;
  landingBase?: string; // VITE_LANDING_URL → "view public profile" link
}

/**
 * Clicking the bottom-left player badge opens a small popover (View profile /
 * Logout). "View profile" shows an in-game Nostr profile card; "Logout" leaves the
 * game and returns to the splash. Self-contained styling (matches the dark theme).
 */
export class PlayerMenu {
  private popover: HTMLElement | null = null;
  private modal: HTMLElement | null = null;

  constructor(private deps: PlayerMenuDeps) {
    const badge = document.getElementById("playerBadge");
    badge?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.togglePopover();
    });
  }

  private togglePopover() {
    if (this.popover) return this.closePopover();
    const pop = document.createElement("div");
    pop.style.cssText =
      "position:fixed; left:24px; bottom:180px; z-index:90; min-width:190px; padding:6px;" +
      "background:#10131af7; border:1px solid #4a5b72; border-radius:10px; box-shadow:0 12px 40px #000c;" +
      "font:13px/1.4 system-ui,sans-serif; display:flex; flex-direction:column; gap:4px;";
    pop.append(
      this.item("👤", "View profile", () => {
        this.closePopover();
        this.openProfile();
      }),
      this.item("🚪", "Logout", () => {
        this.closePopover();
        this.deps.onLogout();
      }, true),
    );
    document.body.appendChild(pop);
    this.popover = pop;
    // Close on any outside click / Esc (both removed in closePopover).
    setTimeout(() => {
      window.addEventListener("click", this.onOutside);
      window.addEventListener("keydown", this.onEsc);
    }, 0);
  }

  private onOutside = () => this.closePopover();
  private onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.closePopover();
  };

  private closePopover() {
    this.popover?.remove();
    this.popover = null;
    window.removeEventListener("click", this.onOutside);
    window.removeEventListener("keydown", this.onEsc);
  }

  private item(icon: string, label: string, onClick: () => void, danger = false): HTMLButtonElement {
    const b = document.createElement("button");
    b.innerHTML = `<span style="width:20px; text-align:center;">${icon}</span><span>${label}</span>`;
    b.style.cssText =
      "display:flex; align-items:center; gap:8px; cursor:pointer; text-align:left; padding:8px 10px;" +
      `border:1px solid transparent; border-radius:7px; background:transparent; font:600 13px system-ui,sans-serif;` +
      `color:${danger ? "#ff9a8a" : "#e8edf6"};`;
    b.onmouseenter = () => {
      b.style.background = danger ? "#3a2230" : "#222a38";
      b.style.borderColor = danger ? "#e0563f" : "#4a5b72";
    };
    b.onmouseleave = () => {
      b.style.background = "transparent";
      b.style.borderColor = "transparent";
    };
    b.onclick = (e) => {
      e.stopPropagation();
      onClick();
    };
    return b;
  }

  // ---- profile modal -------------------------------------------------------

  private openProfile() {
    const id = this.deps.getIdentity();
    const p = this.deps.getPlayer();
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed; inset:0; z-index:200; display:grid; place-items:center;" +
      "background:rgba(6,8,12,0.66); backdrop-filter:blur(3px); font:13px/1.5 system-ui,sans-serif;";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.closeModal();
    });

    const panel = document.createElement("div");
    panel.style.cssText =
      "width:min(380px, calc(100vw - 32px)); color:#e8eef6; background:linear-gradient(180deg,#181c26,#0e1118);" +
      "border:2px solid #4a9a52; border-radius:14px; box-shadow:0 18px 60px #000c; overflow:hidden;";

    const picture = id?.meta.picture || p?.picture || "";
    const name = id?.meta.name || p?.name || "Player";
    const npub = id?.npub || "";
    const stats = p
      ? `Lv. ${p.level}${p.maxHp != null ? ` · ${Math.round(p.hp ?? p.maxHp)}/${Math.round(p.maxHp)} HP` : ""}${
          p.attack != null ? ` · ${Math.round(p.attack)} ATK` : ""
        }${p.armor != null ? ` · ${Math.round(p.armor)} DEF` : ""}`
      : "";

    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:#1c2230; border-bottom:1px solid #283245;">
        <b style="color:#9fe0a0; font-size:14px;">Profile</b>
        <button id="pmClose" style="cursor:pointer; background:#26303f; color:#fff; border:1px solid #4a5b72; border-radius:6px; padding:3px 9px;">✕</button>
      </div>
      <div style="padding:16px; display:flex; gap:14px; align-items:center;">
        <div style="width:72px; height:72px; border-radius:50%; overflow:hidden; border:2px solid #4a9a52; background:#223149; display:grid; place-items:center; font-size:34px; flex:0 0 auto;">
          ${picture ? `<img src="${esc(picture)}" referrerpolicy="no-referrer" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none';this.parentNode.textContent='🦍';"/>` : "🦍"}
        </div>
        <div style="min-width:0;">
          <div style="font-weight:800; font-size:16px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(name)}${
            p?.nostrVerified ? ' <span style="color:#9fe0a0;">⚡</span>' : ""
          }</div>
          ${stats ? `<div style="color:#9fb0c0; font-size:12px; margin-top:2px;">${esc(stats)}</div>` : ""}
          ${id?.meta.nip05 ? `<div style="color:#9fe0a0; font-size:12px; margin-top:2px;">✔ ${esc(id.meta.nip05)}</div>` : ""}
        </div>
      </div>
      ${id?.meta.about ? `<div style="padding:0 16px 8px; color:#cdd6e3; font-size:12px;">${esc(id.meta.about)}</div>` : ""}
      ${
        npub
          ? `<div style="padding:0 16px 14px; display:flex; flex-direction:column; gap:8px;">
               <div style="display:flex; gap:6px;">
                 <input id="pmNpub" readonly value="${esc(npub)}" style="flex:1; min-width:0; height:30px; border:1px solid #35445e; border-radius:6px; background:#0b0f16; color:#9fb0c0; padding:0 9px; font-size:11px;" />
                 <button id="pmCopy" style="cursor:pointer; background:#26362c; color:#dff5df; border:1px solid #4a5b72; border-radius:6px; padding:0 10px;">Copy</button>
               </div>
               ${
                 this.deps.landingBase
                   ? `<a href="${esc(this.deps.landingBase.replace(/\/+$/, ""))}/profile.html?npub=${esc(npub)}" target="_blank" rel="noopener" style="text-align:center; text-decoration:none; background:#23303f; color:#cfe; border:1px solid #4a5b72; border-radius:6px; padding:8px;">View public profile ↗</a>`
                   : ""
               }
             </div>`
          : `<div style="padding:0 16px 14px; color:#8fa0b5; font-size:12px;">Anonymous player — connect Nostr to get a public profile.</div>`
      }`;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    this.modal = overlay;
    (panel.querySelector("#pmClose") as HTMLButtonElement).onclick = () => this.closeModal();
    const copy = panel.querySelector("#pmCopy") as HTMLButtonElement | null;
    if (copy)
      copy.onclick = () => {
        void navigator.clipboard?.writeText(npub);
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1200);
      };
  }

  private closeModal() {
    this.modal?.remove();
    this.modal = null;
  }
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
