# Aretia data server: a small server instead of Supabase

This folder is the kit for running Aretia's database and Market Indexer on **one small rented Linux server** instead of Supabase.
Nothing here changes the live site. The site keeps using Supabase until you choose to switch it (Part 8), and you can switch back (Part 9).

**Status, said plainly.** The kit was written and checked on a Windows computer with no Docker and no server. What *has* been tested: the
allow-list in the web-entry file matches the database tables, the key generator signs a key the right way, the compose file exposes only
the intended ports, and the backup script's "keep 14 daily + 8 weekly" logic (with stand-ins for the real tools). What has **not** been
run anywhere: `docker compose up`, the Postgres image applying the 20 real migrations, PostgREST, Caddy's rate limiting and certificates,
`pg_dump`/restore, `rclone` to your drive, and the copy from Supabase. Expect to fix small things on the first real run; Part 5 says how to
check each piece, and every step is safe to repeat.

## What is in the box

| Piece | What it does |
|---|---|
| `postgres` | Postgres 16. Port 5432 is open to this machine only (`127.0.0.1`), never to the internet. |
| `migrate` | Runs once at start: applies `website/supabase/migrations/*.sql` in order with the repo's own checked runner. |
| `postgrest` | Turns the database into the same web interface (REST) the site already uses with Supabase. |
| `caddy` | The **only** thing reachable from the internet (ports 80 and 443). Gets the https certificate by itself, limits requests per address (default 1,200 a minute) and body size (2 MB), and lets through only the table and function names the site uses. Everything else answers 404. |
| `scheduler` | A tiny program that calls the site's scheduled jobs on time (alerts every minute, Launch Box every 5 minutes). |
| `worker` | The long-running indexer (added in a later step; see `website/docs/self-hosted-data-server.md`). |

**Why a scheduler program and not pg_cron.** On Supabase, a database add-on (`pg_cron` with `pg_net`) calls the site's job URLs. The standard
Postgres image does not include them, and adding them means a custom database image that you would have to rebuild at every Postgres
update. The migrations already work without pg_cron (`0014` skips it if missing and the alerts job does the pruning). So the
scheduler container does the same job with 60 lines of code and no database extensions.

**How the site switches.** The site already talks to `SUPABASE_URL` + `/rest/v1/...` with `SUPABASE_SERVICE_ROLE_KEY`. Caddy serves
the same `/rest/v1/...` paths and `make-keys.mjs` makes a key in the same format (starts with `eyJ`). So switching is changing those
two Vercel variables, no code change. Pictures (the Launch Box bucket) are the exception: they stay on Supabase Storage for now.

## Part 1. What to buy

- **Provider:** Hetzner Cloud (hetzner.com/cloud) is the suggestion: cheap, fast, simple. Any provider with Ubuntu works. **Check the current price yourself before paying; prices and plan names change and I could not look them up.**
- **Size:** 4 vCPU, 8 GB RAM, 160 GB NVMe disk (budget about 15 US dollars a month; a plan of this size is typically below that, but verify).
- **System:** Ubuntu 24.04 LTS.
- **Region:** US East (Ashburn, Virginia), close to Vercel's default region `iad1`, so the site's requests to the database are fast. If your Vercel functions run elsewhere, pick the nearest.
- **Options to tick:** IPv4 address (needed), backups off (you make your own, Part 6), your **ssh public key** (Part 2).
- **A name:** in your domain's DNS add an **A record**, e.g. `data.aretiafinance.org` → the server's IP address. (If the domain is on Cloudflare, set the record to **DNS only**, the grey cloud, so Caddy can get its certificate.)

## Part 2. Make an ssh key (on your own computer, once)

Windows PowerShell: `ssh-keygen -t ed25519 -C "aretia-server"` (press Enter at the questions; set a passphrase). Then show the
public half and paste it into the provider's "ssh key" box: `type $env:USERPROFILE\.ssh\id_ed25519.pub`. Never share the file without `.pub`.

## Part 3. First login and the safe setup

