# AR Creator — Talk to Muse, unlock AR

An MCP connector for the **Meta Global AI Developer Hackathon** (Cerebral Valley, Oct 26 – Nov 4, 2026), built by HACK IT INC.

Say a one-word theme in Muse, and this connector:

1. **Composes** the AR server-side with the Meta Model API — `muse-spark-1.3` designs the title, overlay text, base color and particle effect (JSON), and `muse-image-1.0` generates one artwork image. Token usage is logged on every run as Tooling evidence.
2. **Publishes** an app-less WebAR page (`/ar/<signed-token>`): camera view + a three.js particle effect (flame / ice / lightning / petal) + the generated artwork + title. Opens on any smartphone, no app install — the HACKAR:S way.
3. **Certifies** the creation with a signed certificate page (`/c/<signed-token>`), one per creator.

If the model API is unavailable (no key, network error, bad output), composition falls back to a deterministic template so an AR always stands up.

## Architecture

- `api/mcp.js` — single-file MCP server (Streamable HTTP, stateless) using `@modelcontextprotocol/sdk` (`McpServer` + `WebStandardStreamableHTTPServerTransport`, JSON responses).
- State is held two ways: in server memory, and in an HMAC-signed "card" memo (`HC1.…`) that travels with the conversation — the same pattern proven in our an earlier in-house prototype connector tests, so progress survives reconnects.
- AR and certificate pages are self-describing: the minimal display data is embedded in an HMAC-signed token in the URL, so pages survive server restarts.
- The generated image is too large for a URL token (~430 KB WebP as `b64_json`), so it is held in server memory under a short ID and served from `/img/<id>`; if it is gone, the AR page hides the image card and still works with effects + text (graceful degradation). Token usage for both models is normalized and kept in the conversation card and in the AR token, and is printed on the certificate page as Tooling evidence.
- `muse-spark-1.3` is a reasoning model: compose requests use `max_tokens: 2500`, retry once when the content comes back empty, strip code fences before parsing, and fall back to the template on failure.
- `public/index.html` — landing page. `vercel.json` — rewrites `/mcp`, `/ar/:token`, `/c/:token`, `/img/:id` to the function.

## Tools

| Tool | What it does |
|---|---|
| `start_create` | Consent check (nothing proceeds without an explicit yes), then collects the theme in the user's own words |
| `compose_ar` | Runs Muse Spark + Muse Image via the Meta Model API, builds the composition, returns the public AR URL and a token-usage summary |
| `publish_ar` | Returns the public URL and a QR-code link |
| `issue_certificate` | Issues the certificate page (one per creator, re-issues the same link) |

## Setup

Environment variables (Vercel project settings):

- `MODEL_API_KEY` — Meta Model API key issued at dev.meta.ai. The $150 hackathon credit is consumed through this key.
- `CARD_SECRET` — HMAC secret for the signed card / page tokens.
- `PUBLIC_BASE_URL` — public origin of this deployment, e.g. `https://hackathon-ar-creator.vercel.app`.

## Develop

```bash
npm install
npx vercel dev   # or deploy with: npx vercel --prod
```

Connect the deployed `/mcp` endpoint as a custom connector in the Muse app, then say "I want to make an AR".

## License

MIT. The particle effects are a minimal original extraction of the ideas behind common three.js element effects (spawn / velocity / life / color ramp).
