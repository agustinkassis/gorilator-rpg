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
  AnimationGroup,
} from "@babylonjs/core";
import { AnimState } from "@rpg/shared";
import { SpawnedCharacter } from "../entities/types";
import { CharacterFactory } from "../entities/CharacterFactory";
import { AnimationController } from "../entities/AnimationController";
import {
  nostrLogin,
  hasNostrExtension,
  nip98AuthHeader,
  NostrCredentials,
  NostrPhase,
} from "../net/nostr";

/** What the player commits at the splash: a name, optionally a verified Nostr id
 *  (the full credentials — main.ts derives the server join payload from them). */
export interface SplashCredentials {
  name: string;
  nostr?: NostrCredentials;
}

export interface SplashScreenOptions {
  onBootProgress?: (pct: number, label?: string) => void;
}

/** Passed to CharacterFactory.spawn; ignored by the textured glb (and dummy). */
const HERO_ACCENT = new Color3(0.98, 0.78, 0.28);
/** The splash hero is shown bigger than its in-game (1×) size for a bolder pose. */
const SPLASH_HERO_SCALE = 1.7;
const ATTACK_IMPACT_FRACTION = 0.7;
const FALLBACK_ATTACK_SECONDS = 0.9;
const IMPACT_TO_FLASH_MS = 260;
const FLASH_COVER_MS = 150;
const IMPACT_FX_MS = 520;

/**
 * The intro splash. It runs its own lightweight Babylon scene
 * (sharing the game's engine) that shows the player's gorilla on a glowing
 * pedestal — slowly turntabling, breathing, wreathed in rising embers. The DOM
 * overlay (see index.html) holds the title and the name prompt. When the player
 * commits a name, `playLaunch()` performs a cinematic
 * hand-off: the gorilla snaps into its attack animation, the camera punches
 * in with a floor-impact shake, a gold shockwave rings out, and a white flash
 * masks the cut into the live game.
 */
export class SplashScreen {
  /** The splash's own scene. The main render loop draws it while `active`. */
  readonly scene: Scene;
  /** Resolves once the splash-only scene/hero assets are ready to reveal. */
  readonly ready: Promise<void>;
  /** True until the launch flash has masked the swap to the live game scene. */
  active = true;

  private readonly camera: ArcRotateCamera;
  /** The hero on the pedestal — the in-game rigged glb gorilla, loaded async
   *  (see loadHero); undefined for the brief moment before it arrives. */
  private hero?: SpawnedCharacter;
  /** Clip FSM when the hero is the rigged glb model; undefined for procedural. */
  private heroAnim?: AnimationController;
  private heroFactory?: CharacterFactory;
  private attackPlayed = false; // one-shot guard for the launch attack clip
  private readonly shadow: ShadowGenerator;
  private ring?: Mesh;
  private embers?: ParticleSystem;

  private readonly baseRadius = 9;
  private t = 0; // showcase clock (seconds)
  private spin = 0; // current hero yaw (a gentle sway, kept facing the camera)
  private launching = false;
  private launchT = 0; // seconds since launch began
  private launchAttackDuration = FALLBACK_ATTACK_SECONDS;
  private launchImpactAt = FALLBACK_ATTACK_SECONDS * ATTACK_IMPACT_FRACTION;
  private impactFxTimer?: number;
  private launchAttackStart?: () => void;

  // DOM handles
  private readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly enterBtn: HTMLButtonElement;
  private readonly flashEl: HTMLElement;
  private readonly shockEl: HTMLElement;
  private readonly assetLoadEl: HTMLElement;
  private readonly assetBarEl: HTMLElement;
  private readonly assetPctEl: HTMLElement;
  private readonly assetStatusEl: HTMLElement;
  private resolveCreds?: (creds: SplashCredentials) => void;
  private assetTargetPct = 0;
  private assetShownPct = 0;

  /** A verified Nostr identity once the player connects one (else anonymous). */
  private nostr?: NostrCredentials;
  /** Times the level-reveal → profile-card hand-off in the logged-in reframe. */
  private revealTimer?: number;

  // ---- update-available actions (admin "Update now" / CLI hint) ----
  /** The server base URL, kept so the action UI can call /api/admin/* + poll. */
  private updateHttpBase?: string;
  /** True once /api/update reported a newer release (banner shown). */
  private updateIsAvailable = false;
  /** Guards against re-triggering the self-update once it's in flight. */
  private updateRunning = false;

  // ---- connect-progress log (terminal-style, paced flush) ----
  private logQueue: Array<{ text: string; cls: string; pct?: number }> = [];
  private flushTimer?: number;
  private drainResolvers: Array<() => void> = [];
  private relayTicker?: number;

