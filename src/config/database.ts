import knex, { Knex } from "knex";

let db: Knex | null = null;

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

    db = knex({
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

    await setupDatabase(db);
    return db;
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
};
