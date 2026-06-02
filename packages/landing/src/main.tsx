import { createRoot } from "react-dom/client";
import { ArrowUpRight, Github, Play, Shield, Sparkles, Sword, Zap } from "lucide-react";
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

function App() {
  return (
    <main>
      <section className="hero" aria-label="Gorilator">
        <div className="heroBackdrop" />
        <nav className="nav" aria-label="Primary">
          <div className="navActions">
            <a className="iconLink" href={repoUrl} aria-label="GitHub repository">
              <Github size={19} />
            </a>
            <a className="playSmall" href={gameUrl} aria-label="Play Gorilator">
              <Play size={16} fill="currentColor" />
              <span>Play</span>
            </a>
          </div>
        </nav>

        <div className="heroInner">
          <p className="eyebrow">Defend La Crypta</p>
          <h1>Gorilator</h1>
          <p className="lede">
            A brutal isometric tower-defense game where your gorilla guards La Crypta, gathers
            resources, throws weapons, and survives wave after wave of attackers.
          </p>
          <div className="heroActions" aria-label="Links">
            <a className="primaryCta" href={gameUrl}>
              <Play size={19} fill="currentColor" />
              <span>Start Playing</span>
            </a>
            <a className="secondaryCta" href={repoUrl}>
              <Github size={19} />
              <span>GitHub Repo</span>
              <ArrowUpRight size={17} />
            </a>
          </div>
        </div>

        <div className="statusStrip" aria-label="Game highlights">
          <span>
            <Shield size={16} />
            Tower defense
          </span>
          <span>
            <Sword size={16} />
            Wave combat
          </span>
          <span>
            <Zap size={16} />
            Resource pickups
          </span>
        </div>
      </section>

      <section className="screens" aria-label="Screenshots">
        <div className="sectionHead">
          <p className="eyebrow">From the game</p>
          <h2>Hold the house. Break the waves.</h2>
        </div>
        <div className="shotGrid">
          {screenshots.map((shot) => (
            <article className="shot" key={shot.src}>
              <img src={shot.src} alt={`${shot.title} screenshot`} />
              <div>
                <h3>{shot.title}</h3>
                <p>{shot.caption}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="fieldNotes" aria-label="Game systems">
        <div className="note">
          <Sparkles size={22} />
          <h2>Defend La Crypta at all costs</h2>
          <p>
            La Crypta is the tower. The field is the lane. Every wave is a pressure test: position
            fast, collect drops, spend stamina, and keep the attackers away from the house.
          </p>
        </div>
        <a className="wideCta" href={gameUrl}>
          <Play size={20} fill="currentColor" />
          <span>Enter the Arena</span>
        </a>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
