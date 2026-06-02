import { CHAT_MAX_LEN } from "@rpg/shared";

/**
 * RPG chat with two modes:
 *
 *  - **Passive** (default): the message log floats as semi-transparent text on the
 *    right. It's unobtrusive but readable — hovering it restores full opacity.
 *  - **Active** ("chat mode"): clicking the log (or pressing ENTER) expands it into
 *    a centered classic-chat window with the input docked at the bottom. ENTER
 *    sends and *restores* the input (clears + refocuses) so you can keep chatting;
 *    ESC, an empty ENTER, or a click outside the window returns to passive.
 *
 * The floating speech bubbles over characters are handled separately by the HUD
 * (see HUD.showChatBubble); both the bubbles and this log are fed by the same
 * server "chat" broadcast.
 */
export class ChatLog {
  private dock: HTMLDivElement;
  private log: HTMLDivElement;
  private input: HTMLInputElement;
  private backdrop: HTMLDivElement;
  private mode: "passive" | "active" = "passive";
  private stayOpenOnSend = false; // true → sending keeps chat open (click sessions)

  constructor(private onSend: (text: string) => void) {
    injectChatStyles();

    // Transparent full-screen catcher behind the centered window: a click outside
    // the chat window (while in chat mode) returns to passive. Game stays visible.
    this.backdrop = document.createElement("div");
    this.backdrop.id = "chatBackdrop";
    this.backdrop.addEventListener("mousedown", () => this.close());

    this.dock = document.createElement("div");
    this.dock.id = "chatDock";

    this.log = document.createElement("div");
    this.log.id = "chatLog";

    this.input = document.createElement("input");
    this.input.id = "chatInput";
    this.input.maxLength = CHAT_MAX_LEN;
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.input.placeholder = "Type a message — Enter to send, Esc to close";

    this.dock.append(this.log, this.input);
    document.body.append(this.backdrop, this.dock);

    // While in chat mode, keep the input focused even when clicking the log area,
    // so you can always type (clicking the input itself still behaves normally).
    this.dock.addEventListener("mousedown", (e) => {
      if (this.mode === "active" && e.target !== this.input) e.preventDefault();
    });

    // Clicking the chat component: from passive it opens chat mode; while already
    // open it marks this a "click" session, so sending keeps it open — even if it
    // was first opened via Enter.
    this.dock.addEventListener("click", () => {
      if (this.mode === "passive") this.open("click");
      else this.stayOpenOnSend = true;
    });

    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      if (e.key === "Enter") {
        if (this.mode === "active") return; // the input's own handler owns ENTER
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return; // typing elsewhere
        if (document.body.classList.contains("preGame")) return; // still on the splash
        e.preventDefault();
        this.open("enter");
      } else if (e.key === "Escape" && this.mode === "active") {
        this.close(); // ESC from anywhere leaves chat mode
      }
    });

    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        this.send();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
  }

  /** Expand the log into the centered chat window and focus the input. Opening via
   *  "enter" is a quick one-liner (auto-closes on send); via "click" it's a
   *  sustained session that stays open after each message. */
  private open(via: "enter" | "click") {
    this.mode = "active";
    this.stayOpenOnSend = via === "click";
    this.dock.classList.add("active");
    this.backdrop.classList.add("active");
    this.input.value = "";
    this.input.focus();
    this.log.scrollTop = this.log.scrollHeight; // show the newest line
  }

  /** Collapse back to the passive, semi-transparent overlay. */
  private close() {
    if (this.mode !== "active") return;
    this.mode = "passive";
    this.dock.classList.remove("active");
    this.backdrop.classList.remove("active");
    this.input.value = "";
    this.input.blur();
    this.log.scrollTop = this.log.scrollHeight;
  }

  private send() {
    const text = this.input.value.trim();
    if (!text) {
      this.close(); // empty line + Enter dismisses chat mode (classic behaviour)
      return;
    }
    this.onSend(text);
    if (this.stayOpenOnSend) {
      // Click-opened session: clear + keep focus so you can keep chatting.
      this.input.value = "";
      this.input.focus();
    } else {
      this.close(); // Enter-opened quick line: auto-close after sending.
    }
  }

  /** Append a received chat line to the log (newest at the bottom). Nostr senders
   *  (signature-verified) get their avatar on the left and a roomier, tinted row. */
  add(
    name: string,
    text: string,
    isSelf: boolean,
    identity?: { picture?: string; nostrVerified?: boolean },
  ) {
    const line = document.createElement("div");
    line.className = "chatLine";

    if (identity?.nostrVerified) {
      line.classList.add("nostr");
      const avatar = document.createElement("span");
      avatar.className = "chatAvatar";
      if (identity.picture) {
        const img = document.createElement("img");
        img.referrerPolicy = "no-referrer"; // some nostr image hosts block hotlinking
        img.alt = "";
        img.onerror = () => {
          avatar.textContent = "🦍"; // broken URL → gorilla fallback
          img.remove();
        };
        img.src = identity.picture;
        avatar.appendChild(img);
      } else {
        avatar.textContent = "🦍"; // verified but no picture → gorilla fallback
      }
      line.appendChild(avatar);
    }

    const body = document.createElement("span");
    body.className = "chatBody";
    const who = document.createElement("span");
    who.className = isSelf ? "chatNameSelf" : "chatName";
    who.textContent = `${name}: `;
    body.append(who, document.createTextNode(text));
    line.appendChild(body);

    this.log.appendChild(line);
    // Cap the history so the DOM doesn't grow without bound over a long session.
    while (this.log.childElementCount > 80) this.log.firstElementChild?.remove();
    this.log.scrollTop = this.log.scrollHeight; // keep the latest line in view
  }
}

