import {
  Engine,
  Scene,
  ArcRotateCamera,
  Vector3,
  Color3,
  Color4,
  HemisphericLight,
  DirectionalLight,
  PointLight,
  MeshBuilder,
  Mesh,
  StandardMaterial,
  DynamicTexture,
  ParticleSystem,
  ShadowGenerator,
} from "@babylonjs/core";
import { AnimState } from "@rpg/shared";
import { SpawnedCharacter } from "../entities/types";
import { CharacterFactory } from "../entities/CharacterFactory";
import { AnimationController } from "../entities/AnimationController";
import {
  nostrLogin,
  hasNostrExtension,
  NostrCredentials,
  NostrPhase,
} from "../net/nostr";

/** What the player commits at the splash: a name, optionally a verified Nostr id
 *  (the full credentials — main.ts derives the server join payload from them). */
export interface SplashCredentials {
  name: string;
  nostr?: NostrCredentials;
}

/** Passed to CharacterFactory.spawn; ignored by the textured glb (and dummy). */
const HERO_ACCENT = new Color3(0.98, 0.78, 0.28);
/** The splash hero is shown bigger than its in-game (1×) size for a bolder pose. */
const SPLASH_HERO_SCALE = 1.7;

/**
 * The intro / character-select splash. It runs its own lightweight Babylon scene
 * (sharing the game's engine) that shows the player's gorilla on a glowing
 * pedestal — slowly turntabling, breathing, wreathed in rising embers. The DOM
 * overlay (see index.html) holds the title, the champion roster and the name
 * prompt. When the player commits a name, `playLaunch()` performs a cinematic
 * hand-off: the gorilla rears back into an overhead slam, the camera punches in
 * with a shake, a gold shockwave rings out, and a white flash masks the cut into
 * the live game.
 */
export class SplashScreen {
  /** The splash's own scene. The main render loop draws it while `active`. */
  readonly scene: Scene;
  /** True until the launch flash has masked the swap to the live game scene. */
  active = true;

  private readonly camera: ArcRotateCamera;
  /** The hero on the pedestal — the in-game rigged glb gorilla, loaded async
   *  (see loadHero); undefined for the brief moment before it arrives. */
  private hero?: SpawnedCharacter;
  /** Clip FSM when the hero is the rigged glb model; undefined for procedural. */
  private heroAnim?: AnimationController;
  private heroFactory?: CharacterFactory;
  private slamPlayed = false; // one-shot guard for the launch slam clip
  private readonly shadow: ShadowGenerator;
  private ring?: Mesh;
  private embers?: ParticleSystem;

  private readonly baseRadius = 9;
  private t = 0; // showcase clock (seconds)
  private spin = 0; // current hero yaw (a gentle sway, kept facing the camera)
  private launching = false;
  private launchT = 0; // seconds since launch began

  // DOM handles
  private readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly enterBtn: HTMLButtonElement;
  private readonly flashEl: HTMLElement;
  private readonly shockEl: HTMLElement;
  private resolveCreds?: (creds: SplashCredentials) => void;

  /** A verified Nostr identity once the player connects one (else anonymous). */
  private nostr?: NostrCredentials;
  /** Times the level-reveal → profile-card hand-off in the logged-in reframe. */
  private revealTimer?: number;

  // ---- connect-progress log (terminal-style, paced flush) ----
  private logQueue: Array<{ text: string; cls: string; pct?: number }> = [];
  private flushTimer?: number;
  private drainResolvers: Array<() => void> = [];
  private relayTicker?: number;

  constructor(engine: Engine) {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.03, 0.03, 0.05, 1);
    scene.ambientColor = new Color3(0.26, 0.22, 0.28);
    this.scene = scene;

    // A static near-eye-level front view of the hero (no user control). The
    // target sits at the chest so the gorilla is framed head-to-shins with the
    // face in the upper-middle, clear of the character tray along the bottom.
    const cam = new ArcRotateCamera(
      "splashCam",
      Math.PI / 2, // looking from +Z → straight at the gorilla's face
      1.28, // a touch above eye level
      this.baseRadius,
      new Vector3(0, 1.5, 0),
      scene,
    );
    cam.fov = 0.72;
    cam.minZ = 0.1;
    this.camera = cam;

