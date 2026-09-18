# Production runbook

How to stand up `translate.jagnew.io` (design D5). **Every step here is run by the owner**; nothing in
the repo touches real infrastructure. Items marked **(verify)** come from research the agent could not
check against live docs — confirm them as you go and fix this file if they differ.

Order: 1–7 build the host and CapRover; 8–11 (added by the next task) connect Claude and ship.

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
4. **Environment variables** — see section 10 (next task) for the full list.
5. **Domain and TLS:** HTTP Settings → Connect New Domain `translate.jagnew.io` → Enable HTTPS →
   Force HTTPS. Let's Encrypt issues the certificate once DNS resolves.
6. **Request timeout:** nginx's default `proxy_read_timeout` is 60 s, which already covers a Claude
   call (30 s timeout plus one quick retry, design D2.2). Only if you see 504s, add
   `proxy_read_timeout 90s;` in the app's "Edit Default Nginx Configurations". **(verify)**

### After the first release: check client IPs

rack-attack throttles sign-in per client IP, so the app must see real addresses, not CapRover's
internal ones (design D4.3). After you've made a request from your laptop:

```sh
docker service logs srv-captain--contextual-translate 2>&1 | grep 'Started POST "/api/session"' | tail -3
```

The `for <ip>` must be **your public IP**. If it's a `10.x` / `172.x` address, traffic is arriving
through Swarm's routing mesh and every visitor shares one throttle bucket — stop and fix that before
sharing the demo (options: publish nginx's ports in host mode, or add a trusted-proxy rule for
CapRover's nginx and re-test).
