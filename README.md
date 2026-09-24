# Paperless Backend

Node.js/Express + PostgreSQL backend for a paperless production-floor system:
it tracks workstations on the shop floor, serves production documents (PDFs)
to the **Paperless Mobile** app, receives production-order events, prints
hardware labels/QR stickers, and pushes live updates over Socket.IO.

---

## 1. What this service does

- **Workstation tracking** — polls the production system's API
  (`WORKSTATIONS_API_URL`) on an interval and mirrors workstation/order state
  into Postgres (`workstationService.ts`).
- **Order-update webhook** — the production system calls
  `POST /workstations/order-update` on `STARTED`/`FINISHED` order events.
  This single event fans out to:
  - Hardware label + QR sticker printing (`labelPrintingService.ts`)
  - Live Socket.IO broadcast to connected mobile clients
- **Document serving & annotation** — stores/serves production PDFs, tracks
  revisions, and lets the mobile app export edited/annotated PDFs as
  PDF/A (`filesController.ts`, `pdfaService.ts`).
- **Prep queue** — reads a `productionPlanPTL.json` drop from a network
  share on a timer and exposes it as a queryable prep queue
  (`ptlPlanService.ts`).
- **Order completion / employee tracking** — kiosk-style "who finished this
  order and what was its status" logging (`completionController.ts`).
- **Prep-station labels** — 100 × 130 mm Godex-sized label PDFs with a Code
  39 ("3 of 9") barcode of the order/project number, rendered with the BC
  3of9 Light font (embedded into the PDF when the font file is found; vector
  bars otherwise) — `documentPrinterService.buildPrepLabelPdf`,
  `utils/code39Barcode.ts`.
- **Retention archival** — periodic sweep that moves finished orders' PDFs
  to PDF/A and archives them to a network share (`archivalService.ts`).
- **Document printing** — sends rendered documents to a network printer
  (`documentPrinterService.ts`).
- **Logging** — timestamped, leveled logs go to the console **and**
  `app.log` in the project root (`utils/logger.ts`). All pre-existing
  `console.*` output is captured into the file too, so the file is a
  complete record across restarts.

## 2. Tech stack

| Layer       | Choice                                                             |
| ----------- | ------------------------------------------------------------------ |
| Runtime     | Node.js + TypeScript (`ts-node`/`tsc`)                             |
| HTTP        | Express 5                                                          |
| Realtime    | Socket.IO 4                                                        |
| Database    | PostgreSQL via Knex query builder                                  |
| Testing     | Jest + Supertest, `ts-jest`                                        |
| Packaging   | `@yao-pkg/pkg` → standalone `.exe`                                 |
| Lint/format | ESLint 10 (flat config) + Prettier, Husky + lint-staged pre-commit |

## 3. Project layout

```
src/
├── index.ts                  # App bootstrap: express, http server, socket.io,
│                              # dotenv (must load first), route mounting,
│                              # polling/archival/prep-queue interval starters
├── config/
│   ├── database.ts           # Postgres/Knex connection + schema setup
│   ├── documentTypes.ts
│   ├── icc/, pdfa/           # Color profiles / PDF-A conversion assets
├── routes/                   # Thin Express routers, one per resource
│   ├── workstations.ts       # /workstations
│   ├── files.ts              # /files
│   ├── queue.ts              # /queue
│   ├── prepQueue.ts          # /prep-queue
│   └── employees.ts          # /employees
├── controllers/              # Request handling per route file
│   ├── workstationController.ts
│   ├── filesController.ts
│   ├── queueController.ts
│   ├── prepQueueController.ts
│   └── completionController.ts
├── services/                 # Business logic, no req/res
│   ├── workstationService.ts     # polling, order-update handling, socket emits
│   ├── labelPrintingService.ts   # hardware label + QR sticker pipeline (~1090 lines)
│   ├── ptlPlanService.ts         # prep-queue plan file watcher
│   ├── completionService.ts
│   ├── archivalService.ts        # PDF/A retention sweep
│   ├── documentPrinterService.ts # network printer output
│   ├── pdfaService.ts            # Ghostscript-based PDF → PDF/A conversion
│   └── notificationService.ts    # queue-updated / queue-new-item socket emits
├── models/
├── utils/
│   ├── logger.ts             # Leveled logger: console + app.log capture
│   └── code39Barcode.ts      # Code 39 geometry, BC3of9 font discovery + PDF embedding
└── tests/
    ├── unit/
    ├── integration/
    └── helpers/
```

## 4. REST API surface

