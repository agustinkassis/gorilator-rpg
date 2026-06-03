#!/usr/bin/env node
/**
 * Generate Gorilator's sound effects via the ElevenLabs text-to-sound API
 * and wire them into the audio manifest. Files land in `public/audio/{sfx,ui,music}`
 * and `public/audio/manifest.json` is updated to point each AudioManager key at
 * its sample (any SFX key with a file overrides the procedural synth).
 *
 * Usage:
 *   ELEVENLABS_API_KEY=xxxxx node packages/client/scripts/gen-audio.mjs           # generate missing
 *   ELEVENLABS_API_KEY=xxxxx node packages/client/scripts/gen-audio.mjs --force   # regenerate all
 *   ELEVENLABS_API_KEY=xxxxx node packages/client/scripts/gen-audio.mjs hit chop  # only these keys
 *
 * No npm deps — uses Node 20+ global fetch. Mind your credits.
 */
import { mkdir, writeFile, access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.elevenlabs.io/v1/sound-generation";
const MODEL = "eleven_text_to_sound_v2"; // v2 supports seamless `loop`
const KEY = process.env.ELEVENLABS_API_KEY;

const here = dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = resolve(here, "../public/audio");

// key → AudioManager sound key; file → path under public/audio; prompt/params → ElevenLabs.
// Keep SFX short + punchy. Music tracks are managed manually in public/audio/music.
const SOUNDS = [
  { key: "hit", file: "sfx/hit.mp3", dur: 0.6, infl: 0.5,
    text: "Punchy melee impact, a fist and club hitting a body, short meaty thud with a slight crunch, video game combat hit" },
  { key: "body_hit", file: "sfx/body_hit.mp3", dur: 0.7, infl: 0.55,
    text: "Heavy bare-hand punch into a body, hard meaty impact thud, short realistic combat body hit, no voice" },
  { key: "hurt", file: "sfx/hurt.mp3", dur: 0.6, infl: 0.45,
    text: "Dull body impact with a short non-verbal pained grunt, taking damage, retro video game hurt" },
  { key: "footstep", file: "sfx/footstep.mp3", dur: 0.5, infl: 0.6,
    text: "A single soft footstep on grass and dirt, light quick footfall, video game" },
  { key: "throw", file: "sfx/throw.mp3", dur: 0.5, infl: 0.5,
    text: "Fast short whoosh of a small object thrown through the air, light swish" },
  { key: "land", file: "sfx/land.mp3", dur: 0.5, infl: 0.5,
    text: "Soft squishy splat plop of a light object landing on grass, cartoon, short" },
  { key: "stone", file: "sfx/stone.mp3", dur: 0.6, infl: 0.5,
    text: "Sharp stone-on-stone clack, a pickaxe knocking rock, short rocky knock with gravel, video game mining" },
  { key: "chop", file: "sfx/chop.mp3", dur: 0.6, infl: 0.5,
    text: "Axe chopping wood, a sharp thwack and woody chunk, short, video game" },
  { key: "tree_chop", file: "sfx/tree_chop.mp3", dur: 0.8, infl: 0.6,
    text: "Hand axe hitting a tree trunk, heavy woody chop impact, bark crack and wood thud, short realistic tool strike, no voice" },
  { key: "death", file: "sfx/death.mp3", dur: 0.9, infl: 0.4,
    text: "Short defeated death sting, a descending tone with a soft body thud, video game character down" },
  { key: "levelup", file: "sfx/levelup.mp3", dur: 1.4, infl: 0.4,
    text: "Triumphant level-up flourish, bright ascending magical chime with sparkle, rewarding, video game" },
  { key: "pickup", file: "sfx/pickup.mp3", dur: 0.6, infl: 0.55,
    text: "Item pickup, a bright cheerful coin-like ding blip, short, retro game collect" },
  { key: "heal", file: "sfx/heal.mp3", dur: 0.9, infl: 0.45,
    text: "Magical healing shimmer, a soft warm restorative chime, gentle sparkle, video game" },
  { key: "berserker", file: "sfx/berserker.mp3", dur: 1.5, infl: 0.55,
    text: "Primal gorilla roar, powerful heroic rage surge, short animal roar with chest resonance, fantasy video game power-up, no words" },
  { key: "splash_roar", file: "sfx/splash_roar.mp3", dur: 1.2, infl: 0.6,
    text: "Cinematic gorilla roar for an intro splash screen, proud primal roar before gameplay starts, dramatic but brief, no words" },
  { key: "gorilla_attack", file: "sfx/gorilla_attack.mp3", dur: 0.8, infl: 0.6,
    text: "Short aggressive gorilla attack roar, fast primate bark during a melee swing, powerful but brief, fantasy video game, no words" },
  { key: "click", file: "ui/click.mp3", dur: 0.5, infl: 0.7,
    text: "Soft clean UI button click, a short crisp tick, menu" },
];

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function generate(s) {
  const out = join(AUDIO_DIR, s.file);
  await mkdir(dirname(out), { recursive: true });
  const body = {
    text: s.text,
    model_id: MODEL,
    duration_seconds: s.dur,
    prompt_influence: s.infl,
    ...(s.loop ? { loop: true } : {}),
  };
  const res = await fetch(`${API}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`[${s.key}] ${res.status} ${res.statusText} ${detail.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(out, buf);
  console.log(`  ✓ ${s.key.padEnd(9)} → ${s.file} (${(buf.length / 1024).toFixed(0)} KB)`);
}

async function main() {
  if (!KEY) {
    console.error("✗ Set ELEVENLABS_API_KEY first:  ELEVENLABS_API_KEY=xxx node packages/client/scripts/gen-audio.mjs");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const only = args.filter((a) => !a.startsWith("--"));

  let targets = SOUNDS.filter((s) => !s.key.startsWith("_"));
  if (only.length) targets = targets.filter((s) => only.includes(s.key));

  console.log(`Generating ${targets.length} sound(s) into ${AUDIO_DIR} …`);
  for (const s of targets) {
    const out = join(AUDIO_DIR, s.file);
    if (!force && (await exists(out))) {
      console.log(`  • ${s.key.padEnd(9)} exists, skipping (use --force to regenerate)`);
      continue;
    }
    try {
      await generate(s);
    } catch (e) {
      console.error(`  ✗ ${e.message}`);
    }
  }

  // Rewrite generated entries while preserving hand-added music such as waveMusic.
  let manifest = {};
  const manifestPath = join(AUDIO_DIR, "manifest.json");
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    manifest = {};
  }
  for (const s of SOUNDS) {
    if (s.key.startsWith("_")) continue;
    if (await exists(join(AUDIO_DIR, s.file))) manifest[s.key] = `/audio/${s.file}`;
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nWrote ${manifestPath} with ${Object.keys(manifest).length} entr(y/ies).`);
  console.log("Reload the client — the AudioManager picks these up automatically.");
}

main();
