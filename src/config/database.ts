import knex, { Knex } from "knex";
import path from "path";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

let db: Knex | null = null;

function getDbType(): "sqlite" | "postgres" {
    return (process.env.DB_TYPE as "sqlite" | "postgres") || "sqlite";
}

export async function insertGetId<T extends Record<string, any>>(
    targetDb: Knex,
    table: string,
    data: T,
    idColumn: keyof T & string = "id" as any,
): Promise<number> {
    const result = await targetDb(table).insert(data).returning(idColumn);
    const row = result[0];
    if (typeof row === "number") return row;
    if (row && typeof row === "object" && idColumn in row) return Number(row[idColumn]);
    throw new Error(`insertGetId: could not determine ${String(idColumn)}`);
}

export const getDb = async () => {
    if (db) return db;

    const dbType = getDbType();

    if (dbType === "postgres") {
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
    } else {
        const dbPath = process.env.DATABASE_URL || "./data/database.sqlite";
        const dbDir = path.dirname(dbPath);

        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        db = knex({
            client: "sqlite3",
            connection: { filename: dbPath },
            useNullAsDefault: true,
        });
    }

    await setupDatabase(db);
    return db;
};

const setupDatabase = async (targetDb: Knex) => {
    // 1. documents table
    if (!(await targetDb.schema.hasTable("documents"))) {
        await targetDb.schema.createTable("documents", (table) => {
            table.increments("id").primary();
            table.string("name").notNullable();
            table.timestamp("created_at").defaultTo(targetDb.fn.now());
            table.timestamp("updated_at").defaultTo(targetDb.fn.now());
        });
    }

    // 2. revisions table
    if (!(await targetDb.schema.hasTable("revisions"))) {
        await targetDb.schema.createTable("revisions", (table) => {
            table.increments("id").primary();
            table.integer("document_id").notNullable().references("id").inTable("documents");
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

    // 5. Migration from legacy 'queue' table
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

    // 6. Ensure 'annotations' column exists in 'revisions'
    const hasAnnotations = await targetDb.schema.hasColumn("revisions", "annotations");
    if (!hasAnnotations) {
        console.log("Adding annotations column to revisions table...");
        await targetDb.schema.alterTable("revisions", (table) => {
            table.text("annotations");
        });
        console.log("Column added.");
    }
};
