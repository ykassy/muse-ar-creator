# MOSHI MOSHI — Say hello to your characters

**Talk to Muse, and a character you can touch and talk to is born inside HACKAR:S — our production WebAR platform.** Hand interactions designed for AR glasses, tried on today's phones.

An MCP connector for the **Meta Global AI Developer Hackathon** (Cerebral Valley, Oct 26 – Nov 4, 2026), built by HACK IT INC. (solo).

Say the passphrase "Moshi Moshi" in Muse to start, give a one-word theme, and this connector:

1. **Composes** the character server-side with the Meta Model API — `muse-spark-1.3` designs the title, overlay text, base color, the magic spell, and the character's **name and personality** (JSON); `muse-image-1.0` generates the artwork, plus face variants (happy / surprised / sad / angry) via image edits, each re-cut with the original silhouette mask. Token usage is logged on every run as Tooling evidence. Muse Spark then **checks its own artwork with vision** — the cut-out on a gray floor, as it will stand in AR — and if it fails (holes, a cropped limb, leftover background) it writes the fix into a new image prompt and redraws once.
2. **Builds a semi-3D model on the server** (`api/glb.mjs`, pure JS): the flat artwork becomes a plate with real thickness (1/15 of its height), an edge-coloured rim, a baked ground shadow, a 3-joint squash-and-stretch rig, and **nine named animation clips** — `idle` / `happy` / `surprised` / `sad` / `angry` / `talk` / `dangle` / `land` / `zap`.
3. **Publishes into HACKAR:S** (our production WebAR platform) as a real project: the model, one of five real three.js **Ultra Elements** spells (lightning / fire / frozen lightning / starfall / light pillar), expression switching, and **Hand Play** — pinch the character with your fingers to pick it up and carry it, press the talk button and it listens and answers in character (voice transcription + Spark reply + speech, with an emotion that changes its face and moves), hold up a palm to cast its spell. Ask it to jump, spin or cast its spell and it does — Spark returns an action with its reply (speech is read out with the phone's built-in voice). It moves calmly on its own (looking around, the occasional hop), lives with you as a small pet (feed / play / talk / pet from the buttons at its feet; it grows, gets hungry, sleeps at night and now and then leaves a mess you clean with a fingertip),.
4. **Certifies** the creation with a signed certificate page (one per creator) that links the published work and prints the Meta Model API usage.

## In production

- **Real output, real platform.** Every run creates a project in HACKAR:S (hackar-s.com), the WebAR platform we already run for brand and event AR. The only link the user gets is that hackar-s.com URL.
- **Time.** Theme to a live link took about 1.5–2 minutes in our runs (composition ~55 s, ~90 s when the self-check asks for a redraw; publishing ~30 s).
- **Cost per character.** About six Muse Image calls (artwork, four expressions, at most one redraw) at $0.01 each plus a few thousand Muse Spark tokens — roughly $0.07.
- **Honest failure.** If publishing fails, the user is told so; no other URL is substituted.
- **Guard rails.** Per-IP and global rate limits on the paid tools and on talk, plus pause switches (`AR_PAUSED`, `TALK_PAUSED`).

If the model API is unavailable, composition falls back to a deterministic template so a creation always stands up (publishing still requires the real pipeline and fails honestly rather than substituting another URL).

## What was built when (hackathon rules)

| Part | When |
|---|---|
| This connector: MCP server (`api/mcp.js`), the JS GLB builder (`api/glb.mjs`), the Blender reference pipeline (`pipeline/`), expression generation, the talk endpoint (`api/talk.js`) | **Built during the hackathon (Oct 26 – Nov 4, 2026)** |
| The player features on the phone: Hand Play (pinch / carry / poke / palm), the talk button, floor-AR-style choreography, emotion clip / expression switching — **copied into [`player/`](player/)** — and the Ultra Elements overlay module [`ultra-host/`](ultra-host/) | **Built during the hackathon** (served from hackar-s.com; see `player/README.md`) |
| HACKAR:S-side API additions used by this connector: `POST /api/project-create` extensions (`ultraFx`, `handPlay`, `modelGlbUrl`, expression overlays), `POST /api/asset-store` | **Built during the hackathon** (in the closed-source HACKAR:S repository) |
| HACKAR:S platform itself — the no-code WebAR editor, SLAM player core, accounts, project storage at hackar-s.com | Pre-existing product of HACK IT INC., in production before the hackathon; used here as the publishing target |
| **Ultra Elements** — the five spell effects are from the open-source three.js library [Humpalumps/ultra-elements](https://github.com/Humpalumps/ultra-elements), **MIT License** | Pre-existing third-party OSS, credited here as required |

## Architecture

- `api/mcp.js` — single-file MCP server (Streamable HTTP, stateless) on `@modelcontextprotocol/sdk`. `api/glb.mjs` — the dependency-free GLB builder (the PNG codec is shared with `mcp.js`). `api/talk.js` — poke-to-talk endpoint (Muse Voice transcription + Muse Spark in-character reply).
- **State & identity**: sessions are keyed by a random owner id carried in an HMAC-signed conversation card (`HC1.…`). A nickname alone never resumes another person's session — consent, theme and AR state travel only with the card. The server refuses to start when `CARD_SECRET` is unset (the old default was public, so cards would be forgeable).
- **Persistence**: generated art, GLBs and face variants are stored through HACKAR:S `POST /api/asset-store` at compose time, so publishing works from any server instance; in-memory copies are only a cache.
- `muse-spark-1.3` is a reasoning model: compose uses `max_tokens: 2500`, retries once on empty content, strips code fences, and falls back to the template on failure.
- The Blender pipeline in `pipeline/` is the reference implementation the JS builder was ported from (same timelines, weights and proportions — the in-house plate recipe: thickness = height/15, rim colour = median edge colour, opaque flooded texture, mask eroded ~2px so the rim never opens a see-through hole).

## Tools

| Tool | What it does |
|---|---|
| `start_create` | Consent check (nothing proceeds without an explicit yes), binds the session, collects the theme in the user's own words |
| `compose_ar` | Muse Spark composition (incl. name/persona/spell) + Muse Image artwork + face variants, builds and stores the semi-3D GLB |
| `publish_ar` | Creates the real HACKAR:S project (GLB + Ultra spell + Hand Play + expressions) and returns the hackar-s.com URL — the only deliverable URL |
| `remix_ar` | Same character, different spell; then publish again |
| `issue_certificate` | Issues the certificate page (one per creator) with model usage and the work's URL |
| `make_play` | Muse Spark writes a quiz, riddles and a stamp rally hosted by the published character; stored at hackar-s.com/play/<id>, plus a short **join code** (e.g. `SUNNY-4821`) |
| `play_rally` | The visitor side, inside Muse: say the join code, say where you are, answer the character's question — Muse checks it and hands out the stamp. Answers are salted hashes, so Muse itself can't see or leak them; progress is a signed token. Clear every spot and the character's AR link arrives |

## Setup

Environment variables (Vercel project settings):

- `MODEL_API_KEY` — Meta Model API key issued at dev.meta.ai. The $150 hackathon credit is consumed through this key.
- `CARD_SECRET` — HMAC secret for the signed card / page tokens. **Required**: the server refuses to start without it.
- `PUBLIC_BASE_URL` — public origin of this deployment, e.g. `https://hackathon-ar-creator.vercel.app`.
- `HACKARS_API_KEY` — API key for the HACKAR:S project-create / asset-store endpoints.

## Develop

```bash
npm install
npx vercel dev   # or deploy with: npx vercel --prod
```

Connect the deployed `/mcp` endpoint as a custom connector in the Muse app, then say "I want to make an AR".

## License

© 2026 HACK IT INC. All rights reserved. This repository is public so the hackathon judges can review the work; no license to use, copy or modify it is granted. Third-party components keep their own licenses — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The spell effects come from **Ultra Elements** by Humpalumps (https://github.com/Humpalumps/ultra-elements), MIT License.

## Ray-Ban Display web app (prototype)

`glasses-app/` is an HTML web app built to the Meta Ray-Ban Display spec. It runs in Meta's official simulator and has not been tested on hardware. Every screen in it is a scripted demo: home devices, shopping and the other daily-life screens are not connected to anything.
