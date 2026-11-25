# Cloud services

`kaki-server.service` runs the API server and `kaki-npc.service` runs the AI colleagues on the cloud VM. Both run in production mode, which refuses development-only switches such as scripted fake speech.

Install or update them on the VM after copying the app:

```sh
sudo cp ~/app/deploy/systemd/kaki-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart kaki-server kaki-npc
```

`/health` reports `fakeSpeech`; `npm run cloud:status` and the live checks fail if it is on.

## Log retention

Kaki keeps its server and meeting logs so the team can investigate playtest complaints; the logs can contain meeting text. The journald drop-in caps the journal at 30 days and journald removes older entries on its next rotation. Install it in the same deploy pass as the services:

```sh
sudo install -d -m 755 /etc/systemd/journald.conf.d
sudo cp ~/app/deploy/journald/kaki-retention.conf /etc/systemd/journald.conf.d/
sudo systemctl restart systemd-journald
sudo journalctl --vacuum-time=30day
```

The vacuum applies the 30-day limit immediately instead of waiting for the next rotation. To confirm it is loaded:

```sh
sudo systemctl show systemd-journald -p DropInPaths
sudo journalctl --disk-usage
```

## Nightly database backup

The backup unit dumps the app database from the compose Postgres container, keeps the newest seven compressed dumps in `/var/backups/kaki` and removes older ones. It reads `POSTGRES_URL` from the server's `~/app/.env`, so the database password stays out of the repository and the unit. It runs at 02:30 and after any missed run when the VM boots.

Install it in the same deploy pass:

```sh
sudo cp ~/app/deploy/backup/kaki-backup.sh /usr/local/bin/kaki-backup.sh
sudo chmod 755 /usr/local/bin/kaki-backup.sh
sudo cp ~/app/deploy/backup/kaki-backup.service ~/app/deploy/backup/kaki-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kaki-backup.timer
```

Check one run now, and see [`../backup/README.md`](../backup/README.md) for settings and for the restore command:

```sh
sudo systemctl start kaki-backup.service
sudo journalctl -u kaki-backup.service -n 20 --no-pager
sudo ls -l /var/backups/kaki
```

To restore a dump, stop the two Kaki services first, pipe the chosen dump into `psql` in the Postgres container with `ON_ERROR_STOP=1`, then start them again. Run this as root (`sudo -i`), because the backup directory and dumps are root-only, and note that it replaces the live data:

```sh
systemctl stop kaki-server kaki-npc
read -r DB_USER DB_NAME < <(node /home/azureuser/app/deploy/backup/read-postgres-url.mjs /home/azureuser/app/.env)
gunzip -c /var/backups/kaki/kaki-YYYYmmddTHHMMSSZ.sql.gz |
  docker compose -f /home/azureuser/app/docker/docker-compose.yml exec -T postgres \
  psql -w -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME"
systemctl start kaki-server kaki-npc
```

More detail and the settings are in [`../backup/README.md`](../backup/README.md#restore).