1. Connect: `ssh root@SERVER_IP` (root only for this first minute).
2. Make a normal user and give it your key:
   ```bash
   adduser --disabled-password --gecos "" aretia
   usermod -aG sudo aretia
   mkdir -p /home/aretia/.ssh && cp /root/.ssh/authorized_keys /home/aretia/.ssh/ && chown -R aretia:aretia /home/aretia/.ssh && chmod 700 /home/aretia/.ssh && chmod 600 /home/aretia/.ssh/authorized_keys
   echo "aretia ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/aretia
   ```
3. **In a second window** check you can log in: `ssh aretia@SERVER_IP`. Do not continue until that works.
4. Install Docker and get the code (as `aretia`):
   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker aretia && exit        # log in again after this
   sudo mkdir -p /opt/aretia && sudo chown aretia:aretia /opt/aretia
   git clone https://github.com/abiolabolarinwa/Aretia-Finance.git /opt/aretia
   ```
5. Harden the machine (firewall allowing only ssh, 80 and 443; no ssh passwords; no root login; fail2ban; automatic security updates):
   ```bash
   sudo /opt/aretia/server/bin/harden.sh aretia
   ```

### Hardening checklist (what harden.sh does, and what only you can do)

- [x] `ufw` firewall: deny all incoming except 22, 80, 443 (script).
- [x] ssh keys only, no passwords, no root login (script; it refuses to run if your key is missing, so you cannot lock yourself out).
- [x] `fail2ban` bans addresses that guess ssh logins (script).
- [x] Automatic security updates (`unattended-upgrades`, script).
- [x] Non-root user `aretia` runs everything (Part 3).
- [x] Secrets only in `server/.env`, mode 600, in `.gitignore`; the scripts refuse to start if the mode is looser (Part 4).
- [x] Postgres reachable from this machine only; the database password is random and never leaves the server.
- [ ] **Docker bypasses ufw for ports it publishes.** The compose file publishes only 80/443, so this is safe as shipped. Do not add other `ports:` lines. After first start, from your own computer, check that `5432` is closed: `Test-NetConnection SERVER_IP -Port 5432` must say `False`.
- [ ] Turn on two-step login (2FA) on the provider account and on the domain/DNS account.
- [ ] Reboot once a month after updates (`sudo reboot`); `docker` containers restart by themselves.
- [ ] Keep the age **private** key off the server (Part 6).

## Part 4. Create the secrets and start

```bash
cd /opt/aretia/server
node bin/make-keys.mjs          # needs Node 18+; if missing: sudo apt-get install -y nodejs   (or run it on your own computer and copy the .env over, then chmod 600)
nano .env                       # fill in DATA_HOSTNAME, ACME_EMAIL, CRON_SECRET, MI_CRON_SECRET (the same values the site has on Vercel) and the backup lines
docker compose up -d --build
docker compose ps               # postgres, postgrest, caddy, scheduler running; migrate "exited (0)" is correct
```

`make-keys.mjs` writes `.env` with random database passwords, a random signing secret and a signed `SERVICE_ROLE_KEY`. It prints nothing
secret. To see the key you will paste into Vercel later: `node bin/make-keys.mjs --print-key` (do this on the server only, never in chat).

## Part 5. Check each piece

```bash
curl -s https://DATA_HOSTNAME/healthz                              # ok
curl -s -o /dev/null -w "%{http_code}\n" https://DATA_HOSTNAME/rest/v1/mi_pools      # 401 (no key: refused)
curl -s -o /dev/null -w "%{http_code}\n" https://DATA_HOSTNAME/rest/v1/                # 404
KEY=$(node bin/make-keys.mjs --print-key)
curl -s "https://DATA_HOSTNAME/rest/v1/mi_pools?select=key&limit=1" -H "apikey: $KEY" -H "authorization: Bearer $KEY"     # [] on an empty database
docker compose logs --tail 30 migrate                               # 20 migrations applied
docker compose exec postgres psql -U postgres -d aretia -c '\dt public.*' | head -40
```

If a table name in a migration is added later, the Caddy list in `caddy/Caddyfile` must get the name too: a test in the repository fails until it does.

## Part 6. Backups (do this before moving any data)

Backups are encrypted on the server with a **public** key; only you hold the private one, so a stolen backup is unreadable.

1. On your own computer install `age` (age-encryption.org) and run `age-keygen -o aretia-backup-key.txt`. It prints `Public key: age1...`. Put that line in `.env` as `AGE_RECIPIENT`. **Store `aretia-backup-key.txt` in a password manager and on a USB stick. If you lose it, the backups are useless.**
2. On the server run `rclone config` once: new remote, name `onedrive` (or `gdrive`), type Microsoft OneDrive or Google Drive, follow the prompts (it prints a link to open on your own computer for the sign-in). Set `RCLONE_REMOTE=onedrive:aretia-backups` in `.env`.
3. Try it: `./bin/backup.sh`. You should see `backup ok` and a file in `daily/` in your drive.
4. Switch on the nightly timer (02:30 UTC; also the disk check every 15 minutes):
   ```bash
   sudo cp /opt/aretia/server/systemd/aretia-*.service /opt/aretia/server/systemd/aretia-*.timer /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now aretia-backup.timer aretia-disk.timer
   systemctl list-timers | grep aretia
   ```
   It keeps the newest **14 daily** files and the newest **8 weekly** (Sunday) files in the drive, and 3 on the server.
5. **Test a restore now, not on the day you need it.** Copy the private key to the server for a minute, restore into a scratch database, then delete the key:
   ```bash
   scp aretia-backup-key.txt aretia@SERVER_IP:/tmp/key.txt
   ./bin/restore.sh daily/aretia-YYYYMMDDTHHMMSSZ.dump.age --identity /tmp/key.txt     # prints row counts, drops the scratch database
   shred -u /tmp/key.txt
   ```
   Replacing the real database from a backup (disaster only): add `--into-production` and type `RESTORE` when asked.

## Part 7. Monitoring (free)

- **Uptime:** make a free account at UptimeRobot or BetterStack, add an HTTPS monitor for `https://DATA_HOSTNAME/healthz` every 5 minutes, alert to your email/phone.
- **Dead-man's switches** (healthchecks.io, free): create three checks and paste their URLs into `.env`: `BACKUP_PING_URL` (expects a ping daily), `DISK_PING_URL` (every 15 minutes) and `SCHEDULER_PING_URL` (every minute). They alert when the job fails (`/fail`) **or goes silent**, which also catches a dead server.
- **Disk:** `check-disk.sh` alerts at `DISK_ALERT_PERCENT` (80%). Look yourself with `df -h /` and `docker system df`.
- **Logs:** each container keeps at most 30 MB of logs. `docker compose logs --tail 50 caddy`.

