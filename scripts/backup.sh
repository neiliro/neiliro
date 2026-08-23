#!/usr/bin/env bash
# Nightly backup: database snapshot, notes export to markdown, encryption, git push.
# Goes into cron at 03:00. Attachments are not included — Time Machine covers them.
# On a hosted server (a families/ directory in DATA_DIR) the shape changes:
# one encrypted archive per family, attachments included — see below.
set -euo pipefail

DATA_DIR="${DATA_DIR:-$HOME/.family-hub}"
BACKUP_DIR="$DATA_DIR/backups"
REPO_DIR="${BACKUP_REPO_DIR:-$HOME/family-hub-backup}"
AGE_RECIPIENT="${AGE_RECIPIENT:-}"
STAMP=$(date +%Y-%m-%d)

# Dead-man switch (optional): ping a healthchecks.io-style URL on every
# outcome, so a backup that silently stops running raises an alarm — the
# one failure mode a nightly cron hides best. The app container ships no
# curl; node is always there.
PING_URL="${BACKUP_PING_URL:-}"
report() {
  [ -z "$PING_URL" ] && return 0
  node -e "fetch(process.argv[1], { signal: AbortSignal.timeout(10000) }).catch(() => {})" \
    "$PING_URL$1" 2>/dev/null || true
}
trap 'status=$?; if [ "$status" -eq 0 ]; then report ""; else report "/fail"; fi' EXIT

mkdir -p "$BACKUP_DIR"

# ── Hosted: one server, many families ───────────────────────────────────────
# family = subdomain = one SQLite file in families/<id>/ (see
# docs/architecture.md, "Hosted mode"). Each family becomes its own
# encrypted archive: database snapshot PLUS attachments — unlike the
# single-family install below, there is no Time Machine behind a hosted
# server, and the attachments are other people's data. The registry
# (slug → id mapping) is snapshotted alongside, so any archive can be
# matched to its family even after renames. Notes are not exported to
# markdown here: that insurance is for reading one's own data without
# the app, and hosted families get the in-app export for that.
if [ -d "$DATA_DIR/families" ]; then
  if [ -z "$AGE_RECIPIENT" ]; then
    echo "AGE_RECIPIENT is not set — refusing to write other people's data unencrypted." >&2
    exit 1
  fi

  DAY_DIR="$BACKUP_DIR/$STAMP"
  mkdir -p "$DAY_DIR"

  sqlite3 "$DATA_DIR/registry.db" ".backup '$DAY_DIR/registry.db'"

  count=0
  for family_dir in "$DATA_DIR/families"/*/; do
    [ -f "$family_dir/hub.db" ] || continue
    family_id=$(basename "$family_dir")

    # The slug in the filename is ops convenience (which archive is whose);
    # the id is the stable truth — restores match by id.
    slug=$(sqlite3 "$DAY_DIR/registry.db" \
      "SELECT slug FROM families WHERE id = '$family_id';" 2>/dev/null || true)
    name="${slug:-unknown}.$family_id"

    snap_dir="$DAY_DIR/$family_id.snap"
    mkdir -p "$snap_dir"
    sqlite3 "$family_dir/hub.db" ".backup '$snap_dir/hub.db'"

    if [ -d "$family_dir/attachments" ]; then
      tar -czf "$DAY_DIR/$name.tar.gz" -C "$snap_dir" hub.db -C "$family_dir" attachments
    else
      tar -czf "$DAY_DIR/$name.tar.gz" -C "$snap_dir" hub.db
    fi
    rm -rf "$snap_dir"

    age -r "$AGE_RECIPIENT" -o "$DAY_DIR/$name.tar.gz.age" "$DAY_DIR/$name.tar.gz"
    rm -f "$DAY_DIR/$name.tar.gz"
    count=$((count + 1))
  done

  age -r "$AGE_RECIPIENT" -o "$DAY_DIR/registry.db.age" "$DAY_DIR/registry.db"
  # The slug SELECTs above open the snapshot and, since WAL mode is
  # persisted in the file, leave empty -wal/-shm companions — sweep them
  # together with the plaintext snapshot.
  rm -f "$DAY_DIR/registry.db" "$DAY_DIR/registry.db-wal" "$DAY_DIR/registry.db-shm"

  # Keep two weeks of daily directories, like the single-family path
  find "$BACKUP_DIR" -maxdepth 1 -type d -name '20*' -mtime +14 -exec rm -rf {} + 2>/dev/null || true

  echo "Hosted backup $STAMP is ready: $count families."
  exit 0
fi

# 1. Consistent database snapshot (safe while the app is running)
sqlite3 "$DATA_DIR/hub.db" ".backup '$BACKUP_DIR/hub-$STAMP.db'"

# 2. Notes export to markdown — insurance in case the app dies
NOTES_DIR="$BACKUP_DIR/notes-$STAMP"
mkdir -p "$NOTES_DIR"
# A newline in a title would break line-by-line reading — replace with a space
sqlite3 "$BACKUP_DIR/hub-$STAMP.db" \
  "SELECT id || '|' || replace(replace(replace(title, '|', '-'), char(10), ' '), char(13), ' ') FROM notes;" |
while IFS='|' read -r note_id note_title; do
  [ -z "$note_id" ] && continue
  safe_title=$(echo "$note_title" | tr '/' '-')
  target="$NOTES_DIR/$safe_title.md"
  # Titles may collide: without a suffix the second note would silently
  # overwrite the first, and content would vanish from the export
  if [ -e "$target" ]; then
    target="$NOTES_DIR/$safe_title-${note_id:0:8}.md"
  fi
  sqlite3 "$BACKUP_DIR/hub-$STAMP.db" \
    "SELECT body_md FROM notes WHERE id = '$note_id';" > "$target"
done

# 3. Archive and encrypt
tar -czf "$BACKUP_DIR/hub-$STAMP.tar.gz" -C "$BACKUP_DIR" "hub-$STAMP.db" "notes-$STAMP"

if [ -n "$AGE_RECIPIENT" ]; then
  age -r "$AGE_RECIPIENT" -o "$BACKUP_DIR/hub-$STAMP.tar.gz.age" "$BACKUP_DIR/hub-$STAMP.tar.gz"
  ARTIFACT="$BACKUP_DIR/hub-$STAMP.tar.gz.age"
  rm -f "$BACKUP_DIR/hub-$STAMP.tar.gz"
else
  echo "AGE_RECIPIENT is not set — the backup is unencrypted. Not pushing to the private repository." >&2
  exit 1
fi

# 4. Push to the private repository
if [ -d "$REPO_DIR/.git" ]; then
  cp "$ARTIFACT" "$REPO_DIR/"
  cd "$REPO_DIR"
  git add -A
  git commit -m "Backup $STAMP" --quiet || true
  git push --quiet
fi

# 5. Keep two weeks locally
find "$BACKUP_DIR" -name 'hub-*.db' -mtime +14 -delete
find "$BACKUP_DIR" -name 'notes-*' -type d -mtime +14 -exec rm -rf {} + 2>/dev/null || true

echo "Backup $STAMP is ready."
