# What was built during the hackathon

The hackathon ran from Oct 26 to Nov 4, 2026 (deadline Nov 4, 21:00 ET = Nov 5, 11:00 in Japan). All the work below is inside that window. Times are UTC unless marked.

## This repository

All of our own code. The first commit is Nov 2, 2026, 10:51 in Japan; see `git log --date=iso`. The history was cleaned once to remove unrelated client material, and the commit dates were kept. Third-party code bundled here is not ours and is listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md): Ultra Elements in `ultra-host/vendor/ultra-elements/` and the earlier copies in `engine/`, `scene/` and `vfx/`, and the other libraries listed there.

## The closed-source HACKAR:S repository

HACKAR:S itself is not part of this submission, so these additions cannot be run from here. The files that run on the phone are copied into [`player/`](player/) so that they can be read.

| When | Change (pull request or commit in the HACKAR:S repository) | Public copy |
|---|---|---|
| Nov 2, 07:42 – 21:56 | `POST /api/project-create`: new API that creates a real project with an API key, then its additions: GLB artwork, `ultraFx`, `handPlay`, floor shadow, API key management | Called from [`api/mcp.js`](api/mcp.js) |
| Nov 2, 19:13 | #30 Ultra Elements spells on the placed character | [`ultra-host/`](ultra-host/), [`player/slam-app.additions.js`](player/slam-app.additions.js) |
| Nov 2, 19:38 – 23:22 | #31, #33, #34, #35, #38 Hand Play: pinch to carry, poke to talk, palm for a spell, emotion clips and faces | [`player/fx/hand/hand-play.js`](player/fx/hand/hand-play.js) |
| Nov 2, 19:42 | #32 Contact-shadow planes in the GLB | [`api/glb.mjs`](api/glb.mjs) |
| Nov 2, 22:41 – 22:51 | #36, #37 Talk button, same-origin proxy, iOS audio | [`player/fx/hand/talk.js`](player/fx/hand/talk.js) |
| Nov 2, 23:31 – Nov 3, 00:37 | #39 – #43 Choreography, wish game, 20-second challenge, shared ranking | [`moves.js`](player/fx/hand/moves.js), [`game.js`](player/fx/hand/game.js), [`server/ar-rank.js`](player/server/ar-rank.js) |
| Nov 3, 01:21 – 11:22 | #44 – #54 Virtual pet, cozy interface, fingertip buttons, shadow fixes | [`pet.js`](player/fx/hand/pet.js), [`cozy.js`](player/fx/hand/cozy.js) |
| Nov 3, 18:25 – 18:32 | #55, #56 Landscape layout; asking by voice makes the character move | [`player/fx/hand/hand-play.js`](player/fx/hand/hand-play.js) |
| Nov 3, 19:13 – 20:09 | #57, #58, #60 Quiz, riddle and stamp rally pages | [`player/play.html`](player/play.html) |
| Nov 3, 19:49 | #59 Sending talk text from the emulator | [`player/fx/hand/hand-play.js`](player/fx/hand/hand-play.js) |
| Nov 3, 23:18 | #61, #62 Named write-once files in `POST /api/asset-store`; pet panel position | Called from [`api/mcp.js`](api/mcp.js) |
| Nov 4, 05:35 | #63 `?film` view for the demo video (hides the capture, camera and mute buttons and the watermark) and `?lang` talk language | Not copied (two URL parameters in the player core) |
| Nov 4, 21:22 | #64 Web rally accepts an answer given in a sentence | [`player/play.html`](player/play.html) |

## Not built during the hackathon

- HACKAR:S: the no-code editor, the SLAM player core, accounts and project storage. HACK IT's own product, in production before the hackathon.
- [Ultra Elements](https://github.com/Humpalumps/ultra-elements): the five spell effects. Third-party open source, MIT License.
