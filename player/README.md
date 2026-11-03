# player/ — what runs on the phone (built during the hackathon)

The published works open in the **HACKAR:S WebAR player** at hackar-s.com. The player itself is HACK IT's
pre-existing, closed-source product. Everything in this folder is the part we **added to it during the
hackathon** (Oct 26 – Nov 4, 2026), copied here so judges can read it. It is served from hackar-s.com in
production; these files are identical to what runs there.

| File | What it does |
|---|---|
| `fx/hand/hand-play.js` | **Hand Play.** MediaPipe HandLandmarker reads the AR camera. Pinch near the character to pick it up: it is carried on an upright plane facing the camera (raise your hand = it lifts, move sideways = it follows, bring your hand closer = it comes nearer), swings from the pinch point like a pendulum and kicks its legs; let go and it falls, bounces and squashes on landing; its floor shadow stays on the floor. Poke it with a finger (or tap it) and it reacts; hold up an open palm and it casts its spell from your hand. Expression faces from Muse Image are fitted onto the model's texture. |
| `fx/hand/moves.js` | **Choreography.** The character is never still: it peels itself up from the floor when placed, then hops a lap around, spin-jumps, big-jumps, looks around, dives flat and pops back up; emotions have their own moves (happy spin, surprised jump, sad droop, angry stomp). Keyframes in the same format as our in-house floor-AR timelines. |
| `fx/hand/talk.js` | **Talk.** A talk button fixed on screen; it listens until you stop speaking (live level meter), sends 16 kHz WAV to `api/talk.js` (Muse Voice Transcribe → Muse Spark, in character, with an emotion), shows the reply over the character's head and speaks it. |
| `fx/hand/game.js` | **Wish game for kids.** The character asks for something, out loud and on a card: lift me up high / carry me to the glowing ring / talk to me / show me magic / pet me / **catch me if you can** (it runs around; tap to blow bubbles at it; it dodges half the time; three hits or a pinch catches it). Granting a wish adds a heart; hearts raise the friendship level. Plus a **20-second challenge**: countdown, timer and score on top, the character gets faster and dodges more (sidestep or jump over) as you score, a pinch is worth 3, and a **shared ranking** per work (name entry, top 10) with the device's own top 5 as the fallback. |
| `server/ar-rank.js` | The shared per-project ranking for the 20-second challenge (HACKAR:S API route `/api/ar-rank`): one small JSON per project in storage, validated scores, rate-limited. |
| `slam-app.additions.js` | Excerpts of what we added inside the player's main file: switching GLB animation clips by name, the Ultra Elements overlay (spell sized to the character, hidden behind it by the character's own silhouette, staying put while the character is carried, warmed up while loading), the Hand Play overlay, a loading spinner, and the two-finger twist direction. Not runnable on its own. |

The Ultra Elements overlay module itself is `../ultra-host/` (bundled into one ES module for the player).

Every addition is **opt-in per project** (an `isUltraFx` / `isHandPlay` overlay, or a GLB with an `idle` clip),
so the other customers' projects on HACKAR:S never load any of it.
