import knex, { Knex } from "knex";

let db: Knex | null = null;
let initPromise: Promise<Knex> | null = null;

// ─── Masterplan DB (read-only, no schema setup needed) ────────────────────────
// Same server as the main paperless DB; only the database name differs.
// The Masterplan database is external — we never create or migrate tables in
// it, so getMasterplanDb() just creates a connection and returns it, with no
// setupDatabase() equivalent.
let masterplanDb: Knex | null = null;
let masterplanInitPromise: Promise<Knex> | null = null;

export const getMasterplanDb = async (): Promise<Knex> => {
    if (masterplanDb) return masterplanDb;
    if (!masterplanInitPromise) {
        masterplanInitPromise = (async () => {
            const dbName = process.env.MASTERPLAN_DB_NAME;
            if (!dbName) {
                throw new Error(
                    "[MASTERPLAN] MASTERPLAN_DB_NAME is not set — cannot connect to the Masterplan database. " +
                        "Set it in .env to the name of the Masterplan PostgreSQL database on the same server.",
                );
            }
            const instance = knex({
                client: "pg",
                connection: {
                    host: process.env.PG_HOST || "localhost",
                    port: parseInt(process.env.PG_PORT || "5432", 10),
                    database: dbName,
                    user: process.env.PG_USER || "postgres",
                    password: process.env.PG_PASSWORD || "",
                },
                pool: { min: 0, max: 5 },
            });
            // Verify connectivity immediately rather than failing silently on
            // the first real query. If the DB is unreachable we log a clear
            // warning but don't crash the server — lock checks will just
            // default to unlocked (fail open) until it becomes reachable.
            try {
                await instance.raw("SELECT 1");
                console.log(
                    `[MASTERPLAN] Connected to Masterplan database "${dbName}" on ${process.env.PG_HOST || "localhost"}`,
                );
            } catch (err: any) {
                console.error(
                    `[MASTERPLAN] Could not connect to Masterplan database "${dbName}": ${err.message}. ` +
                        "Lock checks will default to unlocked until the connection is restored.",
                );
            }
            masterplanDb = instance;
            return instance;
        })();
    }
    return masterplanInitPromise;
};

// ─── Norms DB (read-only, same server) ───────────────────────────────────────
// Used to look up production order numbers (vyr_obj) for prep labels.
// Query path: txtfiles (zakazka + prodejni_objednavka + pozice → id)
//           → konfiguratory (id_txtfile → vyr_obj)
let normsDb: Knex | null = null;
let normsInitPromise: Promise<Knex> | null = null;

export const getNormsDb = async (): Promise<Knex> => {
    if (normsDb) return normsDb;
    if (!normsInitPromise) {
        normsInitPromise = (async () => {
            const dbName = process.env.NORMS_DB_NAME;
            if (!dbName) {
                throw new Error(
                    "[NORMS] NORMS_DB_NAME is not set — cannot look up production order numbers. " +
                        "Set it in .env to the name of the Norms PostgreSQL database on the same server.",
                );
            }
            const instance = knex({
                client: "pg",
                connection: {
                    host: process.env.PG_HOST || "localhost",
                    port: parseInt(process.env.PG_PORT || "5432", 10),
                    database: dbName,
                    user: process.env.PG_USER || "postgres",
                    password: process.env.PG_PASSWORD || "",
                },
                pool: { min: 0, max: 5 },
            });
            try {
                await instance.raw("SELECT 1");
                console.log(
                    `[NORMS] Connected to Norms database "${dbName}" on ${process.env.PG_HOST || "localhost"}`,
                );
            } catch (err: any) {
                console.error(
                    `[NORMS] Could not connect to Norms database "${dbName}": ${err.message}. ` +
                        "Production order numbers will be omitted from prep labels until the connection is restored.",
                );
            }
            normsDb = instance;
            return instance;
        })();
    }
    return normsInitPromise;
};

export async function insertGetId<T extends Record<string, any>>(
    targetDb: Knex,
    table: string,
    data: T,
    idColumn: keyof T & string = "id" as any,
): Promise<number> {
    const result = await targetDb(table).insert(data).returning(idColumn);
    const row = result[0];
    if (typeof row === "number") return row;
    if (row && typeof row === "object" && idColumn in row)
        return Number(row[idColumn]);
    throw new Error(`insertGetId: could not determine ${String(idColumn)}`);
}

