#!/usr/bin/env bash
# Bring up the hosted QA stand: the hub in hosted mode, the support site,
# and a browser that believes both of them are neiliro.com.
#
# Why this exists next to the `qa-hosted` configuration in launch.json:
#
#   1. That one runs the server with tsx on the host's Node. better-sqlite3
#      is a native module, and a host Node newer than its prebuilds cannot
#      load it — the process dies before it serves anything. The container
#      carries its own Node and its own build.
#   2. The support link only appears on our own apex (web/src/lib/support.ts:
#      hosted mode alone is not enough, or someone else's service would send
#      us their families' messages). On hub.localhost it is correctly
#      invisible — so the flow that has to be tested cannot be reached.
#
# So this stand serves the hub as *.neiliro.com and points the browser at
# it with --host-resolver-rules. No /etc/hosts, no sudo, and the mapping
# lives in one throwaway browser profile rather than on the machine.
#
# It also puts Caddy in front, which is not decoration. The app's CSP
# carries upgrade-insecure-requests, so over plain http a browser upgrades
# the bundle to https and the page never boots — invisible on
# *.hub.localhost only because browsers count those as trustworthy and skip
# the upgrade. On a real-looking hostname the stand has to speak TLS, which
# is also what production does.
#
#   ./scripts/qa-stack.sh up      # build, provision, start, print URLs
#   ./scripts/qa-stack.sh browser # open a Chrome that resolves the stand
#   ./scripts/qa-stack.sh down    # remove the container and the data
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WWW="${WWW_REPO:-$HOME/Documents/neiliro-www}"
DATA="${QA_DATA_DIR:-$HOME/.family-hub-qa-hosted}"
PROFILE="${QA_BROWSER_PROFILE:-$HOME/.family-hub-qa-browser}"
CONTAINER=neiliro-qa
PROXY=neiliro-qa-caddy
TMP="${TMPDIR:-/tmp}"
TMP="${TMP%/}"
IMAGE=neiliro:qa
HUB_PORT=8787
TLS_PORT=8443
WWW_PORT=8788
FAMILIES=(smiths-qa01 jones-qa02)
CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

# support.neiliro.com must resolve to the support site and every other
# subdomain to the hub, so the specific rule comes first. The apex is left
# alone: the FAQ links to the real privacy policy and terms.
#
# The rules carry the port too, so the addresses in the browser are the
# production ones — https://smiths-qa01.neiliro.com, no port to remember,
# and the support link in the app is followed rather than read.
RESOLVER="MAP support.neiliro.com 127.0.0.1:${WWW_PORT}, MAP *.neiliro.com 127.0.0.1:${TLS_PORT}"

# Detached with all three descriptors closed: a background job still
# holding the script's stdout keeps the caller waiting forever.
start_www() {
  echo "==> starting the support site on :${WWW_PORT}"
  pkill -f "wrangler pages dev" >/dev/null 2>&1 || true
  cd "$WWW"
  npx --yes wrangler@latest d1 execute neiliro-waitlist --local --file=schema.sql >/dev/null 2>&1 || true
  # https, because the app links to https://support.neiliro.com and a
  # click has to actually arrive. The certificate is wrangler's own
  # throwaway one, which is why the QA browser ignores certificate errors.
  nohup npx --yes wrangler@latest pages dev --port "$WWW_PORT" --local-protocol https \
    >"${TMP}/qa-www.log" 2>&1 </dev/null &
  disown
  cd "$REPO"
  for _ in $(seq 1 40); do
    curl -skf -o /dev/null "https://127.0.0.1:${WWW_PORT}/support" && break
    sleep 1
  done
}