    // Warm key + cool sky fill + a crimson rim behind for drama, plus a soft
    // front fill from the camera so the gorilla's dark face/brow always reads.
    const hemi = new HemisphericLight("sHemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.6;
    hemi.groundColor = new Color3(0.12, 0.1, 0.14);
    const key = new DirectionalLight("sKey", new Vector3(-0.6, -1, 0.45), scene);
    key.intensity = 1.45;
    key.diffuse = new Color3(1.0, 0.92, 0.78);
    const rim = new PointLight("sRim", new Vector3(0, 2.6, -3.6), scene);
    rim.intensity = 0.95;
    rim.diffuse = new Color3(1.0, 0.35, 0.2);
    const fill = new PointLight("sFill", new Vector3(0, 2.2, 6), scene);
    fill.intensity = 0.7;
    fill.diffuse = new Color3(1.0, 0.86, 0.7);
    fill.specular = new Color3(0.2, 0.18, 0.14);

    // Soft contact shadow from the key light, cast onto the pedestal — matches
    // the look the hero has in-game.
    key.position = new Vector3(3, 6, -2);
    key.shadowMinZ = 1;
    key.shadowMaxZ = 16;
    this.shadow = new ShadowGenerator(1024, key);
    this.shadow.usePercentageCloserFiltering = true;
    this.shadow.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    this.shadow.bias = 0.006;
    this.shadow.darkness = 0.35;

    this.buildStage();
    try {
      this.embers = this.buildEmbers();
    } catch {
      /* particles are non-essential eye-candy — ignore any failure */
    }
    // Load the in-game rigged gorilla glb onto the pedestal; the stage + embers
    // show immediately and the hero pops in when it's ready.
    void this.loadHero();

    // This is a *secondary* scene on a shared engine. The engine delivers its
    // parallel-shader-compile "ready" callbacks to the primary/active scene, so
    // a secondary scene's StandardMaterials can stay stuck "not ready" forever —
    // the meshes are skipped every frame and the hero never draws (the clear and
    // additive particles still show, which is the tell). Force every material to
    // compile up front so the gorilla renders from the first frame.
    for (const mesh of scene.meshes) {
      mesh.material?.forceCompilation(mesh);
    }

    this.el = document.getElementById("splash") as HTMLElement;
    this.input = document.getElementById("nameInput") as HTMLInputElement;
    this.enterBtn = document.getElementById("enterBtn") as HTMLButtonElement;
    this.flashEl = document.getElementById("splashFlash") as HTMLElement;
    this.shockEl = document.getElementById("splashShockwave") as HTMLElement;
    this.wireDom();
  }

  /** Resolves once the player commits: a name plus any verified Nostr identity. */
  awaitCredentials(): Promise<SplashCredentials> {
    return new Promise((resolve) => {
      this.resolveCreds = resolve;
    });
  }

  /** Advance the hero scene; called each frame by the main loop while `active`. */
  update(dt: number) {
    this.t += dt;
    if (this.launching) {
      this.updateLaunch(dt);
    } else if (this.hero) {
      // A gentle sway rather than a full turntable, so the hero keeps facing the
      // player (a 360° spin would show its back half the time).
      this.spin = Math.sin(this.t * 0.6) * 0.5; // ±29°
      this.hero.root.rotation.y = this.spin;
      // The glb plays a looping Idle clip on its own; a posed model (the dummy
      // fallback) is driven each frame.
      if (!this.heroAnim) this.hero.pose?.(AnimState.IDLE, this.t);
    }
    // Breathing pulse on the pedestal rim.
    if (this.ring) {
      const p = 0.5 + 0.5 * Math.sin(this.t * 2.2);
      (this.ring.material as StandardMaterial).emissiveColor.set(
        1.0,
        0.4 + p * 0.25,
        0.12 + p * 0.12,
      );
    }
  }

