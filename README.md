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
      └─► handleLabelPrinting()        (labelPrintingService.ts)
              │
              ├─ 1. Maps order.workplace → scan prefix via WORKPLACE_TO_SCAN_PREFIX
              │     (gate-level → "K"žSVK", hardware/motor → "K"žSV"", rail → "K"žSVV")
              ├─ 2. Matches scan prefix against parametry config (scanC column)
              │     → builds Map<type, {copies, cycleFilter}> of ALL matching types
              ├─ 3. Filters CSV rows to types present in parametry match map
              ├─ 4. Applies cycle filter per type (first/last/all) using real
              │     cycleIndex/totalCycles (not barcode last-digit heuristic)
              ├─ 5. Generates EZPL for each row × copies (correct template per type)
              ├─ 6. Copies raw EZPL bytes to printer via UNC share
              │     (copy /b file.prn \\tocz2420311\GodezEZ2250i — same as Excel)
              ├─ 7. Logs each print to label_print_log (duplicate guard)
              └─ 8. On the LAST cycle only: prints QR install-guide sticker
                    (reads TMP*.TXT, maps rail type → PNG, prints via PowerShell)
```

Each door in a multi-door order is a separate API call with its own
`cycleIndex`/`totalCycles`. The backend prints only what belongs to that
specific cycle — exactly mirroring what the Excel macro did per barcode scan.

---

## 2. What's already done

- [x] CSV file reading from the production network share (UNC path in `.env`)
- [x] **Workplace → scan-prefix mapping** — `WORKPLACE_TO_SCAN_PREFIX` maps
      workplace names (gate-level, hardware/motor, rail) to the correct scan
      prefix; `resolveScanPrefix()` derives the prefix for parametry matching
      from the order's workplace, not from a scanned barcode
- [x] **Per-row parametry matching** — for a given scan prefix, builds a
      `Map<type, {copies, cycleFilter}>` from ALL parametry entries whose
      `scanC` matches the prefix; filters CSV rows to only the matching types
      (confirmed identical to VBA behavior)
- [x] **Cycle filter** — uses real `cycleIndex`/`totalCycles` from the
      `/order-update` payload (not barcode last-digit heuristic); maps
      parametry `K` column ("0" → "last", "1" → "first", empty → "all")
- [x] **Template selection** — `resolveConfig()` selects `aktualniCMDinter`
      template for `*_hw_kr` and `t10_struct` types, `aktualniCMD` for all
      others (confirmed identical to VBA `hlavni()`)
- [x] **EZPL generation** — `generateSimpleBlock()` for `aktualniCMDinter`
      template (sheet7 rows 1–42) and `generatePrimaryBlock()` for
      `aktualniCMD` (sheet6 rows 1–47/86), both verified byte-identical
      against real Excel `.prn` output
- [x] **No door number filtering** — removed because VBA does NOT filter by
      door number (the `V - 1/2` column); all matching CSV rows for a cycle
      print regardless of door
- [x] Country code resolution (`DE|Germany` → `DE`, with JSON fallback file)
- [x] Windows-native printing via UNC (`copy /b file.prn \\share` — identical to
      Excel's `posliTisk()`), with fallback to TCP raw socket or default printer
- [x] QR sticker logic ported from VBA (`TiskQRKodu`)
- [x] Full migration to PostgreSQL (Knex query builder everywhere)
- [x] **45 config entries** in `label-type-config.json` (columns A–K from
      `parametry` sheet)
- [x] **OUTSIDE EU block** — `generateOutsideEuBlock()` and `needsOutsideEuLabel()`;
      when `countryAddress` starts with a non-EU 2-letter code + space, the VBA
      copies rows 48–86 (OUTSIDE EU template) after the full label. The backend
      now concatenates both blocks in `generateEzpl()`.
- [x] **10/10 tests pass byte-identical** — all 10 test barcodes produce
      byte-identical `.prn` output (after LF normalization) compared to VBA.
      The barcodes cover EU and non-EU addresses, single/multi-label, and
      various label types.

### Byte-identical verification

All 10 test barcodes in `test-fixtures/test-cases.json` produce **byte-identical**
`.prn` output (after LF normalization) against the VBA macro. The only
difference is LF (backend) vs CRLF (VBA) line endings, which the printer
treats identically.

To run the comparison:

```bash
scripts\run-test.bat -KeepFiles
```

Output lands in `test-fixtures/output/{barcode}_backend.prn` and
`{barcode}_excel.prn` for manual inspection or visualization.

---

## 3. Test scripts

### `scripts/test-label-preview.ts` (recommended)

Dry-run that shows exactly what would print — read the output, don't guess.

```bash
npx ts-node scripts/test-label-preview.ts
```

Reads barcodes from `test-fixtures/test-cases.json`, auto-derives sales
order/position/cycle index, and prints a detailed per-type/per-cycle
breakdown:

```
Parametry shoda: 20 typů
Shodné CSV řádky: 6
  t25_hw_kr    4 řádků × 1 kopií =  4 labelů  (cycleFilter=last)
  motor        2 řádků × 1 kopií =  2 labelů  (cycleFilter=first)