case "${1:-up}" in
up)
  echo "==> building ${IMAGE} from $(git -C "$REPO" branch --show-current)"
  docker build -q -t "$IMAGE" "$REPO" >/dev/null

  echo "==> starting the hub on :${HUB_PORT}"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  mkdir -p "$DATA"
  # The API key is a placeholder, and that is the point: its presence is
  # what makes the hub advertise password reset, so the screen exists to be
  # tested. Nothing can actually be sent — the provider rejects the key, the
  # attempt shows in `docker logs`, and the route answers the same either
  # way by design. Inbound mail is genuinely testable: see `mail` below.
  docker run -d --name "$CONTAINER" -p "${HUB_PORT}:8787" \
    -e HOSTED_MODE=true -e HOSTED_DOMAIN=neiliro.com \
    -e MAIL_DOMAIN=mail.neiliro.com -e MAILGUN_SIGNING_KEY=qa-signing-key \
    -e MAILGUN_API_KEY=qa-cannot-send \
    -e TRUST_PROXY=true -e SECURE_COOKIES=true \
    -e LOG_LEVEL=info \
    -v "${DATA}:/data" --user 0:0 "$IMAGE" >/dev/null

  for _ in $(seq 1 40); do
    curl -sf -o /dev/null "http://127.0.0.1:${HUB_PORT}/api/health" && break
    sleep 1
  done

  echo "==> putting TLS in front on :${TLS_PORT}"
  docker rm -f "$PROXY" >/dev/null 2>&1 || true
  # A self-signed wildcard, made here rather than left to Caddy's internal
  # CA: a site block with no hostname does not turn TLS on by itself, and
  # naming the hosts would leave the ghost — whose whole point is being an
  # arbitrary name — without a certificate.
  if [ ! -f "${TMP}/qa-cert.pem" ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
      -keyout "${TMP}/qa-key.pem" -out "${TMP}/qa-cert.pem" \
      -subj "/CN=*.neiliro.com" \
      -addext "subjectAltName=DNS:*.neiliro.com,DNS:neiliro.com" >/dev/null 2>&1
  fi
  printf '{\n  auto_https off\n  admin off\n}\n:8443 {\n  tls /etc/caddy/cert.pem /etc/caddy/key.pem\n  reverse_proxy host.docker.internal:%s\n}\n' "$HUB_PORT" >"${TMP}/qa-Caddyfile"
  docker run -d --name "$PROXY" -p "${TLS_PORT}:8443" \
    -v "${TMP}/qa-Caddyfile:/etc/caddy/Caddyfile:ro" \
    -v "${TMP}/qa-cert.pem:/etc/caddy/cert.pem:ro" \
    -v "${TMP}/qa-key.pem:/etc/caddy/key.pem:ro" \
    caddy:2-alpine >/dev/null
  for _ in $(seq 1 40); do
    curl -skf -o /dev/null "https://127.0.0.1:${TLS_PORT}/api/health" && break
    sleep 1
  done

  # --no-invite: the stand hands the hub over locally, which is exactly the
  # operator case that flag exists for (#157). And the result is checked
  # rather than grepped for a happy line: when the CLI's signature changed
  # the old `|| true` swallowed the usage error, and the banner below went
  # on promising family URLs that all answered as ghosts (#190).
  for slug in "${FAMILIES[@]}"; do
    if out=$(docker exec "$CONTAINER" node server/dist/cli/create-family.js "$slug" --no-invite 2>&1); then
      echo "$out" | grep -E 'Family created' || true
    elif echo "$out" | grep -q 'already taken'; then
      # A second `up` over kept data: the family is there, nothing to do
      echo "  ${slug}: already provisioned"
    else
      echo "!! could not provision ${slug}:" >&2
      echo "$out" | sed 's/^/   /' >&2
      exit 1
    fi
  done

  start_www

  cat <<EOF

Stand is up. In the QA browser (./scripts/qa-stack.sh browser):

  https://smiths-qa01.neiliro.com   → the family under test
  https://jones-qa02.neiliro.com    → its neighbour, for isolation checks
  https://nobody-qa99.neiliro.com   → the ghost
  https://support.neiliro.com       → the support site, where the app's
                                      footer link lands

Ports live in the resolver rules, so these are the production addresses
exactly — including the https, which the app's CSP requires.

Inbound mail (no Mailgun involved), from a shell:
  ${REPO}/scripts/qa-stack.sh mail smiths-qa01

Data: ${DATA} — disposable, delete it for a clean run.
EOF
  ;;

www)
  start_www
  echo "support site ready on :${WWW_PORT}"
  ;;

browser)
  echo "==> Chrome with its own profile, resolving *.neiliro.com to the stand"
  mkdir -p "$PROFILE"
  # The certificate belongs to wrangler's local server; this profile talks
  # to nothing but 127.0.0.1, which is what the resolver rules guarantee.
  "$CHROME" --user-data-dir="$PROFILE" \
    --host-resolver-rules="$RESOLVER" \
    --ignore-certificate-errors \
    "https://smiths-qa01.neiliro.com" >/dev/null 2>&1 &
  ;;

mail)
  slug="${2:-smiths-qa01}"
  ts=$(date +%s)
  token=$(printf 'a%.0s' {1..50})
  sig=$(printf '%s%s' "$ts" "$token" | openssl dgst -sha256 -hmac 'qa-signing-key' -hex | sed 's/.*= //')
  mime=$(printf 'Message-ID: <qa-%s@school.example>\r\nFrom: office@school.example\r\nTo: %s@mail.neiliro.com\r\nSubject: QA letter\r\n\r\nBody.\r\n' "$ts" "$slug")
  curl -sS -X POST "http://127.0.0.1:${HUB_PORT}/api/mail/inbound/mime" \
    -H "Host: in.neiliro.com" \
    --data-urlencode "timestamp=$ts" --data-urlencode "token=$token" \
    --data-urlencode "signature=$sig" \
    --data-urlencode "recipient=${slug}@mail.neiliro.com" \
    --data-urlencode "body-mime=$mime"
  echo
  ;;

down)
  docker rm -f "$CONTAINER" "$PROXY" >/dev/null 2>&1 || true
  pkill -f "wrangler pages dev" >/dev/null 2>&1 || true
  rm -rf "$DATA"
  echo "stand removed, ${DATA} deleted"
  ;;

*)
  echo "usage: $0 {up|browser|mail [slug]|down}" >&2
  exit 1
  ;;
esac