  /**
   * Play the cinematic launch and hand off to the live game. `onReveal` fires at
   * the flash's peak — under cover of the white-out — so the caller can swap the
   * render loop over to the game scene before the flash fades away.
   */
  async playLaunch(onReveal?: () => void): Promise<void> {
    this.spin = normalizeAngle(this.spin); // ease toward facing the camera (yaw 0)
    this.launchT = 0;
    this.launching = true;
    this.slamPlayed = false;
    this.el.classList.add("launching");
    if (this.embers) this.embers.emitRate = 60;

    await wait(680); // ≈ the slam's impact frame
    this.flashEl.classList.add("show");
    this.shockEl.classList.add("show");

    await wait(150); // let the white-out fully cover the screen
    this.active = false; // the splash scene stops rendering...
    onReveal?.(); // ...and the caller reveals the live game underneath
    this.flashEl.classList.add("fade");

    await wait(720); // flash fades out, revealing the world
    this.launching = false;
  }

  /** Fade the overlay out, restore the HUD, and tear down the scene. */
  dispose() {
    this.el.classList.add("gone");
    document.body.classList.remove("preGame");
    this.embers?.stop();
    window.setTimeout(() => {
      this.el.remove();
      this.scene.dispose();
    }, 560);
  }

  // ---- hero ----------------------------------------------------------------

  /**
   * Install a hero on the pedestal: dispose any previous one, wire its
   * animation (a clip FSM for the rigged glb, none for the procedural model),
   * register it as a shadow caster, and drop it into idle.
   */
  private setHero(hero: SpawnedCharacter, factory?: CharacterFactory) {
    if (this.hero && this.hero !== hero) {
      this.heroAnim?.dispose();
      this.hero.dispose();
    }
    this.hero = hero;
    if (factory) this.heroFactory = factory;
    hero.root.rotation.y = this.spin;
    this.heroAnim = hero.hasAnims
      ? new AnimationController(hero.groups, hero.speeds)
      : undefined;
    this.heroAnim?.play(AnimState.IDLE);
    for (const m of hero.meshes) {
      this.shadow.addShadowCaster(m, true);
      m.material?.forceCompilation(m); // secondary-scene shader prime (see ctor)
    }
  }

  /**
   * Load the in-game rigged gorilla (knight.glb, via the same CharacterFactory
   * the game uses) onto the pedestal. If the glb is absent the factory hands
   * back the straw-dummy fallback, which still poses fine.
   */
  private async loadHero() {
    try {
      const factory = new CharacterFactory(this.scene);
      await factory.preload({ playerOnly: true });
      if (!this.active) return; // already launched / disposed
      // Show the hero bigger than its in-game size (the gameplay gorilla is 1×).
      this.setHero(factory.spawn("player", HERO_ACCENT, SPLASH_HERO_SCALE), factory);
    } catch (err) {
      console.warn("[splash] hero load failed", err);
    }
  }

  // ---- launch animation ----------------------------------------------------

  private updateLaunch(dt: number) {
    this.launchT += dt;
    const t = this.launchT;

    // Ease the turntable yaw back to face the camera, then hold.
    this.spin += (0 - this.spin) * Math.min(1, dt * 8);
    if (this.hero) {
      this.hero.root.rotation.y = this.spin;
      // The overhead slam. The rigged glb fires its Attack clip once; a posed
      // model is driven on its own clock (raise 0–0.15s, strike 0.15–0.33s),
      // delayed so its impact lands ~0.68s in (when the flash fires).
      if (this.heroAnim) {
        if (!this.slamPlayed) {
          this.heroAnim.play(AnimState.ATTACK);
          this.slamPlayed = true;
        }
      } else {
        this.hero.pose?.(AnimState.ATTACK, Math.max(0, t - 0.32));
      }
    }

    // Camera punch-in, with an extra jolt + shake around the impact.
    const impact = Math.max(0, 1 - Math.abs(t - 0.7) / 0.18); // 0..1 bump at the slam
    let radius = this.baseRadius + (5.4 - this.baseRadius) * easeOut(Math.min(1, t / 1.0));
    radius -= impact * 0.5;
    this.camera.radius = radius;
    const shake = impact * 0.045;
    this.camera.alpha = Math.PI / 2 + Math.sin(t * 90) * shake;
    this.camera.beta = 1.28 + Math.cos(t * 78) * shake * 0.6;

    // A burst of embers off the slam.
    if (this.embers) this.embers.emitRate = 60 + impact * 260;
  }

