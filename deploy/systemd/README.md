# Cloud services

`kaki-server.service` runs the API server and `kaki-npc.service` runs the AI colleagues on the cloud VM. Both run in production mode, which refuses development-only switches such as scripted fake speech.

Install or update them on the VM after copying the app:

```sh
sudo cp ~/app/deploy/systemd/kaki-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart kaki-server kaki-npc
```

`/health` reports `fakeSpeech`; `npm run cloud:status` and the live checks fail if it is on.