─── Cyklus 2/2 ───
t25_hw_kr    aktualniCMDinter  4 řádků × 1x = 4 labelů
  · K - 1/2  V - 1/2  PACHEINER
  · K - 2/2  V - 1/2  PACHEINER
  · K - 1/2  V - 2/2  PACHEINER
  · K - 2/2  V - 2/2  PACHEINER
CELKEM: 4 labelů

─── Přehled všech cyklů ───
Cyklus 1/2: 2 labelů (motor)
Cyklus 2/2: 4 labelů (t25_hw_kr)
Celkem: 6 labelů
```

### `scripts/generate-full-prn.ts`

Generates a complete `.prn` file (all cycles, all copies) for verification:

```bash
npx ts-node scripts/generate-full-prn.ts
```

Output goes to `test-fixtures/output/{salesOrder}_full.prn`.

### `scripts/Compare-VbaAndBackend.ps1`

Runs the VBA macro from `hardware_test.xlsm` AND the backend on the same
barcode, then byte-compares the `.prn` output:

```bash
# All test barcodes (output files kept)
.\scripts\Compare-VbaAndBackend.ps1 -KeepFiles

# Single barcode
.\scripts\Compare-VbaAndBackend.ps1 -Barcode 'K"žSV" 603684 010' -KeepFiles
```

Output files are saved to `test-fixtures/output/{barcode}_excel.prn` and
`{barcode}_backend.prn` for manual inspection.

### `scripts/run-test.bat`

Thin wrapper around `Compare-VbaAndBackend.ps1` that forwards all arguments:

```bash
scripts\run-test.bat -KeepFiles
```

### `scripts/build-exe.bat`

Compiles TypeScript and bundles everything into a standalone `.exe` using
`@yao-pkg/pkg` (no Node.js required on the target server):

```bash
.\scripts\build-exe.bat
```

Output: `publish/paperless-backend.exe` (~127 MB) + `config/` + `.env.example`
        + `paperless-backend.zip` with all of the above for easy deployment

### Adding test barcodes

Just add the full barcode string to `test-fixtures/test-cases.json`:

```json
[
  "K\"žSV\" 603684 010",
  "K\"žSV\" 603684 011",
  "K\"žSVV 234267 010"
]
```

The scripts auto-parse `salesOrder`, `position`, and `lastDigit`
(→ `cycleIndex` = last digit "0" → last cycle, "1" → first cycle).

### CSV test fixtures

Reads CSV from the **production network share** defined in `.env`. No local
copies needed. If the share is unreachable, the error message tells you what
to do.

---

## 4. TODO before going live

### 4.1 Infrastructure / access (must-do, blocks everything)

- [ ] Confirm the Windows Server this runs on can reach:
  - [ ] `\\TOCZ-FS2\...\Štítky` (CSV files — already confirmed by test scripts)
  - [ ] `\\TOCZ-FS2\...\NACTENO` (TMP files)
  - [ ] `\\tocz2420311\GodezEZ2250i` (printer share)
- [ ] Confirm the Windows account running the process has read access to
      the above shares
- [ ] Create the PostgreSQL database and confirm connection:

  ```bash
  createdb paperless
  ```

- [ ] Set every value in `.env` — see section 6 below for the full list

### 4.2 Content that must be supplied by you

- [ ] **QR PNG images** — place all 18 rail-type PNGs (`Indy_SL.png`,
      `Guardy_SL.png`, `GTR_HL.png`, etc. — see `QR_CODE_MAP` in
      `labelPrintingService.ts` for the full list) in the folder pointed
      to by `LABEL_QR_IMAGES_PATH`
- [ ] **Country code additions** — `config/country-codes.json` has ~70
      countries pre-filled; add any new ones that appear in production

### 4.3 Verification still needed

- [ ] **Workplace mapping for all production workplaces** — verify the
      `WORKPLACE_TO_SCAN_PREFIX` mapping covers every workplace name that
      the production system sends. Add any missing entries.
- [ ] **Multi-cycle orders with mixed cycleFilters** — confirm types with
      `cycleFilter=first` only appear on cycle 1, `cycleFilter=last` only on
      the final cycle, and `cycleFilter=all` on every cycle (uses real
      `cycleIndex`/`totalCycles` from the API payload)
- [ ] **QR sticker logic end-to-end** — the `TMP*.TXT` file parsing, rail
      type lookup, and `PocetVrat`/`CenovaSkupina` extraction were inferred
      from VBA code but never tested against a real TMP file
- [ ] **`t29_*` Databaze.xlsx** — the original VBA writes to a separate
      `Databaze.xlsx` on the network share for `t29_*` types. This is **not
      implemented**. Confirm if still needed and what the file structure is

### 4.4 Live testing checklist

- [ ] Pick **one real order** and run through the full pipeline with printer
- [ ] Physically compare printed label against what Excel would print:
  - [ ] Barcode position and readability
  - [ ] Sales order / position numbers
  - [ ] Customer name text placement and truncation
  - [ ] Country code
  - [ ] Package part / type text
- [ ] Test a **multi-door order** start to finish — confirm labels for the
      correct door print at the correct cycle
- [ ] Test the QR sticker prints the correct image and `PocetVrat` copies
- [ ] Test failure modes: missing CSV, unknown country, unknown rail type

---

## 5. VBA behaviour reference

Key findings from reverse-engineering `hardware.xlsm` `hlavni()`:

| Behaviour              | How VBA does it                                                                                                                               | How backend does it                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| CSV import             | Merge A–E into A, then TextToColumns with `;` → net effect: columns stay split                                                                | Direct semicolon split                                                                                          |
| Parametry matching     | Iterate parametry, if `scanB`/`scanC` matches barcode prefix, get `type` + `copies` + `lastCycleNum`                                          | Resolve scan prefix from workplace mapping, then match `scanC` only → build `Map<type, {copies, cycleFilter}>`  |
| Cycle filter           | `Right(barcode, 1)` vs `lastCycleNum` ("0" last, "1" first, "" always)                                                                        | Real `cycleIndex`/`totalCycles` from API → `cycleFilterFromLastCycleNum()`                                      |
| Template choice        | `aktualniCMDinter` for `*_hw_kr`, `aktualniCMD` for everything else (in `hlavni()`, not `tisk()`)                                             | `resolveConfig()` selects same templates                                                                        |
| Door number filter     | **None** — `tisk()` prints ALL matching CSV rows regardless of door                                                                           | Door filtering removed                                                                                          |
| Secondary "OUTSIDE EU" | If `countryAddress` has 2-letter non-EU code + space at position 3, VBA copies A1:A86 (full + OUTSIDE EU block); otherwise A1:A47 (full only) | `needsOutsideEuLabel()` checks country code; `generateEzpl()` concatenates `generateOutsideEuBlock()` when true |
| Printer output         | `ActiveWorkbook.SaveAs xlTextPrinter` → `posliTisk()`                                                                                         | Raw EZPL bytes → UNC `copy /b` (primary), TCP raw socket (fallback), or default printer                         |
| Duplicate guard        | Check `Databaze` sheet; if already printed (`Hledej()` match) → skip                                                                          | `label_print_log` DB table                                                                                      |

---

## 6. Full `.env` reference

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

# (Obsolete — EZPL is generated directly, no .prn template files needed)
# LABEL_TEMPLATES_PATH=

# Printer connection — UNC method (identical to Excel: copy /b file.prn \\share)
LABEL_PRINTER_UNC_PATH=\\tocz2420311\GodezEZ2250i

# Printer connection — RAW TCP fallback (only used if UNC path is empty)
LABEL_PRINTER_HOST=
LABEL_PRINTER_PORT=9100

# Optional override of copy count for ALL label types
# LABEL_PRINTER_COPIES=1

# ── QR sticker printing ───────────────────────────────────────────────────────
LABEL_TMP_FILES_PATH=\\TOCZ-FS2\510-TOCZ\300 Departments\300 Technical Services\Dokumentace B\NACTENO
LABEL_COUNTRY_CODES_PATH=            # defaults to config/country-codes.json next to the .exe
LABEL_QR_IMAGES_PATH=                # folder with Indy_SL.png, Guardy_SL.png, etc. (empty = dry-run)
LABEL_QR_PRINTER=                    # IP address (raw TCP 9100), Windows printer name, or empty = default printer via Start-Process
```

