# Contextual Translate — Tasks

Design decisions live in `design/design.md` (D-numbers). Tasks are gated on `design=approved`.
We work these **one at a time, top to bottom**; the order encodes the dependencies. Tasks marked
(owner-run) only produce runbooks/scripts and `.scratch/to-run.md` entries — the owner executes them.

## Design

- [x] Settle MVP design decisions D1–D5 with owner !p0 ^settle-mvp-design-decisi-77a3d6

## Scaffold

- [~] Scaffold backend: Rails 8 API + Sorbet + graphql-ruby, mise.toml, LICENSE, README, .env.example (D1.1, D1.2, D1.5) !p1 #branch=task/scaffold-repo-backend-ra-6b9900 #design=approved #repo=contextual-translate ^scaffold-repo-backend-ra-6b9900
- [ ] Scaffold frontend: pnpm workspace, Vite + React 19 + TS strict, Tailwind, Vite dev proxy to Rails (D1.1, D1.4, D1.6) !p1 ^scaffold-frontend-pnpm-w-1e1ae6
- [ ] Add bin/check gate script and GitHub Actions CI incl. schema/codegen drift check (D1.3) !p2 #design=approved ^add-bin-check-gate-scrip-c6d6ae

## Backend API

- [ ] AccessCode model with ACCESS_CODE_PEPPER HMAC digest and access_codes:create/list/revoke rake tasks (D4.1) !p1 #design=approved ^accesscode-model-with-hm-dfa514
- [ ] POST/DELETE /api/session with Rails encrypted session cookie, session_key, Origin check, filter_parameters, per-request revocation check (D3.1, D4.2) !p1 #design=approved ^post-delete-api-session-2d007a
- [ ] rack-attack: per-IP login throttles and short ban, coarse /graphql cap, /up exempt (D4.3) !p1 #design=approved ^rack-attack-throttles-fo-3ea35d
- [ ] Translator interface with FakeTranslator and ClaudeTranslator (via Claude::ClientFactory: CLAUDE_AUTH=wif|api_key, boot guard, claude:auth_check rake task) using Messages API structured output, timeouts/retries, error mapper to specific codes incl. verifying the spend-limit error (D2.1, D2.2, D2.4, D3.3) !p1 #design=approved ^translator-interface-wit-4fec10
- [ ] System prompt (formality/region handling) and ~15-case eval set incl. formality and regional cases; measure p50/p95 latency at effort low vs medium and record in D2.2 (D2.2, D2.3) !p1 ^system-prompt-formality-42ab27
- [ ] GraphQL schema: viewer query, translate mutation, typed errors, schema dump (D3.2, D3.3) !p1 #design=approved ^graphql-schema-viewer-qu-bf4255
- [ ] Translate limits: input caps, EMPTY_INPUT, SAME_LANGUAGE, per-session and per-code rate limits in the mutation (D3.4) !p2 #design=approved ^input-limits-and-same-la-a501a6
- [ ] Production config: assume_ssl/force_ssl, hosts, single-db solid_cache, security headers + CSP, SPA catch-all route, Puma threads, db:prepare entrypoint (D1.6, D5.3) !p1 ^production-config-assume-ac73a6
- [ ] Curl smoke script (cookie jar, Origin header) and README section for local API testing !p2 #design=approved ^curl-smoke-script-and-re-7b55ff

## Frontend

- [ ] Codegen and Apollo Client wiring with auth-error and non-GraphQL 429/403 handling (D1.2, D3.3, D4.3) !p1 #design=approved ^codegen-and-apollo-clien-6bf931
- [ ] Session restore on load via viewer query, and access-code gate screen (D4.2) !p1 #design=approved ^access-code-gate-screen-61cecf
- [ ] Translate page: source/target panes, language selects with swap, context field, Update Translation button (D1.4) !p1 #design=approved ^translate-page-source-ta-70fb93
- [ ] Loading state and per-code error toasts (exhaustive switch, retry affordance) for payload and top-level errors (D3.3) !p1 #design=approved ^loading-state-and-error-d9d514

## Deploy

- [ ] Multi-stage Dockerfile, captain-definition, and bin/release (buildx linux/amd64 → GHCR → caprover deploy -i) (D5.3) !p1 #design=approved ^multi-stage-dockerfile-a-55797f
- [ ] (owner-run) Runbook: EC2 t3.small + swap + Elastic IP, IAM instance role (sts:GetWebIdentityToken), IMDS hop limit 2, outbound web identity federation, CapRover install, DNS (*.cr.jagnew.io, translate.jagnew.io), TLS, Postgres app, GHCR registry creds, nginx timeout, client-IP check (D5.1, D5.3, D4.3) !p1 #design=approved ^runbook-ec2-caprover-ins-dccdb9
- [ ] (owner-run) Anthropic prod + dev workspaces with spend limits, WIF connection in Console, production env vars, first release, claude:auth_check, access code (D5.2, D5.3) !p1 #design=approved ^anthropic-workspace-with-73a5ed

## Post-MVP

- [ ] Design pass: clarifying questions with highlighted ambiguous spans (D6.1) !p3 ^design-pass-clarifying-q-420aa1
- [ ] Design pass: per-segment source-language tracking and incremental translation (D6.2) !p3 ^design-pass-per-segment-66108e
- [ ] Design pass: persisted documents (D6.3) !p3 ^design-pass-persisted-do-5535b5
- [ ] Design pass: multiplayer editing, OT vs CRDT, editor choice (D6.4) !p3 ^design-pass-multiplayer-47d79d
- [ ] Design pass: comments sharing anchors with Claude questions (D6.5) !p3 ^design-pass-comments-sha-6a22b8
- [ ] Design pass: per-translation usage tracking and app-enforced daily spend cap (D6.8) !p3 ^design-pass-per-translat-76e50e
- [ ] Build and push the image from CI instead of the owner's machine (D6.8) !p3 ^build-and-push-the-image-f7cedd
- [ ] Design pass: explicit formality and region selectors (D6.6) !p3 ^design-pass-explicit-for-829f19
- [ ] Design pass: prompt-injection hardening for shared documents (D6.7) !p3 ^design-pass-prompt-injec-3448a1
- [ ] Design pass: CloudFront front door with a security group locked to its prefix list, WAF, trusted-proxy client IPs (D6.9, D4.3, D5.1) !p3
