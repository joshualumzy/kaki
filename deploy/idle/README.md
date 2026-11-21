# Kaki VM idle switch-off

The cloud VM should not stay running when nobody is using Kaki. These files make the VM check
itself every 5 minutes and ask Azure to deallocate it when either of two rules says the room is
done:

- **Nobody is connected for an hour.** `peopleConnected` is `0` and `idleSeconds` is at least
  `KAKI_IDLE_MINUTES * 60` (60 minutes by default). One open tab can keep this rule from firing,
  because the page polls the server on a timer.
- **Nobody has done anything for two hours.** `actionIdleSeconds` is at least
  `KAKI_IDLE_BACKSTOP_MINUTES * 60` (120 minutes by default), even while people are connected. This
  rule follows real actions only: a person's command, a button press that changes something, or a
  line they speak or type. A page polling by itself does not count, so a forgotten tab cannot keep
  the VM on forever.

Both rules wait until the VM has been up for at least 15 minutes. A meeting that is cut off this way
is saved, and it is restored when someone wakes the VM again.

The check asks the Kaki server at `http://127.0.0.1:3001/idle`. If it cannot read a clear answer
(server down, bad JSON, unreadable uptime), it logs a loud error and leaves the VM running. It
records each good read in `KAKI_IDLE_STATE_FILE` (default `/var/lib/kaki-idle/last-ok`). If the
server stays unreadable for the whole backstop, measured from the last good read or from boot when
there is no record, the check switches the VM off rather than leaving a hung server running all
night. Dry runs still make no Azure call.

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
KAKI_IDLE_BACKSTOP_MINUTES=120
KAKI_IDLE_STATE_FILE=/var/lib/kaki-idle/last-ok
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

Each run writes one line with the decision, which rule decided it and the numbers, for example:

```text
kaki-idle: decision=stay on: idle 120s is under 3600s rule=idle window peopleConnected=0 idleSeconds=120 actionIdleSeconds=3000 thresholdSeconds=3600 backstopSeconds=7200 uptimeSeconds=950
kaki-idle: decision=deallocate: no person action for 7600s, over the 7200s backstop rule=action backstop peopleConnected=1 idleSeconds=12 actionIdleSeconds=7600 thresholdSeconds=3600 backstopSeconds=7200 uptimeSeconds=8600
```

When the server cannot be read for the whole backstop, the loud line is:

```text
kaki-idle: server unreadable for 120 min; switching off (GET http://127.0.0.1:3001/idle failed)
```