## Part 8. Copy the data and switch (when you are ready)

The order, the freeze and the checks are in `website/docs/self-hosted-data-server.md`. The copy itself:

```bash
export SRC_DB_URL='postgresql://...'          # Supabase: Project settings > Database > Connection string > "Session pooler". Do not paste it anywhere else.
SKIP_TABLES="mi_trades mi_block_hashes" ./bin/copy-from-supabase.sh
unset SRC_DB_URL
```

It copies table by table, can be run again after any interruption (finished tables are skipped; `--restart` starts over), resets the
id counters, and prints source and destination row counts. The connection string is passed to the container through the environment,
not written to disk or printed. It uses Supabase **egress**; skipping the big rebuildable indexer tables keeps that small. Supabase's
direct connection address is IPv6-only: use the "Session pooler" string.

## Part 9. Roll back to Supabase

Nothing is deleted from Supabase by this kit. To go back: in Vercel set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` back to the
Supabase values and redeploy (the old values are in Vercel's history of the variable, and you wrote them down before the switch, Part 8 of the doc).
Rows written to the new server since the switch are not in Supabase; if that matters, copy them back before you stop the new server
(the copy script works in the other direction by swapping the two connection strings, ask for help the first time). The Supabase project
must still exist and be paid up (or within its limits) for rollback to work.

## Everyday commands

| Do | Command (in `/opt/aretia/server`) |
|---|---|
| Update to the latest kit and apply new migrations | `./bin/update.sh` |
| See what runs | `docker compose ps` |
| Logs of one part | `docker compose logs --tail 100 postgrest` |
| Stop / start everything | `docker compose stop` / `docker compose up -d` |
| Run a backup now | `./bin/backup.sh` |
| Open a database prompt | `docker compose exec postgres psql -U postgres -d aretia` |

**Do not** run `docker compose down -v` (the `-v` deletes the database volume).
