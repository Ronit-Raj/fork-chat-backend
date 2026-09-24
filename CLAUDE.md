# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`fork-chat-backend` is an Express + Prisma/Postgres backend for an AI chat app whose defining feature is **endless forking/branching** of conversations. Any message in any chat can be forked into a new, independent chat that shares history up to that point. The full route/data-model contract is in `plan.md` at the repo root — read it before making structural changes.

## Commands

- Build: `npm run build` (runs `tsc`, emits to `dist/`)
- Dev (hot reload): `npm run dev` (`tsx watch src/index.ts`)
- Run built output: `npm start` (`node dist/index.js`)
- Test: `npm test` (`vitest run`) — run a single file with `npx vitest run tests/chat-flow.test.ts`. No linter is configured yet.

### Database (Prisma + Postgres)

- Start local Postgres: `docker compose up -d` (Postgres 16 on `localhost:5432`, db `fork_chat`, user/pass `postgres`/`postgres`)
- Prisma config lives in `prisma.config.ts` (not the schema-file defaults) — schema at `prisma/schema.prisma`, migrations at `prisma/migrations`, datasource URL from `DATABASE_URL` in `.env`.
- After editing `schema.prisma`: `npx prisma migrate dev --name <description>` (regenerates the client automatically)
- Deploy existing migrations: `npx prisma migrate deploy`
- **Prisma 7 requires an explicit driver adapter** — `PrismaClient` cannot be instantiated bare. `src/db.ts` wires `@prisma/adapter-pg`'s `PrismaPg` with `DATABASE_URL`; if you ever recreate the Prisma client elsewhere, you must do the same or it throws at construction time.

## Architecture

### Materialized-path forking (the core design)

Chats are stored as a tree using a **materialized path** column (`Chat.path`), not adjacency-list/nested-set. Every row's `path` is the full ancestry chain of chat IDs down to and including itself:

- Top-level chat with id `uuid1` → `path = "/uuid1"`
- Forking that chat → new row, `path = "/uuid1/uuid2"`
- Forking `uuid2` → new row, `path = "/uuid1/uuid2/uuid3"`

Consequences that matter when touching chat routes (`src/modules/chats/chats.controller.ts`):
- **Top-level chats** for a user are rows whose path has exactly one segment. Prisma's query builder can't express "no second slash," so this one query uses `prisma.$queryRaw` with a Postgres regex (`path ~ '^/[^/]+$'`).
- **Descendants of a chat** (used by `GET /children/:chatid` and the cascading `DELETE /:chatid`) are found via `path: { startsWith: '<parentPath>/' }`, which Prisma compiles to a safe, parameterized `LIKE 'prefix%'`.
- **Cascading delete** deletes the target chat *and* every row whose path is prefixed by the target's path — i.e. the whole subtree, not just direct children.
- Every chat-scoped route re-checks `chat.userId === req.userId` before acting (via `findOwnedChat` in `chats.ts`) and returns 404 (not 403) on mismatch, to avoid leaking chat existence across users.

### Message persistence model

Streaming and persistence are decoupled, and only for continued chats: an SSE reply is streamed to the client immediately via the AI SDK's `pipeUIMessageStreamToResponse` (`src/llm.ts`), and the database write (an `UPDATE` appending the new user/assistant messages) happens **only in `streamText`'s `onFinish` callback**, once the full assistant response is known. There is no partial/interim row — if the LLM call fails or the client disconnects mid-stream, nothing is persisted. The DB write is fire-and-forget from the request handler's perspective (the HTTP response has already been fully sent by the time it runs), so failures are only `console.error`-logged, not surfaced to the client.