| Method | Path                                 | Purpose                                                                                                   |
| ------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                            | Liveness check                                                                                            |
| GET    | `/workstations`                      | Current state of all tracked workstations                                                                 |
| GET    | `/workstations/workplaces`           | Distinct list of known workplace names                                                                    |
| POST   | `/workstations/order-update`         | **Webhook** from the production system (`STARTED`/`FINISHED`); triggers label printing + socket broadcast |
| GET    | `/workstations/log`                  | Historical order-update log                                                                               |
| POST   | `/workstations/import-pbom`          | Import a product BOM document set for an order                                                            |
| GET    | `/workstations/search-pbom`          | Search available P-BOM documents                                                                          |
| GET    | `/workstations/pbom-types`           | List known P-BOM document types                                                                           |
| POST   | `/workstations/order-completion`     | Record order completion status (kiosk)                                                                    |
| POST   | `/workstations/print-prep-label`     | Print a prep-station label                                                                                |
| POST   | `/workstations/save-edited`          | Save an annotated/edited document revision                                                                |
| GET    | `/workstations/documents/:id/render` | Render a document (e.g. flatten annotations) for viewing/printing                                         |
| GET    | `/files`                             | Documents overview (list, with status/completion flags)                                                   |
| GET    | `/files/:id`                         | Single document record                                                                                    |
| POST   | `/files/:id/export-pdfa`             | Convert & export a document as PDF/A                                                                      |
| GET    | `/queue`                             | Print/processing queue                                                                                    |
| POST   | `/queue`                             | Add an item to the queue                                                                                  |
| PATCH  | `/queue/:id/status`                  | Update a queue item's status                                                                              |
| GET    | `/prep-queue`                        | List prep-queue items (filter by date/workplace)                                                          |
| GET    | `/prep-queue/workplaces`             | Distinct workplaces in the prep queue                                                                     |
| POST   | `/prep-queue/refresh`                | Force a re-read of the production plan file                                                               |
| GET    | `/employees`                         | List employees                                                                                            |
| POST   | `/employees`                         | Create an employee                                                                                        |
| GET    | `/files/*` (static)                  | Serves PDFs from `STORAGE_PATH`                                                                           |

## 5. Socket.IO events (server → client)

| Event                      | Emitted by               | Payload                                                     | Purpose                                  |
| -------------------------- | ------------------------ | ----------------------------------------------------------- | ---------------------------------------- |
| `workstation-order-update` | `workstationService.ts`  | `{ order, cycleIndex, totalCycles, _id, datetime, action }` | Real-time order STARTED/FINISHED event   |
| `workstations-updated`     | `workstationService.ts`  | full workstation list (or none)                             | Tells clients to refetch `/workstations` |
| `queue-updated`            | `notificationService.ts` | queue item                                                  | A queue item changed                     |
| `queue-new-item`           | `notificationService.ts` | queue item                                                  | A new item was added to the queue        |

CORS is currently wide open (`origin: "*"`) on both the HTTP and Socket.IO
layers, matching the mobile app connecting from arbitrary dev-machine IPs.

## 6. Running locally

```bash
npm install
cp .env.example .env      # fill in DB + network share + printer settings
npm run dev                # nodemon + ts-node, watches src/**/*.ts
```

The server logs to the console and appends to `app.log` in the project
root (gitignored). Tune with `LOG_LEVEL` (`debug|info|warn|error`, default
`info`) and `LOG_FILE_PATH` in `.env` — see `.env.example`.

For the barcode on prep-station labels, drop the `BC C39 3 of 9 Light.ttf`
font file into `config/` (or point `PREP_LABEL_BARCODE_FONT_PATH` at it).
Without it the barcode is drawn as vector bars instead — same symbology,
slightly different look.

Other scripts:

```bash
npm run build               # tsc -> dist/
npm start                   # node dist/index.js
npm test                    # jest --forceExit
npm run lint / format
npm run test:compare        # VBA-vs-backend label byte-comparison (Windows/PowerShell)
```

Requires a reachable PostgreSQL instance (`createdb paperless`) and, for the
label-printing and document features specifically, the Windows network
shares and printer.

## 7. How this connects to the mobile app

The companion **`paperless_mobile`** Expo app is the primary client of this
API:

- It calls this server's REST endpoints (`/workstations`, `/files`,
  `/prep-queue`, `/employees`, `/queue`) via Axios, pointed at
  `http://<dev-machine-ip>:5300` in dev or a fixed production host/port.
- It listens on the same Socket.IO server for `workstation-order-update`
  and `workstations-updated` to refresh workstation cards live instead of
  polling.
- Its **kiosk mode** posts to `/workstations/order-completion` and
  `/workstations/print-prep-label` for shop-floor order-completion and
  label-printing flows.
- Its document viewer/annotation screens read from `/files` and
  `/workstations/documents/:id/render`, and save annotated revisions via
  `/workstations/save-edited`.