  constructor(engine: Engine, opts: SplashScreenOptions = {}) {
    const setBootProgress = (pct: number, label?: string) =>
      opts.onBootProgress?.(Math.max(0, Math.min(100, pct)), label);
    setBootProgress(8, "lighting the black box");

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
    setBootProgress(34, "polishing the boss entrance");
    try {
      this.embers = this.buildEmbers();
    } catch {
      /* particles are non-essential eye-candy — ignore any failure */
    }
    setBootProgress(44, "teaching sparks to flirt");
    // Load the in-game rigged gorilla glb onto the pedestal; the stage + embers
    // are kept behind the bootstrap loader until the hero is ready.
    this.ready = this.loadHero(setBootProgress)
      .catch((err) => {
        console.warn("[splash] hero load failed", err);
      })
      .finally(() => {
        setBootProgress(72, "model signed the release waiver");
      });

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
    this.assetLoadEl = document.getElementById("assetLoad") as HTMLElement;
    this.assetBarEl = document.getElementById("assetBar") as HTMLElement;
    this.assetPctEl = document.getElementById("assetPct") as HTMLElement;
    this.assetStatusEl = document.getElementById("assetStatus") as HTMLElement;
    this.wireDom();
  }

  /** Resolves once the player commits: a name plus any verified Nostr identity. */
  awaitCredentials(): Promise<SplashCredentials> {
    return new Promise((resolve) => {
      this.resolveCreds = resolve;
    });
  }

  /**
   * Poll the daemon's `/api/update` and, when a newer release than the running
   * server exists, reveal the splash's dismissible "update available" banner
   * (a link to the GitHub release). Silent on any error — offline, not
   * configured, or already up to date all simply leave the banner hidden.
   */
  async showUpdateBanner(httpBase: string): Promise<void> {
    this.updateHttpBase = httpBase;
    const banner = document.getElementById("updateBanner") as HTMLElement | null;
    if (!banner) return;
    try {
      const res = await fetch(`${httpBase}/api/update`, { cache: "no-store" });
      if (!res.ok) return;
      const s = (await res.json()) as {
        updateAvailable?: boolean;
        current?: { version?: string } | null;
        latest?: { tag?: string; name?: string; url?: string } | null;
      };
      if (!s.updateAvailable || !s.latest) return;

      const text = document.getElementById("updateBannerText");
      // Name the running server's version too, so it's clear the gap is the
      // server you're connected to — not (e.g.) the checkout you're developing in.
      const installed = s.current?.version ? ` (server on ${s.current.version})` : "";
      if (text) text.textContent = `Update available — ${s.latest.tag ?? "new release"}${installed}`;
      // The banner links straight to the GitHub release page for this update.
      const link = document.getElementById("updateBannerLink") as HTMLAnchorElement | null;
      if (link && s.latest.url) link.href = s.latest.url;
      banner.hidden = false;
      banner.classList.add("show");
      // Size the actions column (button / hint / progress) to the banner pill's
      // width so the "Update now" button spans the full width of the alert.
      const actions = document.getElementById("updateActions");
      if (actions) actions.style.width = `${Math.round(banner.getBoundingClientRect().width)}px`;
      // Slide the splash title down so the alert sits in clear space above it.
      this.el.classList.add("has-update");
      this.setTitleShift(true);
      document.getElementById("updateBannerClose")?.addEventListener("click", () => {
        banner.classList.remove("show");
        banner.hidden = true;
        this.el.classList.remove("has-update");
        this.setTitleShift(false);
        document.getElementById("updateActions")?.setAttribute("hidden", "");
      });

      this.updateIsAvailable = true;
      this.wireUpdateButton();
      void this.refreshUpdateActions();
    } catch {
      /* offline / not configured / up to date — leave the banner hidden */
    }
  }

