import { useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  Github,
  Loader2,
  Play,
  Shield,
  Sparkles,
  Sword,
  Swords,
  Trophy,
  Zap,
} from "lucide-react";
import { useReveal, useScrollY, usePointerParallax } from "./hooks";
import { connectNostr, hasNostrExtension, shortNpub, type NostrIdentity } from "./nostr";
import "./styles.css";

const gameUrl = "https://game.gorilator.io";
const repoUrl = "https://github.com/agustinkassis/gorilator-rpg";

const screenshots = [
  {
    src: "/screenshots/gorilator-splash.png",
    title: "Choose the defender",
    caption: "Name the gorilla that will hold the line when the siege starts.",
  },
  {
    src: "/screenshots/gorilator-world.png",
    title: "Defend La Crypta",
    caption: "Protect the house at the center while waves push through the field.",
  },
  {
    src: "/screenshots/gorilator-hud.png",
    title: "Survive the waves",
    caption: "Track health, resources, minimap pressure, inventory, and the next attack.",
  },
];

const features = [
  {
    icon: Shield,
    title: "Tower Defense",
    body: "La Crypta is the tower, the field is the lane. Hold the center or lose it all.",
  },
  {
    icon: Swords,
    title: "Wave Combat",
    body: "Read the minimap, position fast, and break wave after escalating wave.",
  },
  {
    icon: Zap,
    title: "Resource Pickups",
    body: "Gather drops, spend stamina, and throw everything you have at the horde.",
  },
  {
    icon: Trophy,
    title: "Nostr Identity",
    body: "Bring your own keys. Your gorilla, your progress, signed and yours.",
  },
];

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
      setIdentity(id);
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Could not connect.");
    }
  }, []);

  if (identity) {
    return (
      <a className="nostrChip connected" href={gameUrl} title={identity.npub}>
        {identity.picture ? (
          <img src={identity.picture} alt="" />
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
          <span className="nostrGlyph">ostr</span>
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
        <p className="eyebrow">
          <span className="eyebrowDot" />
          Defend La Crypta
        </p>
        <h1 className="heroTitle">
          <span data-text="GORI">GORI</span>
          <span data-text="LATOR">LATOR</span>
        </h1>
        <p className="lede">
          A brutal isometric tower-defense where your gorilla guards La Crypta — gather resources,
          throw weapons, and survive wave after wave of attackers.
        </p>

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

      <div className="statusStrip" aria-label="Game highlights">
        <span>
          <Shield size={15} /> Tower defense
        </span>
        <span>
          <Sword size={15} /> Wave combat
        </span>
        <span>
          <Zap size={15} /> Resource pickups
        </span>
        <span>
          <Sparkles size={15} /> Nostr login
        </span>
      </div>

      <div className="scrollHint" aria-hidden>
        <span className="mouse">
          <span className="wheel" />
        </span>
      </div>
    </section>
  );
}

function FeatureCard({ icon: Icon, title, body, index }: (typeof features)[number] & { index: number }) {
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
      <p>{body}</p>
    </article>
  );
}

function Shot({ shot, index }: { shot: (typeof screenshots)[number]; index: number }) {
  const { ref, shown } = useReveal();
  return (
    <article
      ref={ref}
      className={`shot ${shown ? "in" : ""}`}
      style={{ transitionDelay: `${index * 110}ms` }}
    >
      <div className="shotImg">
        <img src={shot.src} alt={`${shot.title} screenshot`} loading="lazy" />
      </div>
      <div className="shotBody">
        <h3>{shot.title}</h3>
        <p>{shot.caption}</p>
      </div>
    </article>
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
          <p className="eyebrow center">What you're up against</p>
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

      <section className="band screens" aria-label="Screenshots">
        <div className="sectionHead">
          <p className="eyebrow center">From the game</p>
          <h2 className="sectionTitle in">Every wave is a pressure test.</h2>
        </div>
        <div className="shotGrid">
          {screenshots.map((shot, i) => (
            <Shot key={shot.src} shot={shot} index={i} />
          ))}
        </div>
      </section>

      <section
        className={`finalCta ${ctaReveal.shown ? "in" : ""}`}
        ref={ctaReveal.ref as React.Ref<HTMLDivElement>}
        aria-label="Play now"
      >
        <div className="finalGlow" aria-hidden />
        <h2>The siege won't wait.</h2>
        <p>Step into the arena, bring your keys, and defend La Crypta.</p>
        <a className="startBtn big" href={gameUrl}>
          <span className="startGlow" aria-hidden />
          <Play size={30} fill="currentColor" />
          <span className="startLabel">START</span>
        </a>
        <div className="finalAlt">
          <NostrButton />
        </div>
      </section>

      <footer className="footer">
        <span className="brand small">GORILATOR</span>
        <div className="footerLinks">
          <a href={repoUrl}>
            <Github size={16} /> Source
          </a>
          <a href={gameUrl}>
            <Play size={14} fill="currentColor" /> Play
          </a>
        </div>
        <p className="footerNote">Multiplayer isometric RPG · Babylon.js + Colyseus · Nostr identity</p>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
