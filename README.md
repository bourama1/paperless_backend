# Hardware Label Printing Automation

This replaces the manual `hardware.xlsm` Excel + barcode scanner workflow with
an automated pipeline driven by the production system's `/order-update` API
calls. When a garage door finishes a production cycle at the **Hardware**
workplace, the backend automatically prints all the correct labels and QR
stickers for that specific door — no scanning, no Excel, no manual lookup.

---

## 1. How it works

```
Production system
      │
      │  POST /order-update  { order, action, cycleIndex, totalCycles }
      ▼
handleOrderUpdate()                    (workstationService.ts)
      │
      ├─► logs to workstation_log
      │
      └─► handleLabelPrinting()        (labelPrintingService.ts)
              │
              ├─ 1. Reads CSV:  \\TOCZ-FS2\510-TOCZ\...\Štítky\{salesOrder} {pos}0.csv
              ├─ 2. Filters rows to this cycle (door) only
              ├─ 3. Generates EZPL for each row (label type → template/copies/cycleFilter)
              ├─ 4. Sends EZPL to Godex EZ2250i via UNC copy (\\tocz2420311\GodexEZ2250i)
              ├─ 5. Logs each print to label_print_log (duplicate guard)
              └─ 6. On the LAST cycle only: prints QR install-guide sticker
                    (reads TMP*.TXT, maps rail type → PNG, prints via PowerShell)
```

Each door in a multi-door order (e.g. 20 garage doors on one position) is a
separate API call with its own `cycleIndex`/`totalCycles`. The backend prints
only what belongs to that specific door, at the moment it's produced —
exactly mirroring what the Excel macro did per barcode scan, just without a
human doing the scanning.

---

## 2. What's already done

- [x] CSV file discovery and parsing (verified against real CSV samples)
- [x] Label type → template / copy count / cycle-filter config (read directly
      from the real `parametry` sheet in `hardware.xlsm`)
- [x] EZPL label generation (verified against a real captured `.prn` output)
- [x] Cycle/door filtering logic (`packageType` door number + `cycleFilter`)
- [x] Duplicate-print guard (`label_print_log` table)
- [x] Country code resolution (`DE|Germany` → `DE`, with JSON fallback file)
- [x] Windows-native printing (`copy /b file.prn \\tocz2420311\GodexEZ2250i`)
- [x] QR sticker logic ported from VBA (`TiskQRKodu`)
- [x] Full migration to PostgreSQL (Knex query builder everywhere, no more
      raw SQLite calls anywhere in the codebase)
- [x] `section` copies = 4 **confirmed correct** by you

---

## 3. TODO before going live

### 3.1 Infrastructure / access (must-do, blocks everything)

- [ ] Confirm the Windows Server this runs on can reach:
  - [ ] `\\TOCZ-FS2\510-TOCZ\300 Departments\999 Common\01-FFS-Test\Štítky` (CSV files)
  - [ ] `\\TOCZ-FS2\510-TOCZ\300 Departments\300 Technical Services\Dokumentace B\NACTENO` (TMP files)
  - [ ] `\\tocz2420311\GodexEZ2250i` (printer share)
- [ ] Confirm the Windows account running the Node process has read access to
      the above shares (same access the Excel user account already has)
- [ ] Create the PostgreSQL database and confirm connection:

  ```bash
  createdb paperless
  ```

- [ ] Set every value in `.env` — see section 5 below for the full list and
      what each one needs to point to

### 3.2 Content that must be supplied by you

- [ ] **QR PNG images** — place all 18 rail-type PNGs (`Indy_SL.png`,
      `Guardy_SL.png`, `GTR_HL.png`, etc. — see `QR_CODE_MAP` in
      `labelPrintingService.ts` for the full list of expected filenames) in
      the folder pointed to by `LABEL_QR_IMAGES_PATH`
- [ ] **Country code additions** — `config/country-codes.json` has ~70
      countries pre-filled from your list; add any new ones as they appear
      in production (the server logs a warning naming the exact unknown value)

### 3.3 Verification still needed (known unknowns)

These were built from reading the VBA macro and the `parametry` sheet, but
have **not yet been checked against real printed output**:

- [ ] **`aktualniCMDinter` template layout** (used for all `*_hw_kr` label
      types) — we only ever captured real `.prn` output for `aktualniCMD`.
      The `hw_kr` layout currently reuses the same field-generation code,
      which is a reasonable guess but unverified. Recommend capturing a real
      `.prn` for a `hw_kr` label the same way we did for `aktualniCMD` (open
      Excel, fill dummy data, Save As → Text Printer format) and comparing.
- [ ] **QR sticker logic end-to-end** — the `TMP*.TXT` file parsing
      (`parseTmpFile`), the `6210610` rail-type lookup, and the
      `PocetVrat`/`CenovaSkupina` extraction were all inferred from the VBA
      code, never tested against a real TMP file. Get one real `TMP*.TXT`
      sample and verify the parser extracts the right rail type and door
      count.
- [ ] **`t29_*` special case** — the original macro updates a separate
      `Databaze.xlsx` file on the network share for `t29_*` label types.
      This is **not implemented** at all currently. Confirm whether this
      still matters for your product line, and if so, what that Databaze
      file's structure looks like.

---

## 4. Testing checklist

### 4.1 Dry-run testing (no printer/PNG paths configured)

With `LABEL_PRINTER_UNC_PATH`, `LABEL_PRINTER_HOST`, and `LABEL_QR_IMAGES_PATH`
all left blank, the service logs everything it *would* print instead of
actually printing. Do this first, always.

