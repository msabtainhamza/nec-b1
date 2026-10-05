# Dev server on EC2 and Windows installer

This sets up a shared **development** server. It is not a production setup: PostgreSQL, Redis, SeaweedFS and Mailpit run in Docker on one instance, and the installer is unsigned. See ADR-054.

## 0. Before you start

- Commit and push the code you want on the server. The server gets code only through `git clone`/`git pull`; uncommitted work on your PC does not reach it.
- Decide the server hostname. The packaged desktop app accepts only an HTTPS API URL, so you need a DNS name for a certificate:
  - your own domain: create an `A` record such as `erp-dev.yourdomain.com` pointing to the Elastic IP (step 1), or
  - without a domain: use the Elastic IP through a wildcard DNS service. For Elastic IP `3.110.25.40` the hostname is `3-110-25-40.sslip.io`, which resolves to that IP with no DNS setup or purchase, and Caddy can get a Let's Encrypt certificate for it. Use that hostname wherever this guide says `<your-hostname>`. This depends on the third-party sslip.io service and shared Let's Encrypt rate limits, so it may occasionally fail; verify it works for you.

## 1. Create the instance (AWS console)

1. EC2 > Launch instance: Ubuntu Server 24.04 LTS, x86_64, `t3.medium` (4 GB RAM) or larger, 30 GB gp3 disk, a key pair you keep.
2. Security group inbound rules:
   - SSH 22 from **My IP** only
   - HTTP 80 from anywhere (needed for the Let's Encrypt challenge)
   - HTTPS 443 from anywhere
   - Do not open 4000, 55432, 56379, 59000 or 58025.
3. EC2 > Elastic IPs: allocate one and associate it with the instance so the address survives restarts.
4. Point your DNS name at the Elastic IP.

## 2. Install Docker, Node.js 24, pnpm, Git and Caddy

```bash
ssh -i your-key.pem ubuntu@<elastic-ip>
sudo apt update && sudo apt -y upgrade
sudo apt -y install git ca-certificates curl docker.io docker-compose-v2
sudo usermod -aG docker ubuntu
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt -y install nodejs
sudo npm install -g pnpm@10.33.0
sudo apt -y install debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt -y install caddy
exit
```

Log in again so the `docker` group applies. Check: `docker ps`, `node -v` (24.x), `pnpm -v`.

Package names and repository URLs change over time; if a command fails, check the current Docker, NodeSource and Caddy install pages.

## 3. Clone the repository

The repository is private, so the server needs read access. A deploy key is the narrowest option:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/nec_deploy -N ""
cat ~/.ssh/nec_deploy.pub
```

Add that public key in GitHub: repository > Settings > Deploy keys > Add (read-only). Then:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/nec_deploy
EOF
cd ~
git clone git@github.com:msabtainhamza/nec-b1.git
cd nec-b1
git checkout master
```

Use the branch that holds your pushed work.

## 4. Configure `.env`

```bash
cp .env.example .env
nano .env
```

Replace every password and secret, because this machine is on the internet:

| Variable | Value |
| --- | --- |
| `POSTGRES_SUPERUSER_PASSWORD`, `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD`, `DB_WORKER_PASSWORD` | `openssl rand -hex 24` each |
| `S3_SECRET_KEY` | `openssl rand -hex 24` |
| `JWT_ACCESS_SECRET` | `openssl rand -hex 32` |
| `MFA_ENCRYPTION_KEY` | `openssl rand -base64 32` (uncomment the line) |
| `SEED_OPERATOR_PASSWORD`, `SEED_USER_PASSWORD` | new strong values |
| `SEED_OPERATOR_TOTP_SECRET` | new base32 secret, or keep it only if nobody else can read `.env` |
| `API_BASE_URL` | `https://<your-hostname>` |

Keep `API_HOST=127.0.0.1`; Caddy is the only public entry point. Database passwords are applied when the PostgreSQL volume is first created, so set them before step 5.

## 5. Start services, install, build and seed (first time only)

```bash
pnpm infra:up
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install
pnpm --filter @nec/contracts build
pnpm --filter @nec/api build
pnpm --filter @nec/worker build
pnpm db:migrate
pnpm db:seed
```

Do not run `pnpm run setup` or `pnpm db:reset` on a server that has data you want to keep: both reset the database.

## 6. Run the API and worker as services

```bash
sudo cp infrastructure/dev-server/nec-api.service infrastructure/dev-server/nec-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nec-api nec-worker
systemctl status nec-api --no-pager
curl -s http://127.0.0.1:4000/health
```

The unit files assume user `ubuntu`, the clone at `/home/ubuntu/nec-b1` and Node at `/usr/bin/node`; edit them if yours differ. Logs: `journalctl -u nec-api -f`.

## 7. HTTPS with Caddy

```bash
sudo cp infrastructure/dev-server/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/erp-dev.example.com/<your-hostname>/' /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -s https://<your-hostname>/health
```

Caddy obtains and renews the certificate automatically. If it fails, check `journalctl -u caddy` and that ports 80 and 443 are open and DNS points to the Elastic IP.

## 8. Build the Windows installer (on your Windows PC)

```bash
pnpm install
NEC_API_URL=https://<your-hostname> pnpm --filter @nec/desktop run package
```

In PowerShell: `$env:NEC_API_URL="https://<your-hostname>"; pnpm --filter @nec/desktop run package`.

The installer is written to `apps/desktop/release/installer/NEC-ERP-Setup-<version>.exe`. If the build fails with `EBUSY` on `default_app.asar`, a file scanner or IDE indexer is locking the folder; build to another folder with `NEC_INSTALLER_OUT=C:\nec-installer`.

Share the `.exe` (for example through a private S3 link or a shared drive). The installer is unsigned, so Windows SmartScreen shows "Windows protected your PC"; testers choose **More info > Run anyway**. Rebuild and redistribute after desktop changes, and bump `version` in `apps/desktop/package.json` so installs upgrade cleanly. There is no auto-update yet.

## 9. Updating the server

```bash
cd ~/nec-b1
git pull
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install
pnpm --filter @nec/contracts build && pnpm --filter @nec/api build && pnpm --filter @nec/worker build
pnpm db:migrate
sudo systemctl restart nec-api nec-worker
```

## Useful access

- Mailpit (invitation and password-reset emails): `ssh -i your-key.pem -L 58025:127.0.0.1:58025 ubuntu@<elastic-ip>`, then open `http://localhost:58025`.
- Database from your PC: `ssh -i your-key.pem -L 55432:127.0.0.1:55432 ubuntu@<elastic-ip>`, then connect to `localhost:55432`.
- Backup: `docker compose -f infrastructure/docker-compose.yml --env-file .env exec postgres pg_dump -U postgres nec_erp > backup.sql`, or EBS snapshots of the volume.
