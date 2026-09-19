# Production runbook

How to stand up `translate.jagnew.io` (design D5). **Every step here is run by the owner**; nothing in
the repo touches real infrastructure. Items marked **(verify)** come from research the agent could not
check against live docs — confirm them as you go and fix this file if they differ.

Order: 1–7 build the host and CapRover; 8–11 connect Claude, configure the app and ship.

## 1. EC2 instance

- **AMI:** Ubuntu Server 24.04 LTS, **x86_64** (the image is built for `linux/amd64`).
- **Type:** `t3.small` (2 GB). Gems and the SPA are built on your laptop, so the box only runs
  Rails, Postgres and CapRover.
- **Storage:** 30 GB gp3.
- **Key pair:** your SSH key.
- **Advanced details → Metadata:** IMDSv2 **required**, **hop limit 2**. Containers are one network hop
  behind the host; with the default hop limit of 1 they can't reach the instance role's
  credentials, and Workload Identity Federation (section 9) fails. To change it on an existing
  instance:

  ```sh
  aws ec2 modify-instance-metadata-options --instance-id i-XXXX \
    --http-tokens required --http-put-response-hop-limit 2 --http-endpoint enabled
  ```

- **Elastic IP:** allocate one and associate it, so DNS survives stop/start.

## 2. Security group