/** Inject the chat CSS once: passive faded overlay (hover to read, click to open)
 *  and the centered "chat mode" window with the input docked at the bottom. */
function injectChatStyles() {
  if (document.getElementById("chatLogStyles")) return;
  const style = document.createElement("style");
  style.id = "chatLogStyles";
  style.textContent = `
    /* Click-catcher behind the centered window (transparent — game stays visible). */
    #chatBackdrop {
      position: fixed;
      inset: 0;
      z-index: 44;
      display: none;
      pointer-events: none;
    }
    #chatBackdrop.active { display: block; pointer-events: auto; }

    /* ---- passive overlay (default): faded floating text, right side ---- */
    #chatDock {
      position: fixed;
      z-index: 45;
      right: 12px;
      top: 46px;
      width: min(34vw, 340px);
      display: flex;
      flex-direction: column;
      gap: 6px;
      pointer-events: none; /* only the log catches events; empty area passes through */
      font: 500 13px/1.42 system-ui, -apple-system, sans-serif;
    }
    /* The history sizes to its content: ~0 when empty, growing with each message
       up to max-height, then it caps and scrolls (newest kept in view by add()). */
    #chatLog {
      overflow-y: auto;
      max-height: 40vh;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 6px 8px;
      border-radius: 8px;
      background: transparent;
      opacity: 0.45;
      pointer-events: auto;
      cursor: pointer;
      transition: opacity 0.18s ease, background 0.18s ease;
      scrollbar-width: thin;
    }
    /* Recover full opacity (and a faint backing) on hover — passive mode only. */
    #chatDock:not(.active) #chatLog:hover {
      opacity: 1;
      background: rgba(10, 9, 12, 0.42);
    }
    .chatLine {
      color: #e8ecf3;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.95), 0 0 2px rgba(0, 0, 0, 0.85);
      overflow-wrap: anywhere;
    }
    .chatName { color: #bcd3ee; font-weight: 700; }
    .chatNameSelf { color: #ffe08a; font-weight: 700; }

    /* Nostr (signature-verified) senders: avatar on the left + a roomier, faintly
       purple-tinted row so their messages stand out and take a bit more space. */
    .chatLine.nostr {
      display: flex;
      align-items: flex-start;
      gap: 7px;
      margin: 3px 0;
      padding: 4px 6px;
      border-radius: 8px;
      background: rgba(168, 111, 224, 0.14);
      box-shadow: inset 0 0 0 1px rgba(168, 111, 224, 0.22);
    }
    .chatLine.nostr .chatBody { flex: 1 1 auto; min-width: 0; }
    .chatAvatar {
      flex: none;
      width: 22px;
      height: 22px;
      margin-top: 1px;
      border-radius: 50%;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      line-height: 1;
      background: radial-gradient(circle at 50% 35%, #3a2a1a, #160f08);
      border: 1.5px solid #a86fe0;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);
    }
    .chatAvatar img { width: 100%; height: 100%; object-fit: cover; display: block; }

    #chatInput {
      flex: 0 0 auto;
      display: none; /* hidden in passive mode */
      pointer-events: auto;
      padding: 10px 13px;
      font: 600 15px system-ui, -apple-system, sans-serif;
      color: #fff;
      background: rgba(8, 6, 10, 0.96);
      border: 2px solid #6b4f2e;
      border-radius: 9px;
      outline: none;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.55);
      transition: border-color 0.18s, box-shadow 0.18s;
    }
    #chatInput::placeholder { color: #8a7a5c; }
    #chatInput:focus {
      border-color: #ffd479;
      box-shadow: 0 0 0 1px #ffd479, 0 0 16px rgba(255, 170, 40, 0.25);
    }

    /* ---- active "chat mode": centered classic-chat window ---- */
    #chatDock.active {
      right: auto;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: min(92vw, 560px);
      height: auto; /* size to the log + input, not a fixed box */
      max-height: min(78vh, 500px);
      padding: 12px;
      gap: 10px;
      background: rgba(14, 11, 16, 0.94);
      border: 2px solid #6b4f2e;
      border-radius: 14px;
      box-shadow: 0 18px 54px rgba(0, 0, 0, 0.66), inset 0 0 24px rgba(0, 0, 0, 0.4);
      pointer-events: auto;
      /* Semi-transparent while open so it doesn't block the view; hovering the
         window (see :hover below) restores full opacity to read/type clearly. */
      opacity: 0.62;
      transition: opacity 0.18s ease;
      animation: chatPop 0.16s ease-out;
    }
    #chatDock.active:hover { opacity: 1; }
    #chatDock.active #chatLog {
      flex: 0 1 auto; /* grow with content, don't stretch to fill the window */
      min-height: 0;
      max-height: min(60vh, 380px);
      opacity: 1;
      cursor: default;
      background: transparent;
      padding: 2px 4px;
    }
    #chatDock.active #chatInput { display: block; }

    @keyframes chatPop {
      from { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
      to   { opacity: 0.62; transform: translate(-50%, -50%) scale(1); }
    }

    /* Hidden during the intro / character-select splash. */
    body.preGame #chatDock, body.preGame #chatBackdrop { display: none !important; }
  `;
  document.head.appendChild(style);
}
