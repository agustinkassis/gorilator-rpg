import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowLeft, Github, Play } from "lucide-react";
import { decode, npubEncode } from "nostr-tools/nip19";
import { useAuthorEntities, useProfiles, type CommunityEntityLite, type CommunityEntityType } from "./realms";
import { shortNpub } from "./nostr";
import "./styles.css";
import "./stats.css";
import "./profile.css";

const repoUrl = "https://github.com/agustinkassis/gorilator-rpg";

/** Read ?npub= (or the first path segment) and decode it to a hex pubkey. */
function readPubkey(): { pubkey: string | null; npub: string | null; error?: string } {
  const params = new URLSearchParams(location.search);
  const raw = params.get("npub") || location.pathname.split("/").filter(Boolean).pop() || "";
  if (!raw) return { pubkey: null, npub: null, error: "Provide an npub: /profile.html?npub=npub1…" };
  if (!raw.startsWith("npub1")) return { pubkey: null, npub: null, error: "That isn't a valid npub." };
  try {
    const res = decode(raw);
    if (res.type !== "npub") return { pubkey: null, npub: null, error: "That isn't a valid npub." };
    return { pubkey: res.data as string, npub: raw };
  } catch {
    return { pubkey: null, npub: null, error: "That isn't a valid npub." };
  }
}

function hueFromPubkey(pk: string): number {
  return (parseInt(pk.slice(0, 8), 16) || 0) % 360;
}

const TYPE_LABEL: Record<CommunityEntityType, string> = {
  character: "Character",
  structure: "Structure",
  item: "Item",
};

const STAT_LABELS: Array<[string, string]> = [
  ["maxHp", "HP"],
  ["attack", "ATK"],
  ["armor", "DEF"],
  ["critChance", "CRIT"],
  ["moveSpeed", "SPD"],
  ["throwPower", "THR"],
  ["level", "LVL"],
];

function EntityCard({ e }: { e: CommunityEntityLite }) {
  const [broken, setBroken] = useState(false);
  const statChips = STAT_LABELS.filter(([k]) => e.stats?.[k] != null).slice(0, 4);
  return (
    <div className="entityCard">
      <div className="entityThumb">
        {e.previewUrl && !broken ? (
          <img src={e.previewUrl} alt="" loading="lazy" onError={() => setBroken(true)} />
        ) : (
          <span className="entityThumbFallback">🦍</span>
        )}
        <span className="entityType">{TYPE_LABEL[e.type]}</span>
      </div>
      <div className="entityBody">
        <span className="entityName" title={e.name}>
          {e.name}
        </span>
        {e.description && <p className="entityDesc">{e.description}</p>}
        {statChips.length > 0 && (
          <div className="entityStats">
            {statChips.map(([k, label]) => (
              <span className="statChip" key={k}>
                {label}{" "}
                <b>{k === "critChance" ? `${Math.round((e.stats![k] || 0) * 100)}%` : Math.round(e.stats![k]! * 10) / 10}</b>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Profile() {
  const { pubkey, npub, error } = useMemo(readPubkey, []);
  const profiles = useProfiles(pubkey ? [pubkey] : []);
  const { entities, status } = useAuthorEntities(pubkey);
  const profile = pubkey ? profiles[pubkey] : undefined;

  const groups = useMemo(() => {
    const by: Record<CommunityEntityType, CommunityEntityLite[]> = { character: [], structure: [], item: [] };
    for (const e of entities) by[e.type].push(e);
    return by;
  }, [entities]);

  const displayName = profile?.name || (npub ? shortNpub(npub) : "Unknown");
  const hue = pubkey ? hueFromPubkey(pubkey) : 200;
  const [broken, setBroken] = useState(false);

  return (
    <main className="stats">
      <header className="statsNav">
        <a className="brand" href="/">
          GORILATOR
        </a>
        <div className="statsNavRight">
          <a className="ghostBtn" href="/stats.html">
            <Play size={14} fill="currentColor" />
            <span>Live stats</span>
          </a>
          <a className="ghostBtn" href="/">
            <ArrowLeft size={16} />
            <span>Home</span>
          </a>
        </div>
      </header>

      {!pubkey ? (
        <section className="statsHero">
          <h1>Creator Profile</h1>
          <p className="statsLede">{error || "Provide an npub: /profile.html?npub=npub1…"}</p>
        </section>
      ) : (
        <>
          <section className="profileHead">
            <div className="profileAvatar" style={{ width: 96, height: 96 }}>
              {profile?.picture && !broken ? (
                <img src={profile.picture} alt="" onError={() => setBroken(true)} />
              ) : (
                <span
                  className="avatarFallback"
                  style={{
                    background: `linear-gradient(135deg, hsl(${hue} 68% 46%), hsl(${(hue + 42) % 360} 64% 30%))`,
                    fontSize: 48,
                  }}
                >
                  🦍
                </span>
              )}
            </div>
            <div className="profileMeta">
              <h1>{displayName}</h1>
              {profile?.nip05 && <p className="profileNip05">✔ {profile.nip05}</p>}
              <a className="srvNpub" href={`https://njump.me/${npub}`} target="_blank" rel="noreferrer" title={npub!}>
                {shortNpub(npub!)}
              </a>
            </div>
          </section>

          <section className="statsSection">
            <h2>Published entities</h2>
            <p className="muted sectionSub">
              {entities.length > 0
                ? `${entities.length} community ${entities.length === 1 ? "entity" : "entities"} published over Nostr.`
                : status === "live"
                  ? "This creator hasn't published any community entities yet."
                  : "Searching relays…"}
            </p>
            {(["character", "structure", "item"] as CommunityEntityType[]).map((type) =>
              groups[type].length ? (
                <div key={type} className="entityGroup">
                  <h3 className="entityGroupTitle">
                    {TYPE_LABEL[type]}s <span className="muted">· {groups[type].length}</span>
                  </h3>
                  <div className="entityGrid">
                    {groups[type].map((e) => (
                      <EntityCard key={e.id} e={e} />
                    ))}
                  </div>
                </div>
              ) : null,
            )}
          </section>
        </>
      )}

      <footer className="footer">
        <a className="brand small" href="/">
          GORILATOR
        </a>
        <div className="footerLinks">
          <a href={repoUrl} target="_blank" rel="noreferrer">
            <Github size={16} /> Source
          </a>
          <a href="/stats.html">
            <Play size={14} fill="currentColor" /> Live stats
          </a>
        </div>
        <p className="footerNote">Community entities over Nostr · kind 30333 · assets on Blossom</p>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Profile />);