export const getDb = async () => {
    if (db) return db;

    // Multiple callers can race to initialize on startup (index.ts's
    // initDb() plus pollWorkstations/runArchivalSweep/checkForNewPlan all
    // call getDb() independently from the listen() callback). Without this
    // guard, a second caller could see `db` truthy the instant `knex(...)`
    // is constructed below — before setupDatabase() has actually finished
    // creating tables — and start querying tables that don't exist yet.
    // Sharing one in-flight init promise means every concurrent caller
    // waits for the SAME full setup instead of racing ahead of it.
    if (!initPromise) {
        initPromise = (async () => {
            const instance = knex({
                client: "pg",
                connection: {
                    host: process.env.PG_HOST || "localhost",
                    port: parseInt(process.env.PG_PORT || "5432", 10),
                    database: process.env.PG_DATABASE || "paperless",
                    user: process.env.PG_USER || "postgres",
                    password: process.env.PG_PASSWORD || "",
                },
                pool: { min: 0, max: 10 },
            });
            await setupDatabase(instance);
            db = instance;
            return instance;
        })();
    }

    return initPromise;
};

const setupDatabase = async (targetDb: Knex) => {
    // 1. documents table
    if (!(await targetDb.schema.hasTable("documents"))) {
        await targetDb.schema.createTable("documents", (table) => {
            table.increments("id").primary();
            table.string("name").notNullable();
            table.string("project_number");
            table.string("position");
            table.integer("document_type");
            table.timestamp("created_at").defaultTo(targetDb.fn.now());
            table.timestamp("updated_at").defaultTo(targetDb.fn.now());
        });
    }
    // Backfill for pre-existing installs where the table already existed
    // without these columns.
    if (!(await targetDb.schema.hasColumn("documents", "project_number"))) {
        await targetDb.schema.alterTable("documents", (table) => {
            table.string("project_number");
            table.string("position");
            table.integer("document_type");
        });
    }

    // 2. revisions table
    if (!(await targetDb.schema.hasTable("revisions"))) {
        await targetDb.schema.createTable("revisions", (table) => {
            table.increments("id").primary();
            table
                .integer("document_id")
                .notNullable()
                .references("id")
                .inTable("documents");
            table.string("filename").notNullable();
            table.integer("version").defaultTo(1);
            table.text("annotations");
            table.timestamp("created_at").defaultTo(targetDb.fn.now());
        });
    }

    // 3. workstations table
    if (!(await targetDb.schema.hasTable("workstations"))) {
        await targetDb.schema.createTable("workstations", (table) => {
            table.increments("id").primary();
            table.string("name").notNullable().unique();
            table.string("current_order_id");
            table.text("current_order_data");
            table.integer("is_active").defaultTo(1);
            table.timestamp("last_polled_at");
            table.integer("cycle_index").defaultTo(1);
            table.integer("total_cycles").defaultTo(1);
        });
    }
    // Backfill for pre-existing installs where "workstations" already
    // existed before cycle_index/total_cycles were added to the schema —
    // otherwise handleOrderUpdate's UPDATE against these columns fails with
    // "column does not exist" on every order-update call.
    if (!(await targetDb.schema.hasColumn("workstations", "cycle_index"))) {
        await targetDb.schema.alterTable("workstations", (table) => {
            table.integer("cycle_index").defaultTo(1);
            table.integer("total_cycles").defaultTo(1);
        });
    }

    // 3b. order_cycle_state table — authoritative cycle_index/total_cycles
    // per order, keyed by order_id. Written unconditionally on every
    // order-update (see handleOrderUpdate), independent of whether the
    // separately-polled `workstations` table has caught up to this order
    // yet. Previously cycle_index/total_cycles were only written by
    // matching workstations.current_order_id — which is populated on its
    // own timer by pollWorkstations() — so a webhook arriving before the
    // next poll would silently fail to update anything (0 rows matched),
    // leaving stale values from whatever order previously occupied that
    // station row. Reading cycle progress from here instead removes that
    // race entirely.
    if (!(await targetDb.schema.hasTable("order_cycle_state"))) {
        await targetDb.schema.createTable("order_cycle_state", (table) => {
            table.string("order_id").primary();
            table.integer("cycle_index").notNullable().defaultTo(1);
            table.integer("total_cycles").notNullable().defaultTo(1);
            table.timestamp("updated_at").defaultTo(targetDb.fn.now());
        });
    }

    // 4. workstation_log table
    if (!(await targetDb.schema.hasTable("workstation_log"))) {
        await targetDb.schema.createTable("workstation_log", (table) => {
            table.increments("id").primary();
            table.string("workstation_name").notNullable();
            table.string("order_id").notNullable();
            table.string("action").notNullable();
            table.text("order_snapshot");
            table.integer("cycle_index").defaultTo(1);
            table.integer("total_cycles").defaultTo(1);
            table.timestamp("created_at").defaultTo(targetDb.fn.now());
        });
    }

    // 5. label_print_log table
    if (!(await targetDb.schema.hasTable("label_print_log"))) {
        await targetDb.schema.createTable("label_print_log", (table) => {
            table.increments("id").primary();
            table.string("order_id").notNullable();
            table.string("sales_order").notNullable();
            table.string("position").notNullable();
            table.string("label_type").notNullable();
            table.string("package_part").notNullable();
            table.string("package_type").notNullable();
            table.string("toors_barcode");
            table.integer("copies").notNullable().defaultTo(1);
            table.integer("cycle_index").notNullable().defaultTo(1);
            table.timestamp("printed_at").defaultTo(targetDb.fn.now());
        });
    }

    // 6. Migration from legacy 'queue' table
    const hasQueue = await targetDb.schema.hasTable("queue");
    if (hasQueue) {
        console.log("Migrating existing queue table to documents/revisions...");
        const rows = await targetDb("queue").select("*");
        for (const row of rows) {
            const docId = await insertGetId(targetDb, "documents", {
                name: row.filename,
                created_at: row.created_at,
                updated_at: row.updated_at,
            });
            await targetDb("revisions").insert({
                document_id: docId,
                filename: row.filename,
                version: row.version,
                created_at: row.created_at,
            });
        }
        await targetDb.schema.dropTable("queue");
        console.log("Migration complete.");
    }

    // 7. Ensure 'annotations' column exists in 'revisions'
    const hasAnnotations = await targetDb.schema.hasColumn(
        "revisions",
        "annotations",
    );
    if (!hasAnnotations) {
        console.log("Adding annotations column to revisions table...");
        await targetDb.schema.alterTable("revisions", (table) => {
            table.text("annotations");
        });
        console.log("Column added.");
    }

    // 8. Ensure 'cycle_index' column exists on 'label_print_log'
    const hasCycleIndex = await targetDb.schema.hasColumn(
        "label_print_log",
        "cycle_index",
    );
    if (!hasCycleIndex) {
        console.log("Adding cycle_index column to label_print_log table...");
        await targetDb.schema.alterTable("label_print_log", (table) => {
            table.integer("cycle_index").notNullable().defaultTo(1);
        });
        console.log("Column added.");
    }

    // 9. order_archive_log table — tracks FINISHED orders so the retention
    // archival sweep (services/archivalService.ts) knows what's due to be
    // fetched from doc_manager, converted to PDF/A, and written to the
    // network archive share, and doesn't reprocess the same order twice.
    if (!(await targetDb.schema.hasTable("order_archive_log"))) {
        await targetDb.schema.createTable("order_archive_log", (table) => {
            table.increments("id").primary();
            table.string("order_id").notNullable().unique();
            table.string("project_number").notNullable();
            table.string("position").notNullable();
            table.string("sales_order");
            table.string("product_order");
            table.timestamp("finished_at").notNullable();
            table.timestamp("archived_at");
            table.integer("attempts").notNullable().defaultTo(0);
            table.text("last_error");
            table.timestamp("created_at").defaultTo(targetDb.fn.now());
        });
    }

    // 10. document_print_log table — tracks projectNumber/position combos
    // whose documents (PBOM, declarations, confirmations) have already been
    // printed, so printDocumentsForOrder only prints once per combo instead
    // of on every STARTED cycle. See workstationService.ts.
    if (!(await targetDb.schema.hasTable("document_print_log"))) {
        await targetDb.schema.createTable("document_print_log", (table) => {
            table.increments("id").primary();
            table.string("project_number").notNullable();
            table.string("position").notNullable();
            table.string("order_id");
            table.timestamp("printed_at").defaultTo(targetDb.fn.now());
            table.unique(["project_number", "position"]);
        });
    }

    // 11. employees table — names shown in the kiosk tablet's "who finished
    // this order" dropdown. See completionService.ts.
    if (!(await targetDb.schema.hasTable("employees"))) {
        await targetDb.schema.createTable("employees", (table) => {
            table.increments("id").primary();
            table.string("name").notNullable().unique();
            table.timestamp("created_at").defaultTo(targetDb.fn.now());
        });
    }

    // 12. order_completion_log table — one row per FINISHED cycle a kiosk
    // tablet operator confirmed: who finished it, and whether the order is
    // complete, missing a product (waiting), or being shipped incomplete.
    // See completionService.ts.
    if (!(await targetDb.schema.hasTable("order_completion_log"))) {
        await targetDb.schema.createTable("order_completion_log", (table) => {
            table.increments("id").primary();
            table.string("order_id").notNullable();
            table.string("workstation").notNullable();
            table.integer("cycle_index");
            table.integer("total_cycles");
            table.string("product_order");
            table.string("project_number");
            table.string("position");
            table.string("sales_order");
            table.string("employee_name").notNullable();
            table.string("status").notNullable(); // complete | missing_product | shipped_incomplete
            table.timestamp("created_at").defaultTo(targetDb.fn.now());
        });
    }

    // 13. order_preparation_log table — for the external-items prep station:
    // a worker searches for a Hardware order's document, physically
    // prepares items sourced outside P2L, then prints a short label for
    // that order/position. Records who did the preparing. See
    // completionService.ts / labelPrintingService.printPrepLabel.
    if (!(await targetDb.schema.hasTable("order_preparation_log"))) {
        await targetDb.schema.createTable("order_preparation_log", (table) => {
            table.increments("id").primary();
            table.string("project_number").notNullable();
            table.string("position").notNullable();
            table.string("employee_name").notNullable();
            table.timestamp("created_at").defaultTo(targetDb.fn.now());
        });
    }

    // A batch order prints one label per box/cycle (see buildPrepLabelPdf
    // and createPrepLabel) rather than one label for the whole
    // project/position — so preparation needs to be recorded per cycle too,
    // not just per project/position. Added via alterTable (not baked into
    // createTable above) so existing deployments pick this up without
    // losing prior rows. cycle_index/total_cycles default to 1 so old rows
    // (recorded before this column existed, when every order effectively
    // had a single implicit cycle) read back consistently.
    if (!(await targetDb.schema.hasColumn("order_preparation_log", "cycle_index"))) {
        await targetDb.schema.alterTable("order_preparation_log", (table) => {
            table.integer("cycle_index").notNullable().defaultTo(1);
            table.integer("total_cycles").notNullable().defaultTo(1);
        });
    }

    // 14. ptl_prep_queue table — a work queue of items sourced from the
    // daily productionPlanPTL.json drop (see services/ptlPlanService.ts),
    // for products that need to be physically prepared BEFORE they ever
    // reach P2L. One row per (project_number, position, workplace); rows
    // are upserted on each ingest so a still-pending item just gets its
    // quantity/date/etc refreshed rather than duplicated. "Done" isn't
    // tracked here at all — a row counts as done once a matching
    // order_preparation_log entry exists (see getPrepQueue), reusing the
    // exact same print-prep-label flow the document viewer already has.
    if (!(await targetDb.schema.hasTable("ptl_prep_queue"))) {
        await targetDb.schema.createTable("ptl_prep_queue", (table) => {
            table.increments("id").primary();
            table.string("workplace").notNullable();
            table.string("sales_order");
            table.string("project_number").notNullable();
            table.string("position").notNullable();
            table.integer("quantity").notNullable().defaultTo(1);
            table.integer("production_time");
            // Planned production date, parsed from the source file's
            // "DD.MM.YYYY" string into a real date so it can be filtered/
            // sorted properly.
            table.date("planned_date");
            table.string("plan_label");
            table.string("source_file");
            table.timestamp("created_at").defaultTo(targetDb.fn.now());
            table.timestamp("updated_at").defaultTo(targetDb.fn.now());
            table.unique(["project_number", "position", "workplace"]);
        });
    }

    // 14b. Hardware-specific columns on ptl_prep_queue — the production
    // order number and hardware family (e.g. "Indy"/"Guardy"), looked up
    // from the matching HISTORY\OK order JSON when a Hardware row is
    // ingested (see ptlPlanService.ingestPlanFile / hardwareOrderLookupService).
    // Null for non-Hardware rows, and for Hardware rows not produced/
    // archived yet — added via alterTable so existing deployments pick it
    // up without losing prior rows, same as order_preparation_log above.
    if (!(await targetDb.schema.hasColumn("ptl_prep_queue", "product_order"))) {
        await targetDb.schema.alterTable("ptl_prep_queue", (table) => {
            table.string("product_order");
            table.string("hardware_type");
        });
    }

    // 15. ptl_ingest_state table — a single row tracking the last
    // productionPlanPTL.json file that was actually ingested, so the
    // periodic checker (and the force-refresh endpoint) can tell "nothing
    // new" apart from "found a newer file" without re-parsing/re-upserting
    // on every tick.
    if (!(await targetDb.schema.hasTable("ptl_ingest_state"))) {
        await targetDb.schema.createTable("ptl_ingest_state", (table) => {
            table.integer("id").primary();
            table.string("last_file_name");
            table.timestamp("last_ingested_at");
            table.integer("last_row_count");
            table.timestamp("last_checked_at");
        });
    }

    // 16. order_cycle_checks table — the quality-check workflow. Every
    // cycle of an order/position now has three people on record:
    //   - who prepared it        -> order_preparation_log (cycle_index)
    //   - who ran the cycle      -> order_completion_log (cycle_index)
    //   - who checked it's OK    -> order_cycle_checks (this table)
    // One row per (project_number, position, cycle_index) check — a cycle
    // can be re-checked (e.g. re-verifying after a fix), so this isn't
    // unique-constrained; getCycleCheckStatus (documentsService-side) reads
    // the latest row per cycle. status is "ok" or "issue", with an optional
    // free-text note for what was wrong.
    if (!(await targetDb.schema.hasTable("order_cycle_checks"))) {
        await targetDb.schema.createTable("order_cycle_checks", (table) => {
            table.increments("id").primary();
            table.string("project_number").notNullable();
            table.string("position").notNullable();
            table.integer("cycle_index").notNullable().defaultTo(1);
            table.integer("total_cycles").notNullable().defaultTo(1);
            table.string("employee_name").notNullable();
            table.string("status").notNullable().defaultTo("ok"); // "ok" | "issue"
            table.text("note");
            table.timestamp("created_at").defaultTo(targetDb.fn.now());
        });
    }

    // 17. cycle_timings table — records when each physical cycle actually
    // started and finished (from the STARTED/FINISHED webhook events —
    // see workstationService.recordCycleTiming), for computing employee time
    // norms. One row per (order_id, cycle_index), first-write-wins on each
    // timestamp column (a duplicate/retried STARTED or FINISHED for the same
    // cycle must not reset an already-recorded time) — see the COALESCE in
    // recordCycleTiming's upsert. Denormalizes workplace/product_order/
    // project_number/position/sales_order from the order snapshot so this
    // table can be queried on its own, without joining workstation_log.
    // Deliberately does NOT try to attach employee_name here — the FINISHED
    // webhook doesn't carry it; that only exists later via a manual kiosk
    // confirmation (order_completion_log), which a reporting query can join
    // in separately on (order_id, cycle_index) when it exists.
    if (!(await targetDb.schema.hasTable("cycle_timings"))) {
        await targetDb.schema.createTable("cycle_timings", (table) => {
            table.increments("id").primary();
            table.string("order_id").notNullable();
            table.integer("cycle_index").notNullable();
            table.integer("total_cycles").notNullable().defaultTo(1);
            table.string("workplace");
            table.string("product_order");
            table.string("project_number");
            table.string("position");
            table.string("sales_order");
            table.timestamp("started_at");
            table.timestamp("finished_at");
            table.timestamp("created_at").defaultTo(targetDb.fn.now());
            table.timestamp("updated_at").defaultTo(targetDb.fn.now());
            table.unique(["order_id", "cycle_index"]);
        });
    }

    // 18. non_ptl_items column on ptl_prep_queue — JSON array of the order's
    // items (itemID/itemDesc/itemQuantity/unit) that do NOT appear in
    // parts.xlsx, i.e. the ones nobody in PTL/P2L will pick up automatically
    // and a person has to prepare by hand. Populated at ingest time for
    // Hardware rows (see ptlPlanService.ingestPlanFile /
    // hardwareOrderLookupService.resolveHardwareOrders); null for rows with
    // no resolved order file yet, or workplaces this hasn't been extended
    // to. Stored as JSON text (not a normalized child table) since it's
    // read as a whole checklist and never queried by individual item — same
    // tradeoff as workstations.current_order_data.
    if (!(await targetDb.schema.hasColumn("ptl_prep_queue", "non_ptl_items"))) {
        await targetDb.schema.alterTable("ptl_prep_queue", (table) => {
            table.text("non_ptl_items");
        });
    }

    // 19. order_prep_item_log table — one row per non-PTL item a worker has
    // tapped "prepared" on, in the prep-queue item checklist (see
    // ptlPlanService.getNonPtlItemsForOrder / completionController). A row
    // existing for (project_number, position, item_id) means that item is
    // checked; the "Print label" action in the prep flow stays disabled
    // until every item from non_ptl_items has a matching row here. Unique on
    // the trio so tapping an already-checked item again is a harmless no-op
    // rather than a growing log of duplicates.
    if (!(await targetDb.schema.hasTable("order_prep_item_log"))) {
        await targetDb.schema.createTable("order_prep_item_log", (table) => {
            table.increments("id").primary();
            table.string("project_number").notNullable();
            table.string("position").notNullable();
            table.string("item_id").notNullable();
            table.string("item_desc");
            table.string("employee_name").notNullable();
            table.timestamp("created_at").defaultTo(targetDb.fn.now());
            table.unique(["project_number", "position", "item_id"]);
        });
    }

    // 20. print_settings table — a single-row live on/off switch for all
    // printing (labels, QR stickers, PBOM/declaration/confirmation
    // documents, prep labels), see services/printSettingsService.ts. Lets
    // printing be disabled/re-enabled from a running server without a
    // restart (e.g. while testing on a tablet, to avoid wasting real
    // labels) — every print call site checks this immediately before
    // sending bytes to a physical printer.
    if (!(await targetDb.schema.hasTable("print_settings"))) {
        await targetDb.schema.createTable("print_settings", (table) => {
            table.integer("id").primary();
            table.boolean("enabled").notNullable().defaultTo(true);
            table.timestamp("updated_at").defaultTo(targetDb.fn.now());
        });
    }

    // 21. workstation column on order_cycle_checks — the same
    // project_number+position can be completed independently at more than
    // one workplace (e.g. "Hardware" and "Motor" are separate production
    // passes with their own order_id in order_completion_log, which
    // already has a workstation column). Without one here too, a check
    // recorded for one workplace's cycle 1 was indistinguishable from
    // another workplace's cycle 1, so whichever was checked most recently
    // silently applied to both. Added via alterTable so existing rows
    // (recorded before this existed) keep a NULL workstation rather than
    // losing their check status — getCheckStatusForPositions treats a NULL
    // row as still matching any workplace, so already-checked orders don't
    // appear to reset; only checks recorded from here on are truly scoped.
    if (!(await targetDb.schema.hasColumn("order_cycle_checks", "workstation"))) {
        await targetDb.schema.alterTable("order_cycle_checks", (table) => {
            table.string("workstation");
        });
    }
};
