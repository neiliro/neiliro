# Deploying to a VPS

Step by step: from a blank machine to a working `https://hub.example.com`.
Written for Ubuntu 24.04 on any VPS (Hetzner, DigitalOcean and the like) —
the hub is comfortable on the smallest machine: 1 vCPU and 1 GB of RAM
with room to spare.

None of this is needed for running at home — that stays
`docker compose up -d` and [home-server.md](home-server.md).

## 1. DNS

In your domain registrar's panel, create an A record:

```
hub.example.com  →  <your server's IP>
```

If your DNS lives in Cloudflare, turn proxying off for the first start
(grey cloud, "DNS only"): Caddy has to prove domain ownership directly.
You can turn it back on afterwards, though there is little point —
Caddy manages fine on its own.

## 2. The machine

Create a server with Ubuntu 24.04 and your SSH key.

### A user instead of root

The first sign-in is as root — and it should be the last thing root does
by hand. Working as root means one mistyped command with no seatbelt and
one all-powerful login for an attacker to target, so the first step is a
regular user with sudo:

```bash
adduser hub                       # pick any name; asks for a password
usermod -aG sudo hub
rsync --archive --chown=hub:hub ~/.ssh /home/hub   # your key now opens both doors
```

Log out, sign back in as the new user and check that sudo works:

```bash
ssh hub@<your server's IP>
sudo whoami                       # → root
```

From here on, everything in this guide runs as this user. Once you have
confirmed the new sign-in works, close the root door and password
sign-ins entirely:

```bash
echo 'PermitRootLogin no
PasswordAuthentication no' | sudo tee /etc/ssh/sshd_config.d/99-hardening.conf
sudo systemctl restart ssh
```

### Base setup

Security updates — automatic, because nobody will install them by hand:

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades   # answer "Yes"
```

Firewall: only SSH and the web face outward. Anything else that ever
comes up on the machine is invisible from the internet by default:

```bash
sudo apt-get install -y ufw
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
```

Docker — with the official script, then let the user run it without sudo:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker hub       # takes effect on the next sign-in
```

If you took a 1 GB machine, add swap right away — you will want it for
any manual builds:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 3. Code and data

```bash
sudo mkdir -p /srv/family-hub
sudo chown hub:hub /srv/family-hub
```

Deliver the code to `/srv/family-hub/app` any way you like —
`scp`/`rsync` of an archive, or `git clone` if the project is in a
repository:

```bash
# from your machine, from the folder above the project:
rsync -a --exclude node_modules --exclude .git --exclude certs --exclude .env \
  neiliro/ hub@<IP>:/srv/family-hub/app/
```

The data directory. The container does not run as root either — inside
it the app is uid 1000, so that uid owns the data:

```bash
mkdir -p /srv/family-hub/data
sudo chown -R 1000:1000 /srv/family-hub/data
```

`.env` next to the compose file:

```bash
cd /srv/family-hub/app
cat > .env << 'ENV'
HUB_DOMAIN=hub.example.com
TZ=Europe/Madrid
DATA_DIR=/srv/family-hub/data
LOG_LEVEL=info
# Public age key for backup encryption — see the Backups section
AGE_RECIPIENT=
ENV
```

`TZ` is the hub's default wall clock. It stays the simplest way to set the
time zone for a single household, and it is what the hub falls back to — but
the family can also name its own zone in Settings → Time zone, which then
wins and travels with the database through backups and moves.

`SECURE_COOKIES` and `TRUST_PROXY` need no setting — the production
compose enables them unconditionally, because behind Caddy there is no
other valid configuration.

## 4. Launch

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

The first build takes a couple of minutes (better-sqlite3 compiles
natively). Then simply open `https://hub.example.com` — a hub with an
empty database offers to create the first account, which becomes the
administrator. Add family members from the People section with
single-use invitation links. Passwords are never written to server logs.
Caddy obtains the certificate by itself — if the browser complains, wait
a minute and check `logs caddy`: it is almost always a DNS record that
has not propagated yet.

![The first-run screen: name, login and password for the administrator](screenshots/first-run.png)

This screen appears exactly once. After it, the same address shows the
ordinary sign-in form.

## 5. Moving data from a home machine

If the hub already lived at home and has data — just move the directory:

```bash
# on the VPS: stop the app
docker compose -f docker-compose.prod.yml stop app

# from the home machine: transfer the data (database, attachments)
rsync -a ~/.family-hub/ hub@<IP>:/tmp/hub-data/

# on the VPS: move it into place, restore ownership and start
sudo rsync -a /tmp/hub-data/ /srv/family-hub/data/ && rm -rf /tmp/hub-data
sudo chown -R 1000:1000 /srv/family-hub/data
docker compose -f docker-compose.prod.yml start app
```

Accounts, sessions, notes, finances — everything moves as-is.
The alternative without SSH acrobatics is export/import from the app's
settings.

## 6. Backups

On rented hardware a backup is not optional: a VPS disk dies together
with the machine. The `scripts/backup.sh` script already does everything
needed: a consistent database snapshot, notes exported to markdown,
age encryption and, optionally, a push to a private git repository.

