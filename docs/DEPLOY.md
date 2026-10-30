# Deploy FilsPay on one server (Dilmune Cloud) / تشغيل FilsPay على سيرفر واحد

Tested on the `AK` server: Ubuntu 24.04, 1 vCPU, 2 GB RAM, 50 GB disk,
Docker 29 + Compose v5. The whole stack runs on this one machine.
جرّبناه على السيرفر AK. كل الخدمات على نفس الجهاز.

## From zero / من الصفر

```bash
# 1. Firewall: SSH + API + merchant dashboard/checkout + admin console
sudo ufw allow 22/tcp && sudo ufw allow 3000/tcp && sudo ufw allow 5173/tcp && sudo ufw allow 5174/tcp
sudo ufw --force enable

# 2. Code
git clone https://github.com/badriyaadnan/fils-pay.git && cd fils-pay

# 3. Where the admin console's "view as merchant" link should point
echo "PUBLIC_WEB_URL=http://<server-ip>:5173" > ops/.env

# 4. Build and start (migrations run automatically, then the services start)
docker compose -f ops/docker-compose.yml up --build -d

# 5. Demo data: first install only (it wipes and regenerates demo tables)
docker compose -f ops/docker-compose.yml run --rm seed

# 6. Check
docker compose -f ops/docker-compose.yml ps        # api must be (healthy)
curl http://localhost:3000/healthz
```

| URL | What |
|---|---|
| `http://<ip>:5173/dashboard/login` | merchant dashboard (+ hosted checkout pages) |
| `http://<ip>:5174` | admin console |
| `http://<ip>:3000` | API |

Demo logins (seed only): merchants `owner@alpharetail.example` /
`FilsPaySeed!2026`; admin `superadmin@filspay.test` / `FilsPayAdminSeed!2026`.
OTP codes are written to the API log in this demo:
`docker compose -f ops/docker-compose.yml logs api --tail 30 | grep otp`

## Update / التحديث

```bash
cd ~/fils-pay && git pull
docker compose -f ops/docker-compose.yml up --build -d
```
Data is kept: new migrations apply on top, and `seed` does not run (profile).
البيانات تظل: الـ migrations الجديدة تنضاف فوق، و`seed` ما يشتغل.

## What keeps it up / شنو يخليه صامد

- `restart: unless-stopped` on every long-running service (crash or reboot → restarts).
- API capped at 0.5 vCPU / 512 MB, Node heap 384 MB (never OOM-killed).
- Load shedding: more than `API_MAX_IN_FLIGHT` (24) requests at once → fast `503` + `Retry-After`.
- Postgres bound to `127.0.0.1` only; data in the `filspay_pgdata` volume
  (never run `down -v` on a live server: `-v` deletes it).
- Capacity measured with `ops/loadtest/` (see `RESULTS.md`).

## Known limits / حدود معروفة

- The dashboard and admin console are served by Vite dev servers over plain
  HTTP. A production deploy would build them to static files behind HTTPS
  (e.g. Caddy), with secrets kept out of git.
- `ops/.env.docker` contains demo secrets (the acquirer signing secret was
  committed in history and must be treated as leaked).