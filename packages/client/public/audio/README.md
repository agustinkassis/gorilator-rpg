# Audio assets

The sound effects run procedurally by default (see `src/audio/synth.ts`), so the
game still has SFX with zero files in here. Music is file-based only: add it to
`manifest.json` to play it.

To replace any sound with a real sample, drop the file in this folder and list it
in `manifest.json` (same drop-in idea as `props.json`). SFX not listed keep using
their synth; music not listed stays silent.

## manifest.json

Maps a sound key → a URL under `/audio/`. Example:

```json
{
  "splashMusic": "/audio/music/splash.mp3",
  "music": "/audio/music/theme.mp3",
  "waveMusic": "/audio/music/wave.mp3",
  "berserker": "/audio/sfx/berserker.mp3",
  "body_hit": "/audio/sfx/body_hit.mp3",
  "gorilla_attack": "/audio/sfx/gorilla_attack.mp3",
  "hit": "/audio/sfx/hit.wav",
  "splash_roar": "/audio/sfx/splash_roar.mp3",
  "tree_chop": "/audio/sfx/tree_chop.mp3",
  "chop": "/audio/sfx/chop.ogg",
  "click": "/audio/ui/click.wav"
}
```

### Keys

| key        | when it plays                                  | spatial |
| ---------- | ---------------------------------------------- | ------- |
| `splashMusic` | splash-screen music before entering gameplay | —       |
| `music`    | background loop between waves                  | —       |
| `waveMusic`| wave/combat loop while wave enemies are alive  | —       |
| `hit`      | you land a blow on a character                 | yes     |
| `body_hit` | a character body receives damage               | yes     |
| `hurt`     | the local player takes damage                  | no      |
| `footstep` | a footfall while running                       | yes     |
| `throw`    | a banana/stone leaves the hand                 | yes     |
| `land`     | a thrown banana hits the ground                | yes     |
| `stone`    | mining a rock / a thrown stone landing         | yes     |
| `chop`     | an axe hit on a tree                           | yes     |
| `tree_chop`| tree receives chop damage                      | yes     |
| `death`    | a character drops dead                         | yes     |
| `levelup`  | a player levels up                             | yes     |
| `pickup`   | an item is collected                           | yes     |
| `heal`     | HP restored                                    | yes     |
| `berserker`| local player drinks a berserker potion        | no      |
| `splash_roar` | splash hero starts the launch attack animation | no |
| `gorilla_attack` | player gorilla starts an attack animation | yes |
| `click`    | a UI button press                              | no      |

Formats: anything the browser can `decodeAudioData` (mp3, ogg, wav, m4a). Keep SFX
short (< 1s) and mono; spatial panning is applied per the listener (the player).
A `music` track should be a seamless loop.

## Current Audio Elements

| key | element | current source |
| --- | ------- | -------------- |
| `splashMusic` | splash-screen music before entering gameplay; stops during the handoff into the game | `/audio/music/splash.mp3` |
| `music` | base exploration theme after entering the game and between waves | `/audio/music/theme.mp3` |
| `waveMusic` | wave/combat theme while wave enemies are spawning or alive | `/audio/music/wave.mp3` |
| `berserker` | local player drinks a berserker potion | `/audio/sfx/berserker.mp3` |
| `body_hit` | character body receives damage | `/audio/sfx/body_hit.mp3` |
| `gorilla_attack` | player gorilla starts an attack animation | `/audio/sfx/gorilla_attack.mp3` |
| `hit` | melee hit on a character | `/audio/sfx/hit.mp3` |
| `splash_roar` | splash hero starts the launch attack animation before gameplay reveal | `/audio/sfx/splash_roar.mp3` |
| `tree_chop` | tree receives chop damage | `/audio/sfx/tree_chop.mp3` |
| `hurt` | local player takes damage | procedural fallback |
| `footstep` | moving character footstep cadence | procedural fallback |
| `throw` | banana or stone leaves the hand | procedural fallback |
| `land` | thrown banana lands | procedural fallback |
| `stone` | rock mining or thrown stone impact | procedural fallback |
| `chop` | axe hit on a tree or concrete structure | procedural fallback |
| `death` | character death transition | procedural fallback |
| `levelup` | player levels up | procedural fallback |
| `pickup` | item collected | procedural fallback |
| `heal` | health restored | procedural fallback |
| `click` | UI button press | procedural fallback |