**Model selection**: `POST /message/:chatid` takes an optional `model` in the body, validated against the `MODELS` allowlist in `src/llm.ts` (400 on an unknown id, so a client can't make the backend bill an arbitrary model) and passed through to `streamAssistantReply`. `GET /models` serves that allowlist plus `DEFAULT_MODEL_ID` so the frontend doesn't duplicate it; it must stay registered above `GET /:chatid`, which would otherwise match `/models` as a chat id. Nothing about the choice is persisted — the frontend keeps it per chat in localStorage alongside title/forkedAt, and sends it with each message.

**Forking is NOT streamed**: `POST /fork/:chatid` (no request body) synchronously creates a new row copying the parent's `userId`, `path` + new UUID, and `messages` (the shared history), returning `201 { chatId, path, messages }` — no LLM call, no `onFinish`. The fork's first message is sent like any other via `POST /message/:chatid`.

Stored message shape is the minimal `{ role: 'user' | 'assistant', content: string }` — not the AI SDK's richer `UIMessage`/`ModelMessage` types. Conversion happens at the `llm.ts` boundary.

### Auth

Stateless JWT bearer auth, no refresh tokens (per `plan.md`, extended beyond it with OAuth below). `src/modules/auth/auth.controller.ts` handles `POST /auth/signup` and `POST /auth/login` (unprotected); every other route is mounted behind `authenticate` middleware (`src/middleware/auth.ts`), which verifies the token and sets `req.userId` (type-augmented in `src/types/express.d.ts`). Passwords are hashed with `bcryptjs`. The JWT payload carries `{ userId, email }` (see `src/lib/jwt.ts`) — the frontend decodes `email` client-side instead of calling a `/me` endpoint.

### OAuth (Google + GitHub, beyond `plan.md`)

`User.passwordHash` is nullable and a separate `OAuthAccount` model (`provider`, `providerAccountId`, unique together, `userId` FK) links one or more OAuth identities to a `User` — not `googleId`/`githubId` columns on `User` directly, so adding a third provider later doesn't touch the `User` table.

No Passport.js and no `express-session`: `src/lib/oauth.ts` does the authorization-code exchange by hand with `fetch` against each provider's token/userinfo endpoints. The CSRF `state` param is a short-lived JWT (`createOAuthState`/`verifyOAuthState`, 10 min expiry, signed with `JWT_SECRET`) rather than a server-stored value, so the OAuth handshake needs no session/cookie store and stays consistent with the rest of the app's stateless design.

Flow: browser does a full-page navigation (not `fetch`, so CORS doesn't apply) to `GET /auth/google` or `GET /auth/github` (`src/modules/auth/oauth.controller.ts`), which redirects to the provider's consent screen. The provider redirects back to `GET /auth/:provider/callback`, which exchanges the code, fetches the profile, finds-or-creates the `User`/`OAuthAccount` (see below), mints a normal JWT via `signToken`, and redirects the browser to `${FRONTEND_URL}/callback?token=<jwt>`. The frontend's `/callback` page (`app/(auth)/callback/page.tsx`) reads the token, hands it to `AuthProvider.loginWithToken`, and routes to `/`. On failure it redirects to `${FRONTEND_URL}/callback?error=<code>` instead.

Account linking: lookup is first by `(provider, providerAccountId)`; if no `OAuthAccount` row exists, it upserts a `User` **by email** and attaches a new `OAuthAccount` to it. Because `User.email` is unique, this means an OAuth login silently links to any existing account (password-based or a different provider) sharing that email — Google's `email_verified` and GitHub's verified-primary-email are checked before ever using the email, so this trusts the provider's verification, not the request. For a stricter posture (e.g. requiring the user to confirm via their existing password before linking), gate the upsert on an explicit user confirmation step instead of doing it silently.

Env vars: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (Google Cloud Console → OAuth client ID → Web application), `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` (GitHub → Developer settings → OAuth Apps), plus `BACKEND_URL` (used to build the `${BACKEND_URL}/auth/<provider>/callback` redirect URI registered with each provider) and `FRONTEND_URL` (where the browser is sent after login). All four live in `.env` alongside the existing vars — see the comments there for the exact callback URLs to register.

### Route creation gap (resolved beyond `plan.md`)

`POST /chats` and `GET /models` are the two routes that exist beyond `plan.md`'s list.

`plan.md`'s route list has no way to create a brand-new top-level chat — `POST /fork/:chatid` needs an existing parent, and `POST /message/:chatid` 404s on an unknown chat ID. `POST /chats` (server generates the chat ID, creates an empty row with `path = "/<id>"`) was added to fill this gap; it isn't in `plan.md` itself.

### Tests

`tests/chat-flow.test.ts` is a single sequential integration test (Vitest + Supertest) that walks the whole fork lifecycle against the real dev Postgres db: signup → create chat → send message (persisted) → fork (synchronous, history copied) → continue the fork with a message (persisted) → list children → list top-level chats → cascading delete → 401 without a token. It imports `app` directly from `src/app.ts` (not `src/index.ts`) so no port is bound — that split exists specifically so tests don't need a running server process.

The Gemini call is mocked at the `src/llm.ts` boundary (`vi.mock('../src/llm.js', ...)`), not inside the AI SDK — the fake `streamAssistantReply` writes a deterministic SSE payload and echoes the user's message back, so tests don't need `GOOGLE_GENERATIVE_AI_API_KEY`, network access, or tolerate model nondeterminism. Everything below that boundary (routing, auth, Prisma writes, the materialized-path tree) runs for real.

Because DB writes happen in a fire-and-forget `onFinish` callback (see above), assertions that depend on persistence poll briefly via the `waitFor` helper instead of asserting immediately after the HTTP response — a fixed `sleep` would be flaky under load and an immediate assertion races the write.

Tests run against the same dev database as `docker compose up -d` (no separate test DB is provisioned) using a randomly-generated email per run; the `afterAll` hook deletes the test user, which cascades to their chats via the schema's `onDelete: Cascade`.

### Module/env conventions

- ESM throughout (`"type": "module"`, `tsconfig` targets `nodenext`) — relative imports need explicit `.js` extensions in source (e.g. `import { prisma } from '../db.js'`), matching Node's ESM resolution of the compiled output.
- Required env vars: `GOOGLE_GENERATIVE_AI_API_KEY` (Gemini), `DATABASE_URL` (Postgres), `JWT_SECRET`, `PORT` (defaults to 3000 if unset), `BACKEND_URL`, `FRONTEND_URL`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` (see OAuth section above).
- Selectable LLM model ids live in the `MODELS` allowlist in `src/llm.ts` (`DEFAULT_MODEL_ID` is used when a request names none).
- `tsconfig.json` enables `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` on top of `strict` — indexed/param access (e.g. `req.params.chatid`) types as possibly-`undefined`.
