import { useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowUpRight,
  Boxes,
  Check,
  Copy,
  GitCommit,
  Github,
  Hammer,
  Loader2,
  Map as MapIcon,
  Monitor,
  Play,
  Server,
  Shield,
  Swords,
  Trophy,
  Upload,
  Users,
  Wand2,
  Zap,
} from "lucide-react";
import {
  siBabylondotjs,
  siExpress,
  siNodedotjs,
  siTypescript,
  siVite,
} from "simple-icons";
import { useReveal, useScrollY, usePointerParallax } from "./hooks";
import {
  connectNostr,
  fetchNostrProfile,
  fetchPlayerSave,
  hasNostrExtension,
  shortNpub,
  type NostrIdentity,
  type PlayerStatus,
} from "./nostr";
import "./styles.css";

const gameUrl = "https://game.gorilator.io";
const repoUrl = "https://github.com/agustinkassis/gorilator-rpg";

const features = [
  { icon: Shield, title: "Tower Defense" },
  { icon: Swords, title: "RPG" },
  { icon: Users, title: "Online Multiplayer" },
  { icon: Hammer, title: "Crafting" },
  { icon: Zap, title: "Resource Pickups" },
  { icon: Trophy, title: "Nostr Identity" },
];

/** The in-game developer SDK — build the game from inside the game. */
const devTools = [
  {
    icon: MapIcon,
    title: "World editor",
    body: "Flip on Dev Mode and place, move, and arrange props directly in the running scene. Layouts persist.",
  },
  {
    icon: Upload,
    title: "Upload models from the UI",
    body: "Import glTF / GLB models straight from the browser — no file juggling, no rebuilds.",
  },
  {
    icon: Wand2,
    title: "Create items & entities",
    body: "Define new items, characters, and entities through the in-game libraries.",
  },
  {
    icon: GitCommit,
    title: "Commit from the game",
    body: "Persist your edits from within the game itself. Develop the game as you play it.",
  },
];

/** A brand logo from simple-icons, in its official color (overridable for dark bg). */
function BrandIcon({ icon, color }: { icon: { path: string; hex: string }; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill={color ?? `#${icon.hex}`} aria-hidden>
      <path d={icon.path} />
    </svg>
  );
}

const colyseusLogo = () => <img src="/logos/colyseus.png" alt="" loading="lazy" />;
const nostrLogo = () => (
  <span className="techNostr">
    <Ostrich />
  </span>
);

const stack = [
  {
    side: "Client",
    icon: Monitor,
    items: [
      { name: "Babylon.js", url: "https://www.babylonjs.com", logo: <BrandIcon icon={siBabylondotjs} /> },
      { name: "Colyseus.js", url: "https://colyseus.io", logo: colyseusLogo() },
      { name: "Vite", url: "https://vite.dev", logo: <BrandIcon icon={siVite} /> },
      { name: "TypeScript", url: "https://www.typescriptlang.org", logo: <BrandIcon icon={siTypescript} /> },
      { name: "Nostr", url: "https://nostr.com", logo: nostrLogo() },
    ],
  },
  {
    side: "Server",
    icon: Server,
    items: [
      { name: "Colyseus", url: "https://colyseus.io", logo: colyseusLogo() },
      { name: "Node.js", url: "https://nodejs.org", logo: <BrandIcon icon={siNodedotjs} /> },
      { name: "Express", url: "https://expressjs.com", logo: <BrandIcon icon={siExpress} color="#e8d4ac" /> },
      { name: "TypeScript", url: "https://www.typescriptlang.org", logo: <BrandIcon icon={siTypescript} /> },
      { name: "Nostr", url: "https://nostr.com", logo: nostrLogo() },
    ],
  },
];

/** A tiny ostrich — the "ostr" in Nostr. Sits in the connect button's glyph. */
function Ostrich() {
  return (
    <svg
      className="ostrich"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="8" cy="5" r="1.3" />
      <path d="M6.8 4.7 4.9 5.2 6.8 5.7" />
      <path d="M8.7 6.1c1.3 1.7.7 3.3 2.1 4.4" />
      <path d="M10.8 10.5c-4.2-.2-5 5.3.2 6 5.1.6 7.4-3.9 4.5-5.9-1.5-1-3.4-.5-4.7 0z" />
      <path d="M17.6 11.3c1.6-.6 2.6.6 1.8 2" />
      <path d="M11.7 16.3 11.1 20.8" />
      <path d="M14.6 16.5 15.6 20.8" />
    </svg>
  );
}

