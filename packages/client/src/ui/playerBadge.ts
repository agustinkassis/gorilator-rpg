/** The local player's identity, read off the synced `Player` each frame. */
export interface PlayerIdentity {
  name: string;
  level: number;
  picture: string; // nostr avatar URL ("" → 🦍 fallback)
  nostrVerified: boolean;
}

/**
 * The top-centre identity badge: the player's avatar (their Nostr profile
 * picture, or a 🦍 fallback) next to their name and level, with a ⚡ mark when
 * the name came from a signature-verified Nostr login. Driven from the render
 * loop via `set()`; it only touches the DOM when a value actually changes.
 */
export class PlayerBadge {
  private readonly el: HTMLElement;
  private readonly img: HTMLImageElement;
  private readonly nameText: HTMLElement;
  private readonly levelEl: HTMLElement;
  private readonly verifiedEl: HTMLElement;

  private shownName = "";
  private shownLevel = -1;
  private shownPicture = "";
  private shownVerified = false;

  constructor() {
    this.el = document.getElementById("playerBadge") as HTMLElement;
    this.img = document.getElementById("pbAvatarImg") as HTMLImageElement;
    this.nameText = document.getElementById("pbNameText") as HTMLElement;
    this.levelEl = document.getElementById("pbLevel") as HTMLElement;
    this.verifiedEl = document.getElementById("pbVerified") as HTMLElement;
  }

  set(id: PlayerIdentity) {
    if (this.el.hidden) this.el.hidden = false;

    if (id.name !== this.shownName) {
      this.shownName = id.name;
      this.nameText.textContent = id.name;
    }
    if (id.level !== this.shownLevel) {
      this.shownLevel = id.level;
      this.levelEl.textContent = `Lv. ${id.level}`;
    }
    if (id.nostrVerified !== this.shownVerified) {
      this.shownVerified = id.nostrVerified;
      this.verifiedEl.hidden = !id.nostrVerified;
    }
    if (id.picture !== this.shownPicture) {
      this.shownPicture = id.picture;
      this.setAvatar(id.picture);
    }
  }

  /** Swap the avatar image in; falls back to the 🦍 glyph on empty/broken URLs. */
  private setAvatar(picture: string) {
    if (picture) {
      this.img.onload = () => {
        this.img.style.display = "block";
      };
      this.img.onerror = () => {
        this.img.style.display = "none";
      };
      this.img.src = picture;
    } else {
      this.img.style.display = "none";
      this.img.removeAttribute("src");
    }
  }
}