The encryption key — once, on your own machine (not on the server):

```bash
age-keygen -o hub-backup.key        # keep the secret part somewhere safe
grep public hub-backup.key          # age1... — this is your AGE_RECIPIENT
```

Put the public part into `.env` (`AGE_RECIPIENT=age1...`) and restart the
app. Never put the secret part on the server: the server must be able to
encrypt a backup but not decrypt one.

Cron on the host, at night:

```bash
crontab -e
# add the line:
0 3 * * * cd /srv/family-hub/app && docker compose -f docker-compose.prod.yml exec -T app bash scripts/backup.sh >> /tmp/family-hub-backup.log 2>&1
```

Encrypted archives accumulate in `/srv/family-hub/data/backups`.
What remains is getting them off the machine — anything works: `rclone`
to any cloud, `rsync` to a home machine on a schedule, or a git
repository (the script pushes by itself if a clone with configured
access is mounted into the container — though at family scale a daily
`rsync` of the backups to a home machine is simpler and just as good).

Every couple of months, pull a random archive and verify that it
decrypts and opens: a backup that has never been restored is a backup
only nominally.

## 7. Monitoring

Three small things cover the failure modes that actually happen: the hub
went down and nobody noticed, the backup silently stopped running, and
errors piled up in a log nobody reads. None of them require running any
monitoring software on the VPS itself.

**Uptime.** `/api/health` answers 200 only when the app is up *and* the
database responds. Point any free uptime service (UptimeRobot,
Better Stack, …) at it:

```
https://hub.example.com/api/health
https://demo.example.com/api/health   # if you run the public demo
```