- [ ] Send a real `/order-update` payload (STARTED, `cycleIndex: 1`,
      `totalCycles: 1`) for a simple single-door order and confirm the
      `[LABELS] [DRY RUN]` log lines match what Excel would have printed for
      that position
- [ ] Send a real payload for a **multi-door** order (`totalCycles > 1`) and
      confirm:
  - [ ] Cycle 1 only prints door-1 rows (correct `packageType` filtering)
  - [ ] `cycleFilter: 'first'` types (e.g. `motor`) only appear on cycle 1
  - [ ] `cycleFilter: 'last'` types (e.g. `moutings`, `*_hw_kr`) only appear
        on the final cycle
  - [ ] `section` prints with 4 copies logged per row
- [ ] Send the **same** payload twice and confirm the second run logs
      `SKIP already printed` for every row (duplicate guard working)
- [ ] Check the `[QR]` log output only fires when `cycleIndex === totalCycles`

### 4.2 Manual connectivity testing (before wiring up the full flow)

- [ ] From the Windows Server, manually test the printer share:

  ```cmd
  echo test > test.prn
  copy /b test.prn \\tocz2420311\GodexEZ2250i
  ```

- [ ] Manually browse to the CSV share and TMP files share in File Explorer
      to confirm read access
- [ ] Manually print one QR PNG via PowerShell to confirm the default
      printer picks it up correctly:

  ```powershell
  Start-Process -FilePath "C:\path\to\Guardy_SL.png" -Verb Print
  ```

### 4.3 Live testing (printer configured, real labels coming out)

- [ ] Pick **one low-stakes real order** and run it through the full
      pipeline with the printer configured
- [ ] Physically compare the printed label side-by-side against what Excel
      would have printed for the same barcode/CSV row — check:
  - [ ] Barcode positions and readability
  - [ ] Sales order / position numbers
  - [ ] Customer name/address text placement and truncation
      (long names split across two lines — check the split point looks right)
  - [ ] Country code
  - [ ] Package part / package type text
- [ ] Test a multi-door order start to finish and confirm each door's
      labels physically print at the right moment (i.e. cycle 3 of 5
      doesn't accidentally print door 5's labels early)
- [ ] Test the QR sticker prints the correct number of copies
      (`PocetVrat`) and the correct image for at least 2-3 different rail
      types

### 4.4 Failure/edge case testing

- [ ] CSV file missing (position not yet exported) — confirm it logs an
      error and doesn't crash the request
- [ ] Unknown `deliveryCountry` value — confirm it logs the warning with
      the exact value so you know what to add to `country-codes.json`
- [ ] Unknown rail type in TMP file — confirm QR sticker step logs a
      warning and skips gracefully instead of crashing
- [ ] Price group `C01` — confirm QR sticker is correctly skipped

---

## 5. Full `.env` reference

```env
PORT=5300
STORAGE_PATH=./storage

# ── PostgreSQL ────────────────────────────────────────────────────────────────
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=paperless
PG_USER=postgres
PG_PASSWORD=changeme

# ── Workstation polling / doc manager (pre-existing, unrelated to labels) ────
WORKSTATIONS_API_URL=http://10.110.60.21:40000/api/p2l/services/workstations_process
WORKSTATIONS_POLL_INTERVAL=15000
DOC_MANAGER_URL=http://tocz-app4:5200
EDITED_PDF_PATH=//tocz-app4/DOCS/PDF_output/Production_BOM/Hardware

# ── Label printing ────────────────────────────────────────────────────────────

# STARTED or FINISHED — which action triggers label printing
LABEL_PRINT_TRIGGER=STARTED

# UNC path to the Štítky folder (CSV source files)
LABEL_CSV_BASE_PATH=\\TOCZ-FS2\510-TOCZ\300 Departments\999 Common\01-FFS-Test\Štítky

# Printer connection — UNC method (matches Excel exactly)
LABEL_PRINTER_UNC_PATH=\\tocz2420311\GodexEZ2250i

# Printer connection — TCP fallback (only used if UNC path above is empty)
LABEL_PRINTER_HOST=
LABEL_PRINTER_PORT=9100

# Optional override of copy count for ALL label types
# LABEL_PRINTER_COPIES=1

# ── QR sticker printing ───────────────────────────────────────────────────────
LABEL_TMP_FILES_PATH=\\TOCZ-FS2\510-TOCZ\300 Departments\300 Technical Services\Dokumentace B\NACTENO
LABEL_COUNTRY_CODES_PATH=            # defaults to config/country-codes.json
LABEL_QR_IMAGES_PATH=                # folder with Indy_SL.png, Guardy_SL.png, etc.
LABEL_QR_PRINTER=                    # Windows default printer used if blank
```

---

## 6. Key files

| File                                   | Purpose                                           |
| -------------------------------------- | ------------------------------------------------- |
| `src/services/labelPrintingService.ts` | All label + QR sticker printing logic             |
| `src/services/workstationService.ts`   | Receives `/order-update`, triggers label printing |
| `src/config/database.ts`               | PostgreSQL/Knex connection + schema setup         |
| `config/country-codes.json`            | Country name → 2-letter code fallback mapping     |

---

## 7. Known limitations (by design, not bugs)

- QR sticker printing on Windows always uses the **system default printer**
  — there's no way to target a specific printer per print job through the
  `Start-Process -Verb Print` mechanism. If QR stickers need a different
  printer than labels, set that printer as the Windows default, or this
  needs a proper native print API implementation later.
- `LABEL_PRINTER_COPIES` (if set) overrides copy counts for **every** label
  type — it's meant for testing only, not production use.
