# Kaki waking page

Kaki runs on an Azure VM that is usually switched off to save money. This folder is a small
[Azure Static Web App](https://learn.microsoft.com/azure/static-web-apps/) that is always on: it looks
like Kaki's front door, and when someone picks an option it starts the VM, waits for Kaki to answer,
then sends them to the real site.

The static page is plain HTML, CSS and JavaScript with no build step. Two Azure Functions do the work:

- `GET /api/status` asks Azure for the VM's power state and, only when it is running, probes
  `KAKI_URL/health`. It answers `{ power, healthy }`.
- `POST /api/wake` starts the VM when it is deallocated or stopped. It answers `{ started: true }`,
  `{ started: false, power }` if Kaki is already on, or a 409 while the VM is switching off.

The browser polls `/api/status` every 5 seconds for up to 5 minutes. If that runs out, or Azure
returns an error, the page says so and offers a Try again button. It never retries forever.

The address of the real site is the `KAKI_URL` constant at the top of `site/app.js`; change it there
if the VM's DNS name changes.

## Files

```
wake/
  site/                    the page (deployed as the static app)
    index.html
    styles.css             copied from web/src/ui and web/src/landing
    app.js                 status check, wake flow, redirect
    favicon.svg            same icon as the web app
  api/                     the functions (Node 22, @azure/functions v4)
    src/config.js          reads app settings, names any that are missing
    src/azure.js           client-credentials token cache and Azure calls
    src/handlers.js        /api/status and /api/wake behaviour
    src/functions.js       registers both HTTP functions
    test/                  vitest tests; fetch is mocked
  staticwebapp.config.json
```

## App settings

Set these as environment variables on the Static Web App (Configuration → Environment variables).
They are the only place the values should live; nothing is logged.

| Setting | What it is |
| --- | --- |
| `AZURE_TENANT_ID` | Tenant of the app registration used to sign in to Azure |
| `AZURE_CLIENT_ID` | That app registration's client ID |
| `AZURE_CLIENT_SECRET` | Its client secret |
| `AZURE_SUBSCRIPTION_ID` | Subscription that holds the Kaki VM |
| `KAKI_RESOURCE_GROUP` | Resource group that holds the Kaki VM |
| `KAKI_VM_NAME` | The VM's name (`kaki-vm`) |
| `KAKI_URL` | `https://kaki.southeastasia.cloudapp.azure.com` (no trailing slash needed) |

If any of these is missing, both endpoints answer 500 with the names of the missing settings. They
never echo a value.

## The identity needs a custom role, not Contributor

Give the app registration's service principal its own role with only two permissions, assigned on the
`kaki-vm` resource (not on the subscription or resource group):

- `Microsoft.Compute/virtualMachines/instanceView/read` — to read the power state.
- `Microsoft.Compute/virtualMachines/start/action` — to start it.

Nothing else is needed: the page has no way to stop, delete or resize anything. Keep the secret in the
Static Web App settings, not in this repository.

## Running it locally

Install the API's dependencies once:

```bash
cd wake/api && npm install
```

Then start the page and API together with the Static Web Apps CLI (the first `npx` run downloads the
CLI; it is not installed globally):

```bash
npx @azure/static-web-apps-cli start wake/site --api-location wake/api
```

Add `--config wake/staticwebapp.config.json` if you also want the production headers applied locally.
The CLI serves the page at `http://localhost:4280` and proxies `/api/*` to the functions. Export the
seven settings above in the shell you start it from so the functions can reach Azure. Without them
the page still loads, by design, and `/api/status` answers 500 naming what is missing.

## Tests

```bash
cd wake/api && npx vitest run
```

The same tests also run from the repository root with `npx vitest run`: there is no `wake/` exclude,
so the root run includes them. They mock `fetch` and need no Azure access.

## Deploying

Point the Static Web Apps deployment at this folder:

- App location: `wake/site`
- API location: `wake/api`
- Output location: empty (there is no build)
- Config file location: `wake` — `staticwebapp.config.json` lives at the folder root, and this setting
  keeps it next to the deployed site.

The config sets the API runtime to `node:22`, allows anonymous access to `/api/*` and adds basic
security headers.
