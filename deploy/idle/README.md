# Kaki VM idle switch-off

The cloud VM should not stay running when nobody is using Kaki. These files make the VM check
itself every 5 minutes and ask Azure to deallocate it once it has been idle for 60 minutes.

The check asks the Kaki server at `http://127.0.0.1:3001/idle`. If it cannot read a clear answer
(server down, bad JSON, unreadable uptime), it logs a loud error and leaves the VM running. It only
switches off when all three are true:

- `peopleConnected` is `0` (no browser or phone is connected; the AI runner does not count),
- `idleSeconds` is at least `KAKI_IDLE_MINUTES * 60` (60 minutes by default),
- the VM has been up for at least 15 minutes.

The script uses `jq` if it is installed on Ubuntu; otherwise it uses Node, which is already on the
VM.

## Azure prerequisite

The VM needs a system-assigned managed identity that may deallocate itself. Create a custom role
that allows only these two actions:

- `Microsoft.Compute/virtualMachines/deallocate/action`
- `Microsoft.Compute/virtualMachines/read`

Assign that role to the VM's identity at the VM scope (for example `kaki-vm`). Nothing wider is
needed. Without this, the check will keep running but Azure will refuse the deallocate request.

## Install on the VM

```bash
sudo cp kaki-idle-check.sh /usr/local/bin/kaki-idle-check.sh
sudo cp kaki-idle.service kaki-idle.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kaki-idle.timer
```

The service runs as root. Settings are optional; put them in `/etc/kaki-idle.env`, one `KEY=value`
per line:

```bash
KAKI_IDLE_URL=http://127.0.0.1:3001/idle
KAKI_IDLE_MINUTES=60
# KAKI_IDLE_DRY_RUN=1
```

## Dry run

Dry run reads the server, prints the decision and the Azure URL it would call, and makes no Azure
call:

```bash
sudo KAKI_IDLE_DRY_RUN=1 /bin/bash /usr/local/bin/kaki-idle-check.sh
```

## Logs

```bash
sudo systemctl list-timers kaki-idle.timer
sudo journalctl -u kaki-idle.service -n 20 --no-pager
```

Each run writes one line with the decision and the numbers, for example:

```text
kaki-idle: decision=stay on: idle 120s is under 1800s peopleConnected=0 idleSeconds=120 thresholdSeconds=1800 uptimeSeconds=950
```