**A dead-man switch for the backup.** An alert firing on a failed backup
is not enough: the worst failure is the cron job not running at all —
nothing fails, nothing alerts. A dead-man switch inverts the logic: the
backup script pings a URL after every run, and the service alarms when
the ping *stops coming*. Create a check at [healthchecks.io](https://healthchecks.io)
(free tier is plenty) with a daily schedule, put the ping URL into `.env`:

```
BACKUP_PING_URL=https://hc-ping.com/your-uuid
```

then `docker compose -f docker-compose.prod.yml up -d` so the container
picks it up. On success the script pings the URL, on failure `<url>/fail` —
you learn about both a broken backup and a backup that quietly stopped.

**Error alerts.** The app logs real errors as `ERROR` lines, but nobody
reads container logs on a schedule. `scripts/alert-errors.sh` does: it
greps the last hour of logs and pushes anything found to an
[ntfy](https://ntfy.sh) topic — a push notification straight to your
phone, no account needed (pick a long unguessable topic name: anyone who
knows it can read the alerts). Cron on the host:

```bash
crontab -e
# add the line:
5 * * * * ALERT_URL=https://ntfy.sh/<secret-topic> /srv/family-hub/app/scripts/alert-errors.sh
```

Container logs are capped by the compose files (10 MB × 3 files per
service), so they never eat the disk. On an install that predates the
cap, `docker compose -f docker-compose.prod.yml up -d` recreates the
containers and applies it.

## 8. Google sign-in (optional)

Once, in the [Google Cloud Console](https://console.cloud.google.com/):

1. Create a project (any name, e.g. `neiliro`).
2. **OAuth consent screen** (in the new console: Google Auth Platform →
   **Audience**): type External, fill in the name and support email.
   No need to publish the app — leave it In testing and add your family
   members' Google addresses to Test users (in testing mode only they
   can sign in, which is exactly what we want).
3. **Credentials → Create credentials → OAuth client ID**:
   type Web application; under Authorized redirect URIs add exactly:

   ```
   https://hub.example.com/api/auth/google/callback
   ```

4. The resulting Client ID and Client secret go into `.env` on the
   server:

   ```
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-...
   ```

5. `docker compose -f docker-compose.prod.yml up -d` — the sign-in
   screen now shows a "Sign in with Google" button.

Then each person on their own: sign in with the password → Settings →
"Signing in" → Link → optionally disable password sign-in. The
administrator's password cannot be disabled — that is deliberate, see
[features.md](features.md), "Signing in".

## 9. Public demo (optional)

A sandbox at its own subdomain, running next to production on the same
VPS. Every visitor gets their own throwaway copy of a seeded sample
family — one click to enter, no password. Sandboxes are dropped after a
couple of idle hours and the sample data is rebuilt daily, so the demo
cleans itself; visitors can touch everything without ever seeing each
other's mess. Password and membership changes and file uploads stay
blocked.

Note: the demo needs the API, so it cannot live on static hosting like
GitHub Pages — but a second container on the VPS you already have is
just as much a one-domain job.

1. DNS: an A record `demo.example.com → <the same server IP>`.
   The demo site block already lives in `Caddyfile.prod` behind the
   `DEMO_DOMAIN` variable — nothing to edit there.

2. On the server — the demo's own data directory (uid 1000, the
   container is not root):

   ```bash
   mkdir -p /srv/family-hub/demo-data
   sudo chown -R 1000:1000 /srv/family-hub/demo-data
   ```

3. Add to `.env`: `DEMO_DOMAIN=demo.example.com`

4. Launch both stacks together (from now on, always with both files):

   ```bash
   docker compose -f docker-compose.prod.yml -f docker-compose.demo.yml up -d
   ```

No nightly reset cron is needed: sandbox cleanup and daily template
rebuilds happen inside the app itself.

### Keeping only the demo

A hub can move on — to another machine, or to a hosted service — while
the demo stays where it is. Set `HUB_ENABLED=false` in `.env`, point
`HUB_DOMAIN` at a placeholder that resolves nowhere (`hub.localhost`
takes an internal certificate and never bothers Let's Encrypt), and stop
the hub container once:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.demo.yml rm -f -s app
docker compose -f docker-compose.prod.yml -f docker-compose.demo.yml up -d caddy app-demo
```

Auto-deploy reads the same flag: it starts the demo and Caddy, leaves
the hub service defined but never started, and waits on the demo's
health instead. The data directory is untouched by all of this — deleting
it is a separate, deliberate `rm`, and worth postponing until the hub has
lived somewhere else for a week.

### Usage statistics

The demo keeps anonymous usage statistics in `demo-stats.db` next to its
data: one row per sandbox — when it was created, the referrer that
brought the visitor, how long they stayed, whether they changed anything
and which modules they touched. No IPs or visitor identifiers are
stored. A ready-made report:

```bash
docker exec family-hub-demo bash scripts/demo-stats.sh
```

It prints sessions by day, engagement, top referrers and module
popularity. The file is an ordinary SQLite database — for anything
deeper, copy it off the server and query it however you like.

The auto-deploy below picks the demo up automatically: it checks the
server's `.env` for `DEMO_DOMAIN` and, when set, restarts both stacks —
the image is shared, so shipping a new image updates both.

## 10. Auto-deploy from GitHub

Once configured, every push to `master` deploys itself
(`.github/workflows/deploy.yml`): Actions checks types, **builds the
Docker image on its own runner** and delivers it to the server ready-made
(`docker save → ssh → docker load`). The server compiles nothing — a
1 GB machine cannot handle a Vite build; it used to drown in swap until
SSH dropped. Push to `master` = production deploy; unfinished work lives
in branches.

The workflow is a no-op by default so that forks of this repository
never try to deploy anywhere: it only runs when the repository variable
`DEPLOY_ENABLED` equals `true`.

Once:

1. A dedicated key pair used only for deploys (on your machine, no
   passphrase):

   ```bash
   ssh-keygen -t ed25519 -f hub-deploy-key -C "github-actions" -N ""
   ```

2. The public part — into the deploy user's authorized keys on the
   server:

   ```bash
   cat hub-deploy-key.pub | ssh hub@<IP> 'cat >> ~/.ssh/authorized_keys'
   ```

3. In the repository: Settings → Secrets and variables → Actions →
   New repository secret, three secrets:

   - `DEPLOY_HOST` — the server's IP
   - `DEPLOY_USER` — the user from step "A user instead of root"
     (e.g. `hub`); omit it and the workflow falls back to `root`
   - `DEPLOY_SSH_KEY` — the contents of the `hub-deploy-key` file
     (the secret part, in full, BEGIN/END lines included)

   And on the Variables tab next to Secrets — one variable:

   - `DEPLOY_ENABLED` = `true`

4. Delete the `hub-deploy-key` file from your machine afterwards — it
   lives only in GitHub secrets.

Verification: push any commit to `master` → the Actions tab → the
deploy job green → the hub responds. The final step waits for the
container's own healthcheck, so no public hostname lives in the
workflow. Manual deploys remain available just in case:
Actions → deploy → Run workflow; and the old rsync-from-your-machine
path still works as a fallback.

The deploy never touches `.env` on the server: it is excluded from
rsync, secrets keep living only on the machine.

## 11. Updates

The code updates itself on a push to `master` (section above). By hand —
only if Actions is unavailable:

```bash
# deliver the code with rsync, then on the server:
cd /srv/family-hub/app
docker compose -f docker-compose.prod.yml up -d --build
```

A manual build on the server is heavy (see above about 1 GB) — before
one, make sure the swap from the "Machine" section is configured, and do
not be alarmed that it takes several minutes.

Migrations apply themselves at startup. Data is untouched — it lives
outside the code folder.

Base images and dependencies: rebuild with `--pull` every month or two
(`docker compose -f docker-compose.prod.yml build --pull app`) and
review `npm audit` in the project. A public service is less forgiving
than a home one.

## What is already done for you

So you do not have to run checklists: in the production configuration
the app runs without root inside the container; only Caddy faces the
internet, the hub itself is unreachable from outside; a strict CSP and
the rest of the security headers are on; sign-in is protected by
per-login, per-IP and request-rate limits; HSTS is set by Caddy;
`/api/health` reveals nothing about the server beyond "alive".
