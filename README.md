# PulseCord

PulseCord is a browser-based communication app with an Express/TypeScript API, PostgreSQL persistence through Prisma, Socket.IO realtime events, and LiveKit SFU voice/video transport. This repository is a deployable foundation, not a claim that every Discord-style feature is complete. Live media requires a separately provisioned LiveKit service and was not end-to-end verified without real service credentials and multiple browsers.

## Implemented

- **Authentication:** account registration and login, bcrypt password hashes, signed 30-minute bearer tokens, authenticated API routes, rate limits, and sign-out. The first account is not automatically seeded; it can create a server and becomes its owner.
- **Persistent text chat:** messages, replies, edits, pins, reaction JSON, and thread metadata are stored in PostgreSQL. Message create/update/delete events are emitted through Socket.IO to channel members after database writes. Direct-message records and group conversation messages are stored and sent to each participant's authenticated Socket.IO user room.
- **Realtime reconnection:** Socket.IO rejoins the currently selected channel after reconnect. LiveKit uses its client reconnect behavior plus up to five application-level retries with exponential backoff and a fresh server-issued token.
- **Voice, camera, and screen share:** LiveKit room tokens are minted by the backend and scoped to one voice channel. Microphone, camera, and screen-share grants are checked against server-side role permissions. The browser publishes actual microphone/camera/display tracks and attaches actual remote tracks; synthetic camera/screen feeds were removed.
- **Servers and permissions:** server creation, invite codes, joining, channel creation/deletion, role creation/editing, member role assignment, kicking, bans, and basic audit records are implemented. Server authorization is enforced on the backend, not trusted to UI checks. A default `@everyone` role provides view, text-send, and voice connect/speak access; privileged permissions and role assignment are owner-restricted.
- **User presence/profile basics:** status, custom status, bio, friend requests with incoming/outgoing states, accept/block/remove, and one-to-one/group text DMs.
- **CSP-safe UI/build:** rendered controls use delegated external JavaScript listeners instead of inline event handlers. Tailwind is compiled locally into a minified stylesheet; the JavaScript CSP permits same-origin scripts only and explicitly blocks inline event attributes.
- **Production packaging:** Dockerfile, Railway manifest, health endpoint, Prisma initial migration, `.env.example`, `.dockerignore`, lockfile, a local favicon, and a TypeScript production build.

## Explicit limitations

- **Attachments are not implemented.** No file bytes or placeholder attachment is stored. The upload control was removed; S3/R2 settings are not read by the app.
- **Direct-message voice/video calls are not implemented.** Their buttons return an explicit message directing users to server voice rooms; DM audio/video is not presented as working.
- **LiveKit operation is conditional.** The Railway web service must have the exact server-side variables `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`. The URL may be the provider's `wss://` endpoint (or secure `https://` origin, normalized to `wss://` for browser clients); production rejects insecure `ws://`/`http://`. Access JWTs are signed only on the server and scoped to a voice room. Track publish grants use the SDK's `TrackSource` enum. Missing/invalid config returns a descriptive non-secret `503`; token-signing errors return a correlation ID and are logged with secrets redacted. This repository does not provision LiveKit or TURN.
- **No email verification, password reset, MFA, or refresh-token flow.** Access tokens expire after 30 minutes; users must sign in again. The bearer token is held in browser local storage, so XSS prevention remains important.
- **Style CSP hardening remains.** Inline JavaScript/event attributes are blocked (`script-src 'self'; script-src-attr 'none'`), but `style-src` still permits inline style attributes used by existing dynamic UI. Remove those style attributes before removing that style allowance.
- **No channel-specific permission overrides, private-channel ACLs, role hierarchy, or moderator-to-moderator hierarchy.** Although the schema has an `is_private` field, the API rejects attempts to set it to `true`; do not use this build for confidential channels.
- **Forum and announcement types are stored/rendered as channel types, but specialized forum posts, announcement publishing/following, and moderation workflows are not implemented.**
- **Search and “load earlier” operate on client-loaded messages.** The client fetches at most 200 messages per table; paging is not an unbounded server-side channel history API.
- **Audit rows are basic application records, not a tamper-proof audit system.** Do not treat them as compliance evidence.
- **Single-instance Socket.IO operation only.** No Redis adapter is configured; multiple web replicas will not share Socket.IO rooms/events without additional adapter work. Voice-session rows may remain stale after abrupt process/browser termination; the UI filters displayed participants against a currently connected LiveKit room.
- **No GitHub repository is configured or pushed automatically.** Follow the commands below with your own remote.

## Requirements

- Node.js 22.22.0 or later and npm. `machina@7.0.1` (via LiveKit client) requires Node >=22.22.
- PostgreSQL 13 or later (Railway PostgreSQL is suitable).
- For voice/video/screen share: a LiveKit project with WebSocket URL and API key/secret.
- A secure origin (`https://`) for browser microphone, camera, and screen capture. `localhost` is also secure for local development.

## Local setup

```bash
cp .env.example .env
# Edit DATABASE_URL, JWT_ACCESS_SECRET, and the LiveKit values.
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
npm test
npm start
```

Open `http://localhost:3000`. The build generates `css/tailwind.generated.css` and the local LiveKit browser bundle under `public/vendor/`. The first registration creates an ordinary account; it does not seed demo users or sample conversations.

See [QA_CSP_TAILWIND_REPORT.md](QA_CSP_TAILWIND_REPORT.md) for the CSP/Tailwind fixes, verification results, and integrations that still require live service testing.

## Deploy to GitHub

From the project root:

```bash
git init
git add .
git commit -m "Prepare PulseCord for Railway"
git branch -M main
git remote add origin https://github.com/<your-account>/<your-repository>.git
git push -u origin main
```

Do not commit `.env`, database dumps, or credentials. The `.gitignore` and `.dockerignore` exclude local secret files and build/dependency folders.

## Deploy to Railway

1. Create a Railway project and choose **Deploy from GitHub repo**, then select the repository. Railway uses the checked-in `Dockerfile` and `railway.json`.
2. Add a **PostgreSQL** service. Confirm the web service receives the Railway-provided `DATABASE_URL` reference. Do not paste a local database URL into production.
3. Create a LiveKit Cloud project (or operate a compatible LiveKit server). In the web service's **Variables**, set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` using the provider's server credentials. The URL should be the provider's `wss://` endpoint. These secrets must stay server-side.
4. Set `NODE_ENV=production`, `JWT_ACCESS_SECRET` to a fresh random secret (at least 32 characters; `openssl rand -hex 32` is suitable), and `BCRYPT_ROUNDS=12`. Set `CORS_ORIGIN` only if you need cross-origin browser access; use the exact public `https://` origin. Same-origin hosting may leave it unset.
5. Deploy. The Docker build runs `npm ci`, generates Prisma Client, builds the browser bundle and TypeScript server. The configured start command runs `npx prisma migrate deploy` and then starts the API/UI server on Railway's `$PORT`.
6. Wait for the Railway health check at `/api/health` to pass. It returns `200` only when the database query succeeds. A successful health check does **not** verify LiveKit media.
7. Verify with two separately authenticated browsers: create accounts; create a server and text/voice channels; join the server using its invite code; send a message and confirm it appears in the other browser and survives reload; then join the same voice room, grant microphone/camera permissions, and test voice, camera, screen share, mute/deafen, network interruption/recovery, and role denial. Repeat after every production configuration change.

Railway deployment status and a two-browser LiveKit test require access to the user's Railway/LiveKit accounts and were not performed as part of this source audit.