---

## 7. Key files

| File                                   | Purpose                                                         |
| -------------------------------------- | --------------------------------------------------------------- |
| `src/services/labelPrintingService.ts` | All label + QR sticker printing logic (~1090 lines)             |
| `src/services/workstationService.ts`   | Receives `/order-update`, triggers label printing               |
| `src/config/database.ts`               | PostgreSQL/Knex connection + schema setup                       |
| `config/label-type-config.json`        | 45 parametry entries (columns A–K from `parametry` sheet)       |
| `config/country-codes.json`            | Country name → 2-letter code fallback mapping                   |
| `scripts/test-label-preview.ts`        | Dry-run test with per-type/per-cycle breakdown                  |
| `scripts/generate-full-prn.ts`         | Generate complete .prn files for all test cases                 |
| `scripts/Compare-VbaAndBackend.ps1`    | VBA vs backend byte-comparison for all test barcodes            |
| `scripts/build-exe.bat`                | Compile TS + package into standalone paperless-backend.exe      |
| `scripts/run-test.bat`                 | Thin wrapper around Compare-VbaAndBackend.ps1                   |
| `test-fixtures/test-cases.json`        | Barcode list for test scripts (just add barcodes)               |
| `test-fixtures/output/`                | Generated .prn files land here (`*_backend.prn`, `*_excel.prn`) |
| `hardware_test.xlsm`                   | Modified Excel with VBA macro (for VBA reference testing)       |

---

## 8. Known limitations (by design, not bugs)

- `LABEL_PRINTER_COPIES` (if set) overrides copy counts for **every** label
  type — it's meant for testing only, not production use.
- VBA `posliTisk()` fails when called headless via COM (no Excel UI). The
  backend's UNC `copy /b` approach does not have this limitation.
