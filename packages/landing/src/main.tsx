import { useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowUpRight,
  Check,
  Copy,
  Github,
  Hammer,
  Loader2,
  Play,
  Shield,
  Swords,
  Trophy,
  Users,
  Zap,
} from "lucide-react";
import { useReveal, useScrollY, usePointerParallax } from "./hooks";
import {
  connectNostr,
  fetchNostrProfile,
  hasNostrExtension,
  shortNpub,
  type NostrIdentity,
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
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Could not connect.");
    }
  }, []);

  if (identity) {
    return (
      <a className="nostrChip connected" href={gameUrl} title={identity.npub}>
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
          <a className="iconLink" href={repoUrl} aria-label="GitHub repository">
            <Github size={19} />
          </a>
          <a className="playSmall" href={gameUrl} aria-label="Play Gorilator">
            <Play size={15} fill="currentColor" />
            <span>Play</span>
          </a>
        </div>
      </nav>

      <div className="heroInner" style={contentStyle}>
        <a className="osBadge" href={repoUrl}>
          <span className="eyebrowDot" />
          100% Open Source
        </a>
        <h1 className="heroTitle">
          <span>GORILATOR</span>
        </h1>
        <p className="tagline">Defend La Crypta.</p>

        <div className="heroActions">
          <a className="startBtn" href={gameUrl} aria-label="Start playing Gorilator">
            <span className="startGlow" aria-hidden />
            <Play size={26} fill="currentColor" />
            <span className="startLabel">START</span>
          </a>
          <div className="altActions">
            <NostrButton />
            <a className="ghostBtn" href={repoUrl}>
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

function App() {
  const featuresReveal = useReveal();
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

      <section
        className={`finalCta ${ctaReveal.shown ? "in" : ""}`}
        ref={ctaReveal.ref as React.Ref<HTMLDivElement>}
        aria-label="Start your own server"
      >
        <div className="finalGlow" aria-hidden />
        <h2>Start your own server</h2>
        <p>Host your own Gorilator realm — installs natively, no Docker.</p>
        <InstallBox />
        <a className="finalOs" href={repoUrl}>
          <Github size={15} /> 100% Open Source · MIT
        </a>
      </section>

      <footer className="footer">
        <span className="brand small">GORILATOR</span>
        <div className="footerLinks">
          <a href="/stats.html">
            <Activity size={16} /> Live Servers
          </a>
          <a href={repoUrl}>
            <Github size={16} /> Source
          </a>
          <a href={gameUrl}>
            <Play size={14} fill="currentColor" /> Play
          </a>
        </div>
        <p className="footerNote">100% open source · MIT License</p>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