See the [mobile repo's README](https://github.com/bourama1/paperless_mobile/blob/main/README.md) for the client-side
details. In short: **this backend is the single source of truth and event
bus; the mobile app is a thin, mostly stateless UI over it.**

## 8. Web frontend (optional)

The same `paperless_mobile` codebase can also run as a browser app, served
directly by this backend at the same origin/port — no separate web server,
port, or certificate. Intended for internal access over the company VPN,
not public exposure (see the caveats below).

**Build and deploy:**

```bash
# in the mobile project
npx expo export --platform web
# copy the resulting dist/ folder to wherever WEB_BUILD_PATH points, e.g.:
cp -r dist /path/to/backend/web-dist
```

Set `WEB_BUILD_PATH` in this project's `.env` (see `.env.example`) to that
folder's path, then restart the server. The console logs which mode it's
running in on startup (`[WEB] Serving web build from ...` vs
`[WEB] No web build found ... running API-only`). Leaving `WEB_BUILD_PATH`
unset, or pointing it somewhere that doesn't exist, disables the web
frontend entirely — the API keeps working exactly as before either way.

**How the routing works:** requests matching a real API prefix
(`/workstations`, `/queue`, `/files`, `/employees`, `/prep-queue`,
`/health` — see `middleware/webFrontend.ts`) go through the normal
`apiKeyAuth` + route handling, unchanged. Everything else is treated as a
page request: a real static file (JS bundle, fonts, images) is served
directly if it exists, and any other GET falls back to the same
`index.html` shell so expo-router's client-side routing resolves correctly
on a fresh load or page refresh (e.g. `/document/123`). This part is
deliberately public — a plain browser navigation can't attach a custom
`X-API-Key` header — but the actual data the page fetches afterward goes
through the normal authenticated API calls, same as the native app.

**Two things worth knowing before relying on this:**

- **The API key ships inside the page's JS bundle.** `EXPO_PUBLIC_API_KEY`
  gets inlined into client-side JS for web the same way it's baked into the
  native app binary — except a browser makes it trivially visible via
  "View Source" or dev tools, unlike a compiled app most people never
  inspect. Fine for access gated behind your VPN; not something to expose
  further without adding a real login layer in front of it.
- **The self-signed TLS certificate isn't trusted by browsers.** The
  Android app trusts it via the bundled network security config plugin
  (see the mobile project's `plugins/withBackendCertPinning.js`) — that
  mechanism is Android-specific and doesn't apply to a browser. Anyone
  hitting this over HTTPS in a browser will get a "not secure" warning
  unless `server.crt` (see this backend's TLS setup) is also installed as a
  trusted certificate on their machine — on Windows, double-click the
  `.crt` file → "Install Certificate" → Local Machine → Trusted Root
  Certification Authorities. Worth pushing via Group Policy if there's an
  Active Directory domain, rather than doing it by hand per laptop.

## 9. HTTPS through IIS (certificate with a non-exportable key)

The backend can serve HTTPS itself (`SSL_PFX_PATH`), but that needs the
certificate's private key as a `.pfx`. When the server's certificate
(Sectigo, `tocz-app4.toors.cz`) sits in the Windows store with a
**non-exportable** key, let IIS terminate HTTPS instead — IIS uses the key
straight from the store — and forward to the backend on localhost.
Clients keep the same address: `https://tocz-app4.toors.cz:5300`.

1. **IIS** — Server Manager → Add Roles and Features → *Web Server (IIS)*,
   including *Application Development → WebSocket Protocol*.
2. Install Microsoft's **URL Rewrite 2.1** and **Application Request
   Routing 3.0**.
3. IIS Manager → server node → *Application Request Routing Cache* →
   *Server Proxy Settings* → tick **Enable proxy** (leave "Preserve client
   IP in X-Forwarded-For" on) → Apply.
4. Create a folder, e.g. `C:\inetpub\paperless-proxy`, and copy
   [`iis/web.config`](iis/web.config) into it.
5. IIS Manager → Sites → *Add Website*: name `paperless`, physical path
   that folder, binding **https**, port **5300**, host name
   `tocz-app4.toors.cz`, SSL certificate: the Sectigo one.
6. Backend `.env`, then restart the backend:
   ```
   PORT=5301
   HOST=127.0.0.1
   TRUST_PROXY=true
   SSL_PFX_PATH=
   ```
   (`HOST=127.0.0.1` keeps the plain-HTTP port unreachable from the LAN;
   `TRUST_PROXY` makes per-device logic like the QC PIN lockout see the
   tablet's real IP instead of IIS's.)
7. Check `https://tocz-app4.toors.cz:5300/health` from another PC — padlock,
   no warning.

Then switch every client at once — plain HTTP on 5300 is gone: the
external production system's webhook
(`https://tocz-app4.toors.cz:5300/workstations/order-update`), the tablets
(APK built with `EXPO_PUBLIC_BACKEND_USE_HTTPS=true`), and browsers (open
the hostname, not the IP — the certificate is for the name). When the
certificate is renewed in the Windows store, re-select it in the site's
https binding; nothing on the backend side changes.