  // ---- scene props ---------------------------------------------------------

  private buildStage() {
    const s = this.scene;

    const ped = MeshBuilder.CreateCylinder(
      "splashPed",
      { diameterTop: 3.0, diameterBottom: 3.6, height: 0.5, tessellation: 48 },
      s,
    );
    ped.position.y = -0.25;
    const pedMat = new StandardMaterial("splashPedMat", s);
    pedMat.diffuseColor = new Color3(0.09, 0.08, 0.1);
    pedMat.specularColor = new Color3(0.18, 0.15, 0.1);
    ped.material = pedMat;
    ped.receiveShadows = true; // the hero casts a soft contact shadow here

    // Glowing rim (pulsed in update()).
    const ring = MeshBuilder.CreateTorus(
      "splashRing",
      { diameter: 3.05, thickness: 0.08, tessellation: 64 },
      s,
    );
    ring.position.y = 0.01;
    const ringMat = new StandardMaterial("splashRingMat", s);
    ringMat.diffuseColor = new Color3(0, 0, 0);
    ringMat.emissiveColor = new Color3(1.0, 0.55, 0.18);
    ringMat.disableLighting = true;
    ring.material = ringMat;
    this.ring = ring;

    // Soft warm pool of light on the floor under the hero.
    const glow = MeshBuilder.CreateDisc("splashGlow", { radius: 4.4, tessellation: 48 }, s);
    glow.rotation.x = Math.PI / 2;
    glow.position.y = 0.015;
    const glowMat = new StandardMaterial("splashGlowMat", s);
    glowMat.diffuseColor = new Color3(0, 0, 0);
    glowMat.emissiveColor = new Color3(1.0, 0.5, 0.16);
    glowMat.disableLighting = true;
    glowMat.backFaceCulling = false;
    const glowTex = this.radialTexture();
    glowMat.diffuseTexture = glowTex;
    glowMat.diffuseTexture.hasAlpha = true;
    glowMat.useAlphaFromDiffuseTexture = true;
    glow.material = glowMat;
  }

  private buildEmbers(): ParticleSystem {
    const ps = new ParticleSystem("splashEmbers", 160, this.scene);
    ps.particleTexture = this.radialTexture();
    ps.emitter = new Vector3(0, 0.2, 0);
    ps.minEmitBox = new Vector3(-1.6, 0, -1.6);
    ps.maxEmitBox = new Vector3(1.6, 0.25, 1.6);
    ps.color1 = new Color4(1.0, 0.6, 0.2, 0.9);
    ps.color2 = new Color4(1.0, 0.35, 0.12, 0.8);
    ps.colorDead = new Color4(0.4, 0.1, 0.0, 0.0);
    ps.minSize = 0.05;
    ps.maxSize = 0.16;
    ps.minLifeTime = 1.6;
    ps.maxLifeTime = 3.2;
    ps.emitRate = 26;
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.gravity = new Vector3(0, 0.25, 0); // drift upward
    ps.direction1 = new Vector3(-0.15, 0.6, -0.15);
    ps.direction2 = new Vector3(0.15, 1.0, 0.15);
    ps.minEmitPower = 0.2;
    ps.maxEmitPower = 0.6;
    ps.updateSpeed = 0.016;
    ps.start();
    return ps;
  }

  /** A soft radial white→transparent dot, used for the floor glow and embers. */
  private radialTexture(): DynamicTexture {
    const size = 128;
    const tex = new DynamicTexture("splashRadial", size, this.scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(0.5, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    tex.hasAlpha = true;
    tex.update();
    return tex;
  }

  // ---- DOM -----------------------------------------------------------------

  private wireDom() {
    this.input.addEventListener("input", () => this.syncEnter());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.submit();
      }
    });
    this.enterBtn.addEventListener("click", () => this.submit());

    document
      .getElementById("nostrBtn")
      ?.addEventListener("click", () => void this.connectNostr());
    document
      .getElementById("nhDisconnect")
      ?.addEventListener("click", () => this.clearNostr());
    document.getElementById("nhJoin")?.addEventListener("click", () => this.submit());