| Port | Source | Why |
|---|---|---|
| 22/tcp | your IP only | SSH |
| 80/tcp | 0.0.0.0/0 | HTTP (Let's Encrypt challenges, redirect to HTTPS) |
| 443/tcp | 0.0.0.0/0 | HTTPS |
| 3000/tcp | your IP only | CapRover dashboard during setup — **remove after step 5** |

CapRover's cluster ports (996, 7946, 4789, 2377) aren't needed for a single node. **(verify)**

## 3. IAM role for the instance

Create a role for EC2, e.g. `contextual-translate-ec2`, with one inline policy — the only thing the
app asks AWS for is a short-lived identity token (design D5.2):

```json
{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Action": "sts:GetWebIdentityToken", "Resource": "*" }]
}
```

Attach it to the instance (Actions → Security → Modify IAM role). Whether the audience can be pinned
with a condition key is still open **(verify)**; the Anthropic side only accepts tokens for
`https://api.anthropic.com` from this role anyway.

## 4. Host setup (SSH in)

```sh
# 2 GB swap: a safety margin for Rails + Postgres + CapRover on 2 GB of RAM
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Docker
curl -fsSL https://get.docker.com | sudo sh

# CapRover
sudo docker run -d -p 80:80 -p 443:443 -p 3000:3000 -e ACCEPTED_TERMS=true \
  -v /var/run/docker.sock:/var/run/docker.sock -v /captain:/captain caprover/caprover
```

## 5. DNS and CapRover setup

At the DNS host for `jagnew.io`, add two A records pointing at the Elastic IP:

| Name | Type | Value |
|---|---|---|
| `*.cr.jagnew.io` | A | Elastic IP (CapRover's root domain; the dashboard becomes `captain.cr.jagnew.io`) |
| `translate.jagnew.io` | A | Elastic IP (the app's public name) |

Then from your laptop:

```sh
pnpm add -g caprover
caprover serversetup      # IP = Elastic IP, root domain = cr.jagnew.io, a NEW strong password, your email
```

The default password `captain42` must not survive this step. Afterwards the dashboard is at
`https://captain.cr.jagnew.io` — remove the port-3000 rule from the security group.

The monorepo's own nginx/certbot stack needs ports 80/443 too, so it can't share this host
(design D5.1).

## 6. Postgres

Dashboard → **Apps → One-Click Apps/Databases → PostgreSQL**:

- App name: `ct-postgres`; version 16; database `contextual_translate`; user `contextual_translate`;
  a generated password.
- It's reachable from other apps at `srv-captain--ct-postgres:5432`, so the app's
  `DATABASE_URL` is `postgres://contextual_translate:<password>@srv-captain--ct-postgres:5432/contextual_translate`.
- Solid Cache (rate-limit and throttle counters) uses the same database (design D5.3).

## 7. The app shell, registry access and HTTPS

1. **Create the app:** Apps → create `contextual-translate` (no persistent data).
2. **App Configs → Container HTTP Port: `3000`.** CapRover assumes 80 otherwise.
3. **Registry:** Cluster → Docker Registry Configuration → Add Remote Registry: domain `ghcr.io`,
   username = your GitHub user, password = a classic PAT with only `read:packages`, image prefix =
   your GitHub user. **(verify the prefix field)**
4. **Environment variables** — see section 10.
5. **Domain and TLS:** HTTP Settings → Connect New Domain `translate.jagnew.io` → Enable HTTPS →
   Force HTTPS. Let's Encrypt issues the certificate once DNS resolves.
6. **Request timeout:** nginx's default `proxy_read_timeout` is 60 s, which already covers a Claude
   call (30 s timeout plus one quick retry, design D2.2). Only if you see 504s, add
   `proxy_read_timeout 90s;` in the app's "Edit Default Nginx Configurations". **(verify)**

### After the first release: check client IPs

rack-attack throttles sign-in per client IP, so the app must see real addresses, not CapRover's
internal ones (design D4.3). Try one wrong code from your laptop, then:

```sh
docker service logs srv-captain--contextual-translate 2>&1 | grep 'Failed access-code sign-in from' | tail -3
```

The IP printed must be **your public IP**. If it's a `10.x` / `172.x` address, requests are reaching
nginx through Docker Swarm's routing mesh, which rewrites the source address. Every visitor then
shares one throttle bucket, so one bad code can ban the whole panel. Fix this before sharing the demo.

- **Don't** try to fix it in Rails (`trusted_proxies` or similar). X-Forwarded-For already holds only
  the mesh address by the time nginx sees the request, so no app setting can recover the client IP.
- **Do** publish CapRover's nginx ports in **host mode**, so nginx sees the client's address directly.
  **(verify)** the exact procedure for your CapRover version; it is an nginx-service change, not an
  app change. Then repeat the check above.

## 8. Anthropic workspaces and spend limits

In the Anthropic Console (your personal org, design D5.2):

- **`contextual-translate-prod`** — used by production via Workload Identity Federation. Set a
  **monthly** spend limit (limits are monthly only) to what you'd accept losing, e.g. $100–200 for
  the demo. Spend data can lag, so treat the limit as a backstop, not an exact cutoff.
- **`contextual-translate-dev`** — create an API key here for local development and the eval set,
  with its own small monthly limit. This key never goes to production.

When a limit is hit, users see "This demo has reached its usage budget. Please let the owner know."
(`BUDGET_EXCEEDED`, design D3.3).

## 9. Workload Identity Federation (no Anthropic secret in production)

1. **AWS, once per account:**

   ```sh
   aws iam enable-outbound-web-identity-federation
   aws iam get-outbound-web-identity-federation-info   # note the issuer: https://<uuid>.tokens.sts.global.api.aws
   ```

2. **Anthropic Console → Settings → Workload identity → Connect workload → AWS:**
   issuer from step 1; subject prefix = the instance role's ARN
   (`arn:aws:iam::<account>:role/contextual-translate-ec2`); audience `https://api.anthropic.com`;
   scope it to the `contextual-translate-prod` workspace. Note the **federation rule ID**,
   **organization ID**, **service account ID** and **workspace ID**. None of these are secrets.
3. The instance's IMDS hop limit must be 2 (section 1) and its role must allow
   `sts:GetWebIdentityToken` (section 3).

## 10. Environment variables (CapRover → App Configs)

Generate the two secrets on your laptop and keep copies in your password manager — losing
`ACCESS_CODE_PEPPER` means issuing new access codes; rotating `SECRET_KEY_BASE` signs everyone out.

```sh
openssl rand -hex 64   # SECRET_KEY_BASE
openssl rand -hex 32   # ACCESS_CODE_PEPPER
```

| Variable | Value |
|---|---|
| `SECRET_KEY_BASE` | generated above |
| `ACCESS_CODE_PEPPER` | generated above |
| `DATABASE_URL` | `postgres://contextual_translate:<password>@srv-captain--ct-postgres:5432/contextual_translate` |
| `APP_HOST` | `translate.jagnew.io` |
| `TRANSLATOR` | `claude` |
| `CLAUDE_AUTH` | `wif` |
| `AWS_REGION` | the instance's region, e.g. `us-east-1` (the STS call must be regional) |
| `ANTHROPIC_FEDERATION_RULE_ID` | from section 9 |
| `ANTHROPIC_ORGANIZATION_ID` | from section 9 |
| `ANTHROPIC_SERVICE_ACCOUNT_ID` | from section 9 |
| `ANTHROPIC_WORKSPACE_ID` | from section 9 |

Optional: `CLAUDE_MODEL` (default `claude-opus-5`), `CLAUDE_EFFORT` (default `medium`),
`RAILS_MAX_THREADS` (default 8), `RAILS_LOG_LEVEL` (default `info`).

**Do not set `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_PROFILE`** — any of them would
silently override WIF, so the app refuses to boot when one is present with `CLAUDE_AUTH=wif`.

## 11. First release and checks

1. **Release** from a clean checkout of the commit to ship (see the README's "Releasing"):

   ```sh
   docker login ghcr.io          # a token that can write packages
   IMAGE_REPO=ghcr.io/<owner>/contextual-translate bin/release
   ```

   The container's entrypoint runs `db:prepare` (creates the schema) before Puma starts.

2. **Instance credentials reach the container** (SSH to the host):

   ```sh
   C=$(docker ps -qf name=srv-captain--contextual-translate)
   docker exec "$C" curl -s -X PUT http://169.254.169.254/latest/api/token \
     -H "X-aws-ec2-metadata-token-ttl-seconds: 60" | head -c 20; echo
   ```

   A token prints on success. An empty response or a timeout means the hop limit is still 1.

3. **Claude auth end to end:**

   ```sh
   docker exec "$C" bin/rails claude:auth_check
   ```

   It fetches an STS token, exchanges it, and translates "Is this a bat?" at a baseball game.
   Each failed step names itself.

4. **Create the access code** (shown once — copy it):

   ```sh
   docker exec "$C" bin/rails access_codes:create LABEL="Side project" EXPIRES_IN=30d
   docker exec "$C" bin/rails access_codes:list
   docker exec "$C" bin/rails access_codes:revoke ID=<id>     # if it ever leaks
   ```

5. **From your laptop:** `bin/smoke <access-code> https://translate.jagnew.io`, then do the
   client-IP check at the end of section 7, then open the site and translate something with context.

6. **Quality and latency baseline** (local, with the dev workspace's key; costs a little):

   ```sh
   cd backend
   TRANSLATOR=claude CLAUDE_AUTH=api_key ANTHROPIC_API_KEY=<dev key> bin/rails eval:translations EFFORTS=low,medium
   ```

   Record the p50/p95 per effort in design D2.2 (target: p95 under 10 s) and pick the default
   `CLAUDE_EFFORT`.
