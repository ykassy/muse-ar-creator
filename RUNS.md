# Every run (Nov 4, 2026 ET, Nov 5 in Japan)

Our own runs against the live connector, in order. "Direct" is a script calling the MCP endpoint; "Muse" is the Muse app, starting from "Moshi Moshi". Compose and publish are seconds inside the server call. In Muse runs the whole wait is longer, because Muse thinks between calls.

Versions: **A** first version · **B** drawing starts alongside the design, long calls kept alive · **C** short card, session saved on the server · **D** the color-key cut-out stays when SAM would drop a held object · **E** `publish_ar` refuses a failed drawing until the user agrees, and a model too large to store shrinks to fit · **F** the same for someone else's IP, only the textures shrink, and a failed back view is tried again.

| # | Ver. | Path | Theme | Compose s | Publish s | Self-check | Notes | Result |
|--:|:-:|---|---|--:|--:|---|---|---|
| 1 | A | direct | cloud cafe, umbrella | 86.5 | 26.6 | 4→7 |  | [f776df2d](https://hackar-s.com/slam-ar/f776df2d-049b-42f0-ac32-0ac47b3a42d2) |
| 2 | A | direct | smiling cloud, umbrella | 54.7 | 26.7 | pass |  | [47df1d75](https://hackar-s.com/slam-ar/47df1d75-d7ed-42ca-b97c-71e3ea70ae02) |
| 3 | A | direct | smiling cloud, umbrella | 60.7 | 27.8 | pass |  | [b79804ab](https://hackar-s.com/slam-ar/b79804ab-d985-4816-bad6-2a84d7ea476a) |
| 4 | A | direct | cloud cafe, umbrella | 93.2 | 27.5 | redrawn |  | [2ad72c36](https://hackar-s.com/slam-ar/2ad72c36-825f-49e6-80c4-ae46f8d88a42) |
| 5 | A | direct | fox with a lantern | 70.6 | 27.5 | pass |  | [a33df7b4](https://hackar-s.com/slam-ar/a33df7b4-ba82-43f8-96e8-9302bec1e413) |
| 6 | A | Muse | moon rabbit | 66, 65 | – | pass | Call dropped at about 50 s. Muse composed a second time. | [9cb53dc1](https://hackar-s.com/slam-ar/9cb53dc1-d925-42ee-bb65-67ea68bb05b1) |
| 7 | A | direct | cloud cafe, umbrella | 76.2 | 28.7 | 4→10 | The example in the video | [edc7e090](https://hackar-s.com/slam-ar/edc7e090-7dd5-4e57-9ea2-d692998d4079) |
| 8 | A | Muse | sketch of a cloud | 51.4 | – | 6→6 | Call dropped. Lost its umbrella. | [d51e7fe9](https://hackar-s.com/slam-ar/d51e7fe9-ae08-4a96-bdd1-d89e09bb797d) |
| 9 | A | direct | same theme as 8 | 46.7 | 28.3 | 10/10 |  | [89d0ed7f](https://hackar-s.com/slam-ar/89d0ed7f-0f7e-4f64-9259-799ac3360bf7) |
| 10 | A | Muse | sketch of a cloud | 52.8 | – | pass | Call dropped, Muse recovered. Drizzly, the cloud in the video | [350e9339](https://hackar-s.com/slam-ar/350e9339-746e-4d64-86be-52161c4bd46b) |
| 11 | A | direct | dragon | 89.9 | 28.3 | 4→8 | GLB too large to store, so its back came out black | [402f03c1](https://hackar-s.com/slam-ar/402f03c1-5e2d-4ff1-80c8-662ad2d3c376) |
| 12 | A | direct | dragon | 91.7 | 27.2 | redrawn | Back plate halved, GLB stored | [b9175e64](https://hackar-s.com/slam-ar/b9175e64-4ea9-4283-b678-9ff45b03e178) |
| 13 | B | Muse | tea-loving dragon | 60.4 | 26 | 10/10 | First Muse run with no dropped call | [36711a5e](https://hackar-s.com/slam-ar/36711a5e-1000-4ba0-bc8f-1047f5df1083) |
| 14 | B | direct | festival lantern | 40.2 | 23.8 | 9/10 |  | [b805c481](https://hackar-s.com/slam-ar/b805c481-bd41-4c5a-882c-d3e0c42cc1f5) |
| 15 | B | direct | sushi chef cat | 44.0 | 27.2 | 10/10 |  | [007f97a7](https://hackar-s.com/slam-ar/007f97a7-66e8-4431-bec3-7df82ffdf932) |
| 16 | B | direct | shrine fox | 54.2 | 28.7 | 10/10 |  | [5fdbc458](https://hackar-s.com/slam-ar/5fdbc458-2a2c-435e-aee7-271374df7d8d) |
| 17 | B | direct | robot gardener | 42.1 | 26.2 | 10/10 |  | [5dac269d](https://hackar-s.com/slam-ar/5dac269d-33b4-4055-8961-88b51714a3ed) |
| 18 | B | direct | rice cracker | 41.1 | 26.9 | 10/10 |  | [44d75b48](https://hackar-s.com/slam-ar/44d75b48-d283-4ca6-99e0-50cd8a899095) |
| 19 | B | direct | seagull keeper | 53.0 | 25.3 | 10/10 |  | [9acab641](https://hackar-s.com/slam-ar/9acab641-3f08-4afd-a04a-31f53e6a5db2) |
| 20 | B | direct | cloud cafe, umbrella | 77.8 | 25.9 | 4→7 | Failed the check. The test script published it anyway. | [cd6eaedf](https://hackar-s.com/slam-ar/cd6eaedf-6442-4418-9623-748bb81d4dab) |
| 21 | B | direct | dragon with a lantern | 66.2 | 27.3 | 7, redraw no better | Failed the check. Published by the script. | [10cca003](https://hackar-s.com/slam-ar/10cca003-cc38-471f-b44a-8a68f95855d0) |
| 22 | B | Muse | cloud cafe, umbrella | 65, 50, 45 | – | 6→10, 6, 10 | Call held, but publish could not read the long card three times. Muse composed twice more, about 8 minutes in all. Led to the short card. | [e1b25055](https://hackar-s.com/slam-ar/e1b25055-b0ff-4916-b416-41330d0aafc4) |
| 23 | C | direct | teapot | 47.5 | 30.2 | 10/10 |  | [ff34b502](https://hackar-s.com/slam-ar/ff34b502-9e09-49f9-91c5-b3ca13cf394f) |
| 24 | C | direct | paper crane | 54.9 | 27.2 | 10/10 | Reply thrown away on purpose, published from an old card: right character | [e8c9001e](https://hackar-s.com/slam-ar/e8c9001e-0f88-457b-9338-55952aa60177) |
| 25 | C | direct | snow globe | 42.9 | 28.8 | 10/10 | Published from the oldest card; a second call during compose was told to wait | [bdfcc6e2](https://hackar-s.com/slam-ar/bdfcc6e2-1b40-4268-b455-c90cfcc0e216) |
| 26 | D | direct | cloud cafe, umbrella | 42.5 | 29.4 | 10/10 | Same theme as 1, 4, 7, 20, 22: passed first time | [413a3881](https://hackar-s.com/slam-ar/413a3881-cde0-476d-b415-586d3d55f8fb) |
| 27 | D | direct | dragon with a lantern | 40.1 | 25.8 | 10/10 | Same theme as 21: passed first time | [a1b734be](https://hackar-s.com/slam-ar/a1b734be-2446-4d7a-9b3b-33d601fd38d5) |
| 28 | D | direct | tanuki with a paper fan | 47.0 | 28.2 | 10/10 |  | [a5659122](https://hackar-s.com/slam-ar/a5659122-db54-429d-8a6f-ec2a3ae84251) |
| 29 | C, D | Muse | cloud cafe, umbrella | 63, 44 | 26 | 6, then 10/10 | No dropped call. The first drawing failed the check, so Muse held the publish and asked; we chose "Make a new one". Then a rally in 18 s (DRIZZLEL-2673). Compose, publish, certificate and rally each ran in a different region. | [83aca0ea](https://hackar-s.com/slam-ar/83aca0ea-a373-4667-87d6-7e295ef469c6) |
| 30 | D | Muse | fox with a big fan (Japanese) | 63 | 30 | 10/10 | No dropped call. Compose and publish ran in different regions. | [4920b0e1](https://hackar-s.com/slam-ar/4920b0e1-4469-4c69-822c-5048cee11ff8) |
| 31 | D | Muse | goldfish festival mascot in a happi coat | 46 | 30 | 10/10 | One unbroken session: theme, publish, rally (MATSURIF-4471), join, stamp. No dropped call, no retry. | [842db15b](https://hackar-s.com/slam-ar/842db15b-a716-4e56-b5b9-5325d2aec848) |
| 32 | D | direct | goldfish with a paper fan | 46.1 | 32.0 | 10/10 | Gaps inside the outline now stay see-through | [91a4dd48](https://hackar-s.com/slam-ar/91a4dd48-b58b-498b-a233-d1ab247789a8) |
| 33 | D | direct | green frog in a yellow raincoat | 50.0 | 29.5 | 10/10 |  | [6c9fad8a](https://hackar-s.com/slam-ar/6c9fad8a-1fd4-4e03-8c7c-e2aa39498ed5) |
| 34 | D | direct | shrine maiden girl with a broom | 75.7 | 30.9 | 10/10 |  | [6562673d](https://hackar-s.com/slam-ar/6562673d-1e55-446c-a0fa-f0d055b5507e) |
| 35 | D | direct | ramen mascot with an OPEN sign | 96.2 | 32.8 | 7→10 |  | [1f290a69](https://hackar-s.com/slam-ar/1f290a69-043d-4f76-b981-ef012b80519b) |
| 36 | D | direct | blue whale in a sailor hat | 43.3 | 27.6 | 10/10 |  | [9daa7e27](https://hackar-s.com/slam-ar/9daa7e27-a2e3-49a9-aa40-309668f156fc) |
| 37 | D, refusal added | direct | glass snowman, see-through umbrella, seven apples | 133.7 | 4.4 | 6→7 ("eight apples instead of seven") | `publish_ar` refused it, as it should. After agreeing, publishing failed: this detailed drawing made a 4.7 MB model, the asset store refused it, and there was no model to publish. Led to version E. | no link |
| 38 | E | direct | same theme as 37 | 102.9 | 33.5 | 7→9 | The model shrank to fit | [f4b811c6](https://hackar-s.com/slam-ar/f4b811c6-064c-4a4c-80c9-034b47962d0b) |
| 39 | E | Muse | same theme as 37 | 60.7 | 32 | 9/10 | The model shrank from 1600 to 1427 pixels wide and was stored. No dropped call. | [2967001c](https://hackar-s.com/slam-ar/2967001c-bafd-4058-adce-fd945b7b95fa) |
| 40 | E | Muse | keyboard mash (asdfghjkl) | 88.6 | 32 | 2→4 | Failed the check twice. Muse stopped and asked; we said "Publish it anyway", and it passed `confirmed: true`. | [e5413c8f](https://hackar-s.com/slam-ar/e5413c8f-74c6-4536-948f-89e95d0d5337) |
| 41 | F | Muse | goldfish festival mascot in a happi coat | 49, 59 | 27 | 10/10 | One unbroken session on the final code, shown in the video: theme, publish, rally (MATSURIP-5006), join, stamp, 456 s from "Moshi Moshi" to the first stamp. Muse called `compose_ar` a second time 13 seconds after the first finished, so a second drawing was made and published. Muse's client had lost the first reply (see below). | [17cfa3cb](https://hackar-s.com/slam-ar/17cfa3cb-2757-426f-928f-9d63ec3b9d6a) |

## What happened in run 41

We asked Muse afterwards, in the same chat, and compared its answer with our log (times UTC).

| When | Our log | Muse's account of its tool history |
|---|---|---|
| 22:38:40 | `initialize`, `notifications/initialized`, then no `tools/call` | First try failed after about 1 s: "MCP request did not complete" |
| 22:38:43 | `tools/call compose_ar` | The retry |
| 22:39:33 | The first character finishes, 49 s in | About 53 s in: "event stream ended before the matching result". No character, no card |
| 22:39:46 | `tools/call compose_ar` again, same theme | Called again over curl, "which can hold longer" |
| 22:40:45 | The second character finishes, 59 s in. This is the one that was published | The reply arrived |

Muse also described how its client reads a stream: a 45-second socket timeout, `readline()` in a loop, comment lines skipped, and that error only when the stream ends before a result with the matching id. By that account, the stream ended before a matching result arrived. We wrote a client that reads the same way and called `compose_ar` on the live server from outside Muse: the comments came every 8 seconds, and the result arrived and matched at 49.3 seconds, the same length as the failed call. That check did not reproduce the failure. It does not rule out something specific to Muse, and we still do not know what ended that stream. Since then, `compose_ar` treats a card older than the character as a possible lost reply: the same request (same theme, spell and language) within five minutes, before publishing, gets the same character back and nothing is drawn. A caller with the newest card, or with a different request, still gets a new one. The page at `/try` repeats the same call with the same card when a reply is lost. `tools/test_session.mjs` covers these cases, and fails with the fix taken out. On the live server, calling again with the old card gave back the same character in 4 seconds. It has not met another real lost reply in Muse yet.

## Through the browser page

The page at `/try` came after the video. It calls the same connector, without Muse. These are our own checks of the page and are not in the count above.

| Theme | Compose s | Publish s | Self-check | Notes | Result |
|---|--:|--:|---|---|---|
| a snail on a rainy day, in Japanese | 67 | 25 | 6→10 | Redrawn after "holes in umbrella canopy". Stamp rally made from the page in 23 s (PLAY-5668) | [a686cba4](https://hackar-s.com/slam-ar/a686cba4-afb8-4442-9dcc-022d680d2c81) |
| a bonfire spirit | 57 | 26 | 10/10 | Model turned in the page. Typed "Show me your magic!" before publishing: Spark chose `spell` | [9c36a26b](https://hackar-s.com/slam-ar/9c36a26b-6c5f-4d04-ac79-7f690aad437c) |
| Kaki-chan, from a three-view sheet (a test sheet made with Muse Image for this check) | – | – | 10/10 | Front and back are the sheet's own pixels, no model drew them. The page asked about the rights first. This is the model in the video's closing scene | [12d96a90](https://hackar-s.com/slam-ar/12d96a90-6d3c-4cd8-8526-a12e64822f2f) |

## Stopped before publishing

These ran after the runs above and did not try to publish, or were stopped on purpose, so they are not in the count.

| Path | Theme | Compose s | Self-check | What happened |
|---|---|--:|---|---|
| direct | Pikachu holding a sword | 66.1 | 10/10 | Nothing stopped it, which is why `publish_ar` now asks about someone else's IP |
| direct | rice ball fairy in Japanese, with an emoji | 82.8 | 10/10 | Theme handled as given |
| direct | keyboard mash (asdfghjkl) | 76.9 | 3/10 | Failed, as it should |
| direct | harbor mascot, a theme of 160 characters | 50.7 | 10/10 | Theme handled as given |
| direct | Pikachu holding a sword | 47.7 | 10/10 | `publish_ar` refused it: "This uses Pikachu, which may belong to someone else" |
| Muse | Pikachu holding a sword | – | 10/10 | Muse held it: "Do you own Pikachu, or do you have permission to use it?" We said no. Not published. |
| Muse | Kumamon in a happi coat | – | 10/10 | Muse held it and asked the same question. Not published. |
| direct | a paper boat on a river | 49.3 | 9/10 | Stream check for run 41, read line by line the way Muse's client reads it. The result arrived. Not published. |
| direct | a tiny kite over the sea | 34.4 | passed | Lost-reply check: the same call again with the old card returned the same character in 4.2 s, with nothing drawn. Not published. |
| direct | the same three-view sheet with its views in reverse order | 29.9 | 10/10 | Sheet-reading check: Spark answered front 3, back 1, and the front stayed the front. Not published. |
| page | a photo of a marker sketch of a cloud | – | 10/10 | Own-picture check: a Muse Image edit kept the marker lines and removed the paper and the desk. Not published. |
| page | a paper lantern fish | 77 | 7→10 | Lost-reply check through `/try`: the reply was dropped on purpose in the browser, the page repeated the call with the same card, and the same character came back in 5 s (`compose-resumed` in the log). Not published. |

## Looked at by eye

The self-check grades a 2D cut-out. So we also opened the models of runs 26–41 (14 of them, all but runs 29 and 37) in the AR emulator and turned them from the front to the back. The fronts all held up. From behind, 11 read as a back. Run 31's back edit got an HTTP 500, so its back is a dark plate; the edit is now tried twice, and a plate with no back drawing takes the body's color. In runs 27 and 34 the back drawing did not line up with the front outline, and parts of the front drawing showed through; those parts now take the body's color too, but a back drawing that does not line up still looks doubled.