  /**
   * Slide the splash title + subtitle down (or restore them) so the update
   * banner + actions have clear space above the giant title. The title carries
   * a decorative rotate/skew transform, so we compose the downward translate
   * onto its current transform and apply it inline with `!important` — which
   * reliably wins the cascade (a stylesheet rule gets overridden here).
   */
  private setTitleShift(on: boolean): void {
    const px = window.innerHeight < 620 ? 80 : 108;
    for (const id of ["splashTitle", "splashSub"]) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.style.removeProperty("transform");
      if (on) {
        const base = getComputedStyle(el).transform;
        const composed = `translateY(${px}px)` + (base && base !== "none" ? ` ${base}` : "");
        el.style.setProperty("transform", composed, "important");
      }
    }
  }

  /** Wire the "Update now" button once (clicking runs the admin self-update). */
  private wireUpdateButton(): void {
    const btn = document.getElementById("updateAdminBtn") as HTMLButtonElement | null;
    if (btn && !btn.dataset.wired) {
      btn.dataset.wired = "1";
      btn.addEventListener("click", () => void this.runSelfUpdate());
    }
  }

  /**
   * Decide what to show under the update banner:
   *  - logged in via Nostr AND that npub is a server admin AND the server can
   *    self-update → the "Update now" button;
   *  - otherwise → the CLI hint (`gorilator update`).
   * Called on load and again whenever the Nostr login state changes.
   */
  private async refreshUpdateActions(): Promise<void> {
    if (!this.updateIsAvailable || this.updateRunning) return;
    const actions = document.getElementById("updateActions");
    const btn = document.getElementById("updateAdminBtn") as HTMLButtonElement | null;
    const hint = document.getElementById("updateCliHint");
    if (!actions || !btn || !hint) return;

    actions.removeAttribute("hidden");
    const showCli = () => {
      btn.hidden = true;
      hint.hidden = false;
    };
    // Not logged in (or no signer) → only the CLI instruction.
    if (!this.nostr || !hasNostrExtension()) {
      showCli();
      return;
    }
    // Logged in: ask the server (NIP-98) whether this key is an admin that can
    // trigger a self-update. Default to the CLI hint until we know / on failure.
    showCli();
    try {
      const base = this.updateHttpBase ?? "";
      const header = await nip98AuthHeader(`${base}/api/admin/whoami`, "get");
      const res = await fetch(`${base}/api/admin/whoami`, { headers: { Authorization: header } });
      if (!res.ok) return;
      const who = (await res.json()) as { isAdmin?: boolean; selfUpdate?: boolean };
      if (who.isAdmin && who.selfUpdate) {
        btn.hidden = false;
        hint.hidden = true;
      }
    } catch {
      /* signer declined / offline → keep the CLI hint */
    }
  }

  /**
   * Admin self-update: POST /api/admin/update (NIP-98), then show a progress bar
   * while the daemon restarts. We poll /healthz; once the server has gone down
   * and come back up on the new build, reload the page to load it.
   */
  private async runSelfUpdate(): Promise<void> {
    if (this.updateRunning) return;
    const base = this.updateHttpBase ?? "";
    const btn = document.getElementById("updateAdminBtn") as HTMLButtonElement | null;
    const hint = document.getElementById("updateCliHint");
    const prog = document.getElementById("updateProgress");
    const fill = document.getElementById("updateProgressFill") as HTMLElement | null;
    const status = document.getElementById("updateProgressStatus");
    const setStatus = (t: string) => status && (status.textContent = t);
    const setFill = (pct: number) => fill && (fill.style.width = `${Math.min(100, pct)}%`);

    this.updateRunning = true;
    if (btn) {
      btn.disabled = true;
      btn.hidden = true; // only the progress shows while updating
    }
    if (hint) hint.hidden = true;
    if (prog) prog.hidden = false;
    setStatus("Authorizing…");
    setFill(4);

    try {
      const header = await nip98AuthHeader(`${base}/api/admin/update`, "post");
      const res = await fetch(`${base}/api/admin/update`, { method: "POST", headers: { Authorization: header } });
      if (res.status !== 202) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `update failed (${res.status})`);
      }
    } catch (err) {
      setStatus(`Couldn't start update: ${err instanceof Error ? err.message : "error"}`);
      this.updateRunning = false;
      if (prog) prog.hidden = true;
      if (btn) {
        btn.disabled = false;
        btn.hidden = false; // let the admin retry
      }
      return;
    }

    setStatus("Update started — the server will restart…");
    setFill(12);

    // Progress is unknowable from the client (the server goes away), so creep a
    // faux bar while we watch reachability: up → down (rebuilding) → up = done.
    const startedAt = Date.now();
    const EXPECTED_MS = 90_000;
    const MAX_MS = 6 * 60_000;
    let sawDown = false;

    for (;;) {
      await wait(2500);
      const elapsed = Date.now() - startedAt;
      const up = await this.probe(`${base}/healthz`);

      if (!up) {
        sawDown = true;
        setStatus("Rebuilding… (server offline)");
      } else if (sawDown) {
        // It went away and is back — the new build is live.
        setFill(100);
        setStatus("Updated! Reloading…");
        await wait(800);
        location.reload();
        return;
      } else {
        setStatus("Preparing update…");
      }

      // Creep toward 95% over the expected window; hold there until it's back.
      setFill(12 + Math.min(83, (elapsed / EXPECTED_MS) * 83));

      if (elapsed > MAX_MS) {
        setStatus("Update is taking longer than expected — check 'gorilator logs'.");
        this.updateRunning = false;
        if (btn) {
          btn.disabled = false;
          btn.hidden = false;
        }
        return;
      }
    }
  }

  /** GET a URL with a short timeout; true if it answered 2xx. */
  private async probe(url: string): Promise<boolean> {
    const controller = new AbortController();
    const t = window.setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(url, { cache: "no-store", signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      window.clearTimeout(t);
    }
  }

  /** Restore the name/join controls after a failed room join. */
  showJoinError(message: string) {
    this.el.classList.remove("connecting", "nameCommitted", "impacting");
    this.clearImpactFx();
    this.input.disabled = false;
    this.assetLoadEl.classList.remove("joining", "ready");
    this.assetStatusEl.textContent = "server offline";
    const joinBtn = document.getElementById("nhJoin") as HTMLButtonElement | null;
    if (joinBtn) joinBtn.disabled = false;
    const status = document.getElementById("nostrStatus") as HTMLElement | null;
    if (status) status.textContent = message;
    this.syncEnter();
    if (!this.nostr) this.input.focus();
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
    this.updateAssetProgress(dt);
  }

  /** Keep the splash's game-asset meter in sync with the background loader. */
  setAssetProgress(pct: number, status: string, mode: "background" | "joining" | "ready" = "background") {
    this.assetTargetPct = Math.max(0, Math.min(100, pct));
    this.assetStatusEl.textContent = status;
    this.assetLoadEl.classList.toggle("joining", mode === "joining");
    this.assetLoadEl.classList.toggle("ready", mode === "ready");
  }

  /**
   * Play the cinematic launch and hand off to the live game. `onReveal` fires at
   * the flash's peak — under cover of the white-out — so the caller can swap the
   * render loop over to the game scene before the flash fades away.
   */
  async playLaunch(onReveal?: () => void, onAttackStart?: () => void): Promise<void> {
    this.spin = normalizeAngle(this.spin); // ease toward facing the camera (yaw 0)
    this.prepareLaunchTiming();
    this.launchT = 0;
    this.launching = true;
    this.attackPlayed = false;
    this.launchAttackStart = onAttackStart;
    this.el.classList.add("launching");
    if (this.embers) this.embers.emitRate = 60;

    await wait(Math.round(this.launchImpactAt * 1000)); // 70% through the splash attack clip
    this.triggerImpactFx();
    this.shockEl.classList.add("show");

    await wait(IMPACT_TO_FLASH_MS); // let the floor-hit tremble read on the splash
    this.flashEl.classList.add("show");
    await wait(FLASH_COVER_MS); // let the white-out fully cover the screen
    this.clearImpactFx();
    this.active = false; // the splash scene stops rendering...
    onReveal?.(); // ...and the caller reveals the live game underneath
    this.flashEl.classList.add("fade");

    await wait(720); // flash fades out, revealing the world
    this.launching = false;
  }

  /** Fade the overlay out, restore the HUD, and tear down the scene. */
  dispose() {
    this.el.classList.add("gone");
    this.clearImpactFx();
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
  private async loadHero(progress?: (pct: number, label?: string) => void) {
    progress?.(52, "loading the gorilla model");
    const factory = new CharacterFactory(this.scene);
    await factory.preload({ playerOnly: true, includeAttack: true });
    progress?.(64, "teaching the model to look dangerous");
    if (!this.active) return; // already launched / disposed
    // Show the hero bigger than its in-game size (the gameplay gorilla is 1×).
    this.setHero(factory.spawn("player", HERO_ACCENT, SPLASH_HERO_SCALE), factory);
    progress?.(70, "hero standing by, naturally");
  }

  // ---- launch animation ----------------------------------------------------

  private updateLaunch(dt: number) {
    this.launchT += dt;
    const t = this.launchT;

    // Ease the turntable yaw back to face the camera, then hold.
    this.spin += (0 - this.spin) * Math.min(1, dt * 8);
    if (this.hero) {
      this.hero.root.rotation.y = this.spin;
      // Splash-only launch attack: use the knight/gorilla attack clip for the
      // final pre-game motion, without touching gameplay's own entity FSM.
      if (this.heroAnim) {
        if (!this.attackPlayed) {
          this.heroAnim.play(AnimState.ATTACK, true);
          this.triggerLaunchAttackStart();
        }
      } else {
        if (!this.attackPlayed) this.triggerLaunchAttackStart();
        this.hero.pose?.(AnimState.ATTACK, t);
      }
    }

    // Camera punch-in, with an aggressive floor-hit tremble around the 70% impact.
    const impactWidth = Math.max(0.16, this.launchAttackDuration * 0.16);
    const impact = Math.max(0, 1 - Math.abs(t - this.launchImpactAt) / impactWidth);
    const impactAge = t - this.launchImpactAt;
    const tremble =
      impactAge > 0 && impactAge < 0.48
        ? Math.pow(1 - impactAge / 0.48, 1.35)
        : 0;
    const punchT = Math.min(1, t / Math.max(0.65, this.launchImpactAt + 0.2));
    let radius = this.baseRadius + (5.15 - this.baseRadius) * easeOut(punchT);
    radius -= impact * 0.9 + tremble * 0.42;
    this.camera.radius = radius;
    const shake = impact * 0.13 + tremble * 0.075;
    this.camera.alpha =
      Math.PI / 2 + (Math.sin(t * 118) + Math.sin(t * 171) * 0.45) * shake;
    this.camera.beta =
      1.28 + (Math.cos(t * 103) + Math.sin(t * 149) * 0.38) * shake * 0.62;
    this.camera.target.y = 1.5 - impact * 0.1 + Math.sin(t * 137) * tremble * 0.055;

    // A burst of embers off the floor hit.
    if (this.embers) this.embers.emitRate = 60 + impact * 440 + tremble * 220;
  }

  private triggerLaunchAttackStart() {
    if (this.attackPlayed) return;
    this.attackPlayed = true;
    this.launchAttackStart?.();
    this.launchAttackStart = undefined;
  }

  private prepareLaunchTiming() {
    const attack = this.hero?.groups[AnimState.ATTACK];
    const duration = animationDurationSeconds(
      attack,
      this.hero?.speeds?.[AnimState.ATTACK] ?? 1,
    );
    this.launchAttackDuration = duration ?? FALLBACK_ATTACK_SECONDS;
    this.launchImpactAt = this.launchAttackDuration * ATTACK_IMPACT_FRACTION;
  }

  private triggerImpactFx() {
    this.clearImpactFx();
    void this.el.offsetWidth; // restart CSS impact animations on retry
    this.el.classList.add("impacting");
    document.body.classList.add("splashImpact");
    this.impactFxTimer = window.setTimeout(() => this.clearImpactFx(), IMPACT_FX_MS);
  }

  private clearImpactFx() {
    if (this.impactFxTimer !== undefined) {
      window.clearTimeout(this.impactFxTimer);
      this.impactFxTimer = undefined;
    }
    this.el.classList.remove("impacting");
    document.body.classList.remove("splashImpact");
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

    // Now that we know the npub, re-evaluate the update actions (admin → button).
    void this.refreshUpdateActions();
  }

  private clearNostr() {
    this.nostr = undefined;
    window.clearTimeout(this.revealTimer);
    this.el.classList.remove("nostr", "revealing");
    // Back to anonymous → revert any admin button to the CLI hint.
    void this.refreshUpdateActions();
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
    if (!this.nostr) {
      this.input.value = name;
      this.el.classList.add("nameCommitted");
    }
    this.enterBtn.disabled = true;
    this.input.disabled = true;
    const joinBtn = document.getElementById("nhJoin") as HTMLButtonElement | null;
    if (joinBtn) joinBtn.disabled = true;
    this.assetLoadEl.classList.add("joining");
    const resolve = this.resolveCreds;
    this.resolveCreds = undefined;
    resolve({ name, nostr: this.nostr });
  }

  private updateAssetProgress(dt: number) {
    const delta = this.assetTargetPct - this.assetShownPct;
    if (Math.abs(delta) < 0.05) {
      this.assetShownPct = this.assetTargetPct;
    } else {
      this.assetShownPct += delta * Math.min(1, dt * 6.5);
    }
    const pct = Math.round(this.assetShownPct);
    this.assetBarEl.style.width = `${this.assetShownPct.toFixed(2)}%`;
    this.assetPctEl.textContent = `${pct}%`;
  }
}

// ---- small helpers ---------------------------------------------------------

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function easeOut(x: number): number {
  return 1 - Math.pow(1 - x, 3);
}

function animationDurationSeconds(group: AnimationGroup | undefined, speed: number): number | undefined {
  if (!group) return undefined;
  const duration = group.getLength() / Math.max(0.001, speed);
  return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

/** Wrap an angle into (-π, π] so we ease toward the nearest "face camera". */
function normalizeAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  if (r < -Math.PI) r += twoPi;
  return r;
}