/** A field of slow-rising embers behind the hero. Positions are deterministic
 *  per index so they don't reshuffle on re-render. */
function Embers() {
  const embers = useMemo(
    () =>
      Array.from({ length: 26 }, (_, i) => ({
        left: (i * 37.6) % 100,
        delay: (i % 13) * 0.9,
        duration: 9 + (i % 7) * 1.6,
        size: 2 + (i % 4),
        drift: (i % 2 ? 1 : -1) * (8 + (i % 5) * 6),
      })),
    [],
  );
  return (
    <div className="embers" aria-hidden>
      {embers.map((e, i) => (
        <span
          key={i}
          style={
            {
              left: `${e.left}%`,
              width: `${e.size}px`,
              height: `${e.size}px`,
              animationDelay: `${e.delay}s`,
              animationDuration: `${e.duration}s`,
              "--drift": `${e.drift}px`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

function NostrButton() {
  const [identity, setIdentity] = useState<NostrIdentity | null>(null);
  const [status, setStatus] = useState<"idle" | "connecting" | "error">("idle");
  const [error, setError] = useState("");
  const [save, setSave] = useState<PlayerStatus | null>(null);

  const onConnect = useCallback(async () => {
    setStatus("connecting");
    setError("");
    try {
      if (!hasNostrExtension()) {
        // give a slow-loading extension a beat to inject window.nostr
        await new Promise((r) => setTimeout(r, 400));
      }
      const id = await connectNostr();
      setIdentity(id); // show the npub immediately
      setStatus("idle");
      // resolve the avatar + display name from the npub's kind-0 in the background
      void fetchNostrProfile(id.pubkey).then((profile) => {
        if (profile.name || profile.picture) {
          setIdentity((cur) => (cur && cur.pubkey === id.pubkey ? { ...cur, ...profile } : cur));
        }
      });
      // and their last realm status from their server-signed save
      void fetchPlayerSave(id.pubkey).then((s) => {
        if (s) setSave(s);
      });
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Could not connect.");
    }
  }, []);

  if (identity) {
    return (
      <div className="nostrWrap">
        <a className="nostrChip connected" href={gameUrl} target="_blank" rel="noreferrer" title={identity.npub}>
          {identity.picture ? (
            <img
              src={identity.picture}
              alt=""
              onError={() => setIdentity((cur) => (cur ? { ...cur, picture: undefined } : cur))}
            />
          ) : (
            <span className="nostrDot" />
          )}
          <span className="nostrName">{identity.name || shortNpub(identity.npub)}</span>
          <span className="nostrGo">Enter →</span>
        </a>
        {save && (
          <span className="nostrRealm">
            Lv {save.level}
            {save.realmWave != null ? ` · last realm wave ${save.realmWave}` : ""}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="nostrWrap">
      <button className="nostrChip" onClick={onConnect} disabled={status === "connecting"}>
        {status === "connecting" ? (
          <Loader2 size={17} className="spin" />
        ) : (
          <span className="nostrGlyph">
            <Ostrich />
          </span>
        )}
        <span>{status === "connecting" ? "Connecting…" : "Connect with Nostr"}</span>
      </button>
      {status === "error" && <span className="nostrError">{error}</span>}
    </div>
  );
}

function Hero() {
  const scrollY = useScrollY();
  const pointer = usePointerParallax();

  // Parallax: deeper layers move less. Scroll pushes layers up at varied rates;
  // the pointer adds a small lateral sway for a 3-D feel.
  const bgStyle = {
    transform: `translate3d(${pointer.x * -14}px, ${scrollY * 0.28 + pointer.y * -10}px, 0) scale(1.18)`,
  };
  const glowStyle = {
    transform: `translate3d(${pointer.x * 26}px, ${scrollY * 0.12 + pointer.y * 18}px, 0)`,
  };
  const contentStyle = {
    transform: `translateY(${scrollY * -0.06}px)`,
    opacity: Math.max(0, 1 - scrollY / 620),
  };

  return (
    <section className="hero" aria-label="Gorilator">
      <div className="heroBg" style={bgStyle} />
      <div className="heroGlow" style={glowStyle} />
      <div className="heroVignette" />
      <Embers />

      <nav className="nav" aria-label="Primary">
        <span className="brand">GORILATOR</span>
        <div className="navActions">
          <a className="iconLink" href="/stats.html" aria-label="Live Servers">
            <Activity size={19} />
          </a>
          <a className="iconLink" href={repoUrl} target="_blank" rel="noreferrer" aria-label="GitHub repository">
            <Github size={19} />
          </a>
          <a className="playSmall" href={gameUrl} target="_blank" rel="noreferrer" aria-label="Play Gorilator">
            <Play size={15} fill="currentColor" />
            <span>Play</span>
          </a>
        </div>
      </nav>

      <div className="heroInner" style={contentStyle}>
        <a className="osBadge" href={repoUrl} target="_blank" rel="noreferrer">
          <span className="eyebrowDot" />
          100% Open Source
        </a>
        <h1 className="heroTitle">
          <span>GORILATOR</span>
        </h1>
        <p className="tagline">Defend La Crypta.</p>

        <div className="heroActions">
          <a className="startBtn" href={gameUrl} target="_blank" rel="noreferrer" aria-label="Start playing Gorilator">
            <span className="startGlow" aria-hidden />
            <Play size={26} fill="currentColor" />
            <span className="startLabel">START</span>
          </a>
          <div className="altActions">
            <NostrButton />
            <a className="ghostBtn" href={repoUrl} target="_blank" rel="noreferrer">
              <Github size={17} />
              <span>GitHub</span>
              <ArrowUpRight size={15} />
            </a>
          </div>
        </div>
      </div>

      <div className="scrollHint" aria-hidden>
        <span className="mouse">
          <span className="wheel" />
        </span>
      </div>
    </section>
  );
}

function FeatureCard({ icon: Icon, title, index }: (typeof features)[number] & { index: number }) {
  const { ref, shown } = useReveal();
  return (
    <article
      ref={ref}
      className={`feature ${shown ? "in" : ""}`}
      style={{ transitionDelay: `${index * 90}ms` }}
    >
      <span className="featureIcon">
        <Icon size={24} />
      </span>
      <h3>{title}</h3>
    </article>
  );
}

type InstallTab = { id: string; label: string; cmd?: string; soon?: boolean };

const installTabs: InstallTab[] = [
  { id: "oneliner", label: "One-liner", cmd: "curl -fsSL https://gorilator.io/install.sh | bash" },
  { id: "npm", label: "npm", cmd: "npx gorilator install" },
  { id: "railway", label: "Railway", soon: true },
];

/** Tabbed "how to self-host" box with a copy-to-clipboard command line. */
function InstallBox() {
  const [active, setActive] = useState("oneliner");
  const [copied, setCopied] = useState(false);
  const tab = installTabs.find((t) => t.id === active) ?? installTabs[0];
  const cmd = tab.cmd ?? "";

  const onCopy = useCallback(async () => {
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (insecure context) — ignore
    }
  }, [cmd]);

  return (
    <div className="installBox">
      <div className="installTabs" role="tablist">
        {installTabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={active === t.id}
            className={`installTab ${active === t.id ? "active" : ""} ${t.soon ? "soon" : ""}`}
            onClick={() => !t.soon && setActive(t.id)}
            disabled={t.soon}
          >
            {t.label}
            {t.soon && <span className="soonTag">soon</span>}
          </button>
        ))}
      </div>
      <div className="installBody">
        <code className="installCmd">
          <span className="installPrompt">$</span>
          {cmd}
        </code>
        <button className="copyBtn" onClick={onCopy} aria-label="Copy command">
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
    </div>
  );
}

/** A full-width screenshot showcase with a reveal-on-scroll fade and caption. */
function Shot({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  const { ref, shown } = useReveal();
  return (
    <figure ref={ref} className={`shot ${shown ? "in" : ""}`}>
      <img src={src} alt={alt} loading="lazy" />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

function App() {
  const featuresReveal = useReveal();
  const sdkReveal = useReveal();
  const stackReveal = useReveal();
  const ctaReveal = useReveal();

  return (
    <main>
      <Hero />

      <section className="band features" aria-label="Game systems">
        <div className="sectionHead" ref={featuresReveal.ref as React.Ref<HTMLDivElement>}>
          <h2 className={`sectionTitle ${featuresReveal.shown ? "in" : ""}`}>
            Hold the house. Break the waves.
          </h2>
        </div>
        <div className="featureGrid">
          {features.map((f, i) => (
            <FeatureCard key={f.title} {...f} index={i} />
          ))}
        </div>
      </section>

      <Shot
        src="/screenshots/gorilator-hud.png"
        alt="Gorilator in-game: isometric combat, inventory, resource pickups, and the dev toolbar"
        caption="Isometric combat, loot, and the in-game dev toolbar — all in the same window."
      />

      <section className="band sdk" aria-label="In-game developer SDK">
        <div className="sectionHead" ref={sdkReveal.ref as React.Ref<HTMLDivElement>}>
          <span className={`sectionEyebrow ${sdkReveal.shown ? "in" : ""}`}>Developer SDK · built in</span>
          <h2 className={`sectionTitle ${sdkReveal.shown ? "in" : ""}`}>
            Build the game from inside the game.
          </h2>
          <p className={`sectionLede ${sdkReveal.shown ? "in" : ""}`}>
            No separate tools. Flip on Dev Mode and edit the world, import 3D models, create entities, and
            commit your changes — all from the running client. Open source and easy to contribute.
          </p>
        </div>
        <div className="sdkGrid">
          {devTools.map((t, i) => {
            const Icon = t.icon;
            return (
              <article
                key={t.title}
                className={`sdkCard ${sdkReveal.shown ? "in" : ""}`}
                style={{ transitionDelay: `${i * 90}ms` }}
              >
                <span className="featureIcon">
                  <Icon size={24} />
                </span>
                <h3>{t.title}</h3>
                <p>{t.body}</p>
              </article>
            );
          })}
        </div>
        <a className="sdkLink" href={repoUrl} target="_blank" rel="noreferrer">
          <Boxes size={16} /> Start contributing on GitHub <ArrowUpRight size={14} />
        </a>
      </section>

      <section
        className={`band stack ${stackReveal.shown ? "in" : ""}`}
        ref={stackReveal.ref as React.Ref<HTMLDivElement>}
        aria-label="Tech stack"
      >
        <div className="sectionHead">
          <h2 className={`sectionTitle ${stackReveal.shown ? "in" : ""}`}>Built with</h2>
        </div>
        <div className="stackGrid">
          {stack.map((group) => {
            const Icon = group.icon;
            return (
              <article className="stackCard" key={group.side}>
                <div className="stackHead">
                  <span className="featureIcon">
                    <Icon size={24} />
                  </span>
                  <h3>{group.side}</h3>
                </div>
                <ul className="stackList">
                  {group.items.map((item) => (
                    <li key={item.name}>
                      <a className="techItem" href={item.url} target="_blank" rel="noreferrer">
                        {item.logo}
                        <span>{item.name}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
      </section>

      <section
        className={`finalCta ${ctaReveal.shown ? "in" : ""}`}
        ref={ctaReveal.ref as React.Ref<HTMLDivElement>}
        aria-label="Start your own server"
      >
        <div className="finalGlow" aria-hidden />
        <h2>Start your own server</h2>
        <p>Host your own Gorilator realm — installs natively, no Docker.</p>
        <InstallBox />
        <a className="finalOs" href={repoUrl} target="_blank" rel="noreferrer">
          <Github size={15} /> 100% Open Source · MIT
        </a>
      </section>

      <footer className="footer">
        <span className="brand small">GORILATOR</span>
        <div className="footerLinks">
          <a href="/stats.html">
            <Activity size={16} /> Live Servers
          </a>
          <a href={repoUrl} target="_blank" rel="noreferrer">
            <Github size={16} /> Source
          </a>
          <a href={gameUrl} target="_blank" rel="noreferrer">
            <Play size={14} fill="currentColor" /> Play
          </a>
        </div>
        <p className="footerNote">100% open source · MIT License</p>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