    // Locked roster slots just wobble — they're a teaser for future champions.
    document.querySelectorAll<HTMLElement>(".charCard.locked").forEach((card) => {
      card.addEventListener("click", () => {
        card.classList.remove("nudge");
        void card.offsetWidth; // reflow so the animation can restart
        card.classList.add("nudge");
      });
    });

    this.syncEnter();
    window.setTimeout(() => this.input.focus(), 60);
  }

  /** ENTER unlocks once there's a name OR a connected Nostr identity. */
  private syncEnter() {
    this.enterBtn.disabled = this.input.value.trim().length === 0 && !this.nostr;
  }

  /** Run the NIP-07 login behind a terminal-style progress log, then reframe. */
  private async connectNostr() {
    const status = document.getElementById("nostrStatus") as HTMLElement;
    if (!hasNostrExtension()) {
      status.textContent = "No Nostr extension found — install Alby or nos2x.";
      return;
    }
    this.startProgress();
    try {
      const creds = await nostrLogin((phase, detail) => this.onNostrPhase(phase, detail));
      this.stopRelayTicker();
      this.npLog("✓ identity verified", "ok", 100);
      await this.whenDrained();
      await wait(400);
      this.nostr = creds;
      this.el.classList.remove("connecting");
      this.showNostrProfile(creds);
      this.syncEnter();
    } catch (err) {
      this.stopRelayTicker();
      this.npLog(`✗ ${err instanceof Error ? err.message : "login failed"}`, "err", 100);
      await this.whenDrained();
      await wait(1500);
      this.el.classList.remove("connecting");
      status.textContent = err instanceof Error ? err.message : "Nostr login failed.";
    }
  }

  // ---- connect progress ----------------------------------------------------

  private startProgress() {
    this.logQueue = [];
    this.drainResolvers = [];
    this.stopRelayTicker();
    if (this.flushTimer !== undefined) window.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    (document.getElementById("npLog") as HTMLElement).innerHTML = "";
    this.npBar(0);
    this.el.classList.add("connecting");
    this.npLog("» initializing handshake", "dim", 4);
  }

  /** Queue a log line (+ optional progress target); lines flush at a fixed pace
   *  so the steps visibly "type out" even when the real work finishes instantly. */
  private npLog(text: string, cls: "dim" | "work" | "ok" | "err" = "work", pct?: number) {
    this.logQueue.push({ text, cls, pct });
    if (this.flushTimer === undefined) this.flushNext();
  }

  private flushNext() {
    const item = this.logQueue.shift();
    if (!item) {
      this.flushTimer = undefined;
      const resolvers = this.drainResolvers;
      this.drainResolvers = [];
      resolvers.forEach((r) => r());
      return;
    }
    const log = document.getElementById("npLog");
    if (log) {
      const line = document.createElement("div");
      line.className = `npLine ${item.cls}`;
      line.textContent = item.text;
      log.appendChild(line);
      while (log.childElementCount > 9) log.firstElementChild?.remove();
    }
    if (item.pct !== undefined) this.npBar(item.pct);
    this.flushTimer = window.setTimeout(() => this.flushNext(), 115);
  }

  /** Resolve once every queued line has been shown. */
  private whenDrained(): Promise<void> {
    if (this.flushTimer === undefined && this.logQueue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainResolvers.push(resolve));
  }

  private npBar(pct: number) {
    const bar = document.getElementById("npBar") as HTMLElement | null;
    if (bar) bar.style.width = `${pct}%`;
  }

  private onNostrPhase(phase: NostrPhase, detail?: string) {
    switch (phase) {
      case "signer":
        this.npLog("» locating NIP-07 signer", "work", 8);
        break;
      case "pubkey":
        this.npLog("✓ signer connected", "ok", 20);
        if (detail) this.npLog(`  ${detail.slice(0, 16)}…${detail.slice(-5)}`, "dim");
        break;
      case "challenge":
        this.npLog("» requesting one-time challenge", "work", 32);
        break;
      case "challenged":
        this.npLog("✓ challenge received", "ok", 42);
        break;
      case "sign":
        this.npLog("» awaiting signature…", "work", 50);
        break;
      case "signed":
        this.npLog("✓ event signed · kind 22242", "ok", 64);
        break;
      case "relays":
        this.npLog("» connecting to relays", "work", 70);
        this.startRelayTicker();
        break;
      case "profile":
        this.stopRelayTicker();
        if (detail) this.npLog(`✓ profile decoded · ${detail}`, "ok", 92);
        else this.npLog("· no published profile — using npub", "dim", 92);
        break;
      case "done":
        break;
    }
  }

  /** Cosmetic fast lines while pool.get queries the relays (the visible "fetch"). */
  private startRelayTicker() {
    const lines = [
      "→ wss://relay.damus.io",
      "→ wss://nos.lol",
      "→ wss://relay.nostr.band",
      "→ wss://relay.primal.net",
      "» fetching kind:0 metadata",
      "» decoding profile",
    ];
    let i = 0;
    let pct = 72;
    this.relayTicker = window.setInterval(() => {
      if (i >= lines.length) {
        this.stopRelayTicker();
        return;
      }
      this.npLog(lines[i++], "dim", (pct = Math.min(90, pct + 3)));
    }, 180);
  }

  private stopRelayTicker() {
    if (this.relayTicker !== undefined) {
      window.clearInterval(this.relayTicker);
      this.relayTicker = undefined;
    }
  }

  /** Reframe the splash into the logged-in layout. The gorilla's current level
   *  flashes up FIRST; a beat later the profile card (avatar + name + level) and
   *  the big JOIN button rise into place. */
  private showNostrProfile(creds: NostrCredentials) {
    const nameText = document.getElementById("nhNameText") as HTMLElement;
    const img = document.getElementById("nhAvatarImg") as HTMLImageElement;
    nameText.textContent =
      creds.meta.name || `${creds.npub.slice(0, 12)}…${creds.npub.slice(-4)}`;
    if (creds.meta.picture) {
      img.onload = () => (img.style.display = "block");
      img.onerror = () => (img.style.display = "none");
      img.src = creds.meta.picture;
    } else {
      img.style.display = "none";
      img.removeAttribute("src");
    }

    // The gorilla's current level: recovered from the server-signed save, or 1
    // for a brand-new npub. Shown big in the reveal AND in the profile card.
    const level = creds.recovered?.level ?? 1;
    (document.getElementById("nhLevel") as HTMLElement).textContent = `Lv. ${level}`;
    (document.getElementById("nhLevelReveal") as HTMLElement).textContent = `Level ${level}`;

    // `revealing` shows only the big level (CSS holds the card/actions hidden);
    // dropping it after a beat fades the card + JOIN button in.
    this.el.classList.add("nostr", "revealing");
    window.clearTimeout(this.revealTimer);
    this.revealTimer = window.setTimeout(() => this.el.classList.remove("revealing"), 1300);
  }

  private clearNostr() {
    this.nostr = undefined;
    window.clearTimeout(this.revealTimer);
    this.el.classList.remove("nostr", "revealing");
    const btn = document.getElementById("nostrBtn") as HTMLButtonElement;
    btn.hidden = false;
    btn.disabled = false;
    const img = document.getElementById("nhAvatarImg") as HTMLImageElement;
    img.style.display = "none";
    img.removeAttribute("src");
    (document.getElementById("nostrStatus") as HTMLElement).textContent = "";
    this.input.focus();
    this.syncEnter();
  }

  private submit() {
    // Nostr players join under their (verified) display name; anonymous players
    // must type one.
    const name = this.nostr ? this.nostr.meta.name.trim() : this.input.value.trim();
    if (!name && !this.nostr) {
      this.input.classList.remove("shake");
      void this.input.offsetWidth; // restart the shake animation
      this.input.classList.add("shake");
      this.input.focus();
      return;
    }
    if (!this.resolveCreds) return;
    this.enterBtn.disabled = true;
    this.input.disabled = true;
    const resolve = this.resolveCreds;
    this.resolveCreds = undefined;
    resolve({ name, nostr: this.nostr });
  }
}

// ---- small helpers ---------------------------------------------------------

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function easeOut(x: number): number {
  return 1 - Math.pow(1 - x, 3);
}

/** Wrap an angle into (-π, π] so we ease toward the nearest "face camera". */
function normalizeAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  if (r < -Math.PI) r += twoPi;
  return r;
}
