# Kaki nightly database backup

Kaki's Postgres runs in the compose stack (`docker/docker-compose.yml`). This unit runs `pg_dump`
inside that Postgres container every night, compresses the dump and keeps the newest seven. It reads
the database user and name from the same `POSTGRES_URL` the server loads from `~/app/.env`, so no
database password is written into this repository or into the script.

Dumps go to `/var/backups/kaki` by default. The directory is root-only (`0700`), each dump is
root-only (`0600`), and old dumps are removed only after a new dump has been written and checked. A
failed or empty dump exits non-zero, leaves the previous backups alone and prints the reason to
`journalctl`.

## Install on the VM

Run these from the repository copy at `~/app`, together with the other deploy steps in
[`../systemd/README.md`](../systemd/README.md):

```bash
sudo cp ~/app/deploy/backup/kaki-backup.sh /usr/local/bin/kaki-backup.sh
sudo chmod 755 /usr/local/bin/kaki-backup.sh
sudo cp ~/app/deploy/backup/kaki-backup.service ~/app/deploy/backup/kaki-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kaki-backup.timer
```

Run it once now rather than waiting for 02:30:

```bash
sudo systemctl start kaki-backup.service
sudo journalctl -u kaki-backup.service -n 20 --no-pager
sudo ls -l /var/backups/kaki
```

The timer runs at 02:30 with up to five minutes of jitter. `Persistent=true` runs a missed backup on
the next boot, because the idle check may have switched the VM off overnight.

## Settings

The defaults match the VM. To change one, put it in `/etc/kaki-backup.env`, one `KEY=value` per line:

```bash
KAKI_APP_DIR=/home/azureuser/app
KAKI_ENV_FILE=/home/azureuser/app/.env
KAKI_COMPOSE_FILE=/home/azureuser/app/docker/docker-compose.yml
KAKI_BACKUP_DIR=/var/backups/kaki
KAKI_BACKUP_KEEP=7
```

`KAKI_ENV_FILE` must be the server's env file: the script reads `POSTGRES_URL` from it. If that file
does not exist, or `POSTGRES_URL` is missing or invalid, the backup fails loudly instead of guessing.

## Restore

Restoring replaces the live database, so stop the two Kaki services first. Run this as root
(`sudo -i`), because `/var/backups/kaki` and its dumps are readable by root only:

```bash
systemctl stop kaki-server kaki-npc

read -r DB_USER DB_NAME < <(node /home/azureuser/app/deploy/backup/read-postgres-url.mjs /home/azureuser/app/.env)
gunzip -c /var/backups/kaki/kaki-YYYYmmddTHHMMSSZ.sql.gz |
  docker compose -f /home/azureuser/app/docker/docker-compose.yml exec -T postgres \
  psql -w -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME"

systemctl start kaki-server kaki-npc
```

The dump is plain SQL with `--clean --if-exists`, so psql drops the existing Kaki objects and
recreates them from the dump. `ON_ERROR_STOP=1` makes psql exit non-zero on the first error rather
than carrying on with half a restore.

## Tests and checks

```bash
bash -n deploy/backup/kaki-backup.sh
shellcheck deploy/backup/kaki-backup.sh
node deploy/backup/read-postgres-url.mjs .env   # prints "user<TAB>database", never the password
```
