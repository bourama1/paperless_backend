// doc_manager document_type IDs, shared between the STARTED-cycle document
// printing flow (workstationService.printDocumentsForOrder) and the
// finished-order retention archival flow (services/archivalService.ts).
//
// Full list mirrors doc_manager's own numbering (see its README's
// "Document Types (IDs)" section) — ids 1-21, in that exact order.
export const DOCUMENT_TYPES = {
    CD_DOORLEAF: 1,
    CD_RAILS: 2,
    CD_OTHER: 3,
    DECLARATION_CONFORMITY: 4,
    DECLARATION_PERFORMANCE: 5,
    PD_DOORLEAF: 6,
    PD_RAILS: 7,
    PD_OTHER: 8,
    SPRINGS: 9,
    CUSTOMER_BOM: 10,
    PBOM_CABLES: 11,
    PBOM_DOORLEAF: 12,
    PBOM_FIXED_TOP_PANEL: 13,
    PBOM_HARDWARE: 14,
    PBOM_MOTOR: 15,
    PBOM_DECLANATION: 16,
    PBOM_PREASSEMBLED_SHAFT: 17,
    PBOM_PROFILES: 18,
    PBOM_RAILS: 19,
    PBOM_OTHER: 20,
    CONFIRMATION: 21,
} as const;

export const DOCUMENT_TYPE_NAMES: Record<number, string> = {
    [DOCUMENT_TYPES.CD_DOORLEAF]: "cd_doorleaf",
    [DOCUMENT_TYPES.CD_RAILS]: "cd_rails",
    [DOCUMENT_TYPES.CD_OTHER]: "cd_other",
    [DOCUMENT_TYPES.DECLARATION_CONFORMITY]: "declaration_conformity",
    [DOCUMENT_TYPES.DECLARATION_PERFORMANCE]: "declaration_performance",
    [DOCUMENT_TYPES.PD_DOORLEAF]: "pd_doorleaf",
    [DOCUMENT_TYPES.PD_RAILS]: "pd_rails",
    [DOCUMENT_TYPES.PD_OTHER]: "pd_other",
    [DOCUMENT_TYPES.SPRINGS]: "springs",
    [DOCUMENT_TYPES.CUSTOMER_BOM]: "customer_bom",
    [DOCUMENT_TYPES.PBOM_CABLES]: "pbom_cables",
    [DOCUMENT_TYPES.PBOM_DOORLEAF]: "pbom_doorleaf",
    [DOCUMENT_TYPES.PBOM_FIXED_TOP_PANEL]: "pbom_fixed_top_panel",
    [DOCUMENT_TYPES.PBOM_HARDWARE]: "pbom_hardware",
    [DOCUMENT_TYPES.PBOM_MOTOR]: "pbom_motor",
    [DOCUMENT_TYPES.PBOM_DECLANATION]: "pbom_declanation",
    [DOCUMENT_TYPES.PBOM_PREASSEMBLED_SHAFT]: "pbom_preassembled_shaft",
    [DOCUMENT_TYPES.PBOM_PROFILES]: "pbom_profiles",
    [DOCUMENT_TYPES.PBOM_RAILS]: "pbom_rails",
    [DOCUMENT_TYPES.PBOM_OTHER]: "pbom_other",
    [DOCUMENT_TYPES.CONFIRMATION]: "confirmation",
};

export function documentTypeName(typeId: number): string {
    return DOCUMENT_TYPE_NAMES[typeId] || `type${typeId}`;
}

// ─── Production BOM ("open the right BOM for this workstation") ───────────
//
// Mirrors labelPrintingService.ts's WORKPLACE_TO_SCAN_PREFIX normalization
// (same workplace name variants seen from production), but maps to the
// PBOM document_type doc_manager actually stores that workplace's BOM
// under — these are NOT the same grouping as the label scan prefixes
// (e.g. "Motor" shares a label scan prefix with "Hardware", but has its
// own, separate PBOM document type).
//
// Kept as a local copy of the normalization (rather than importing from
// labelPrintingService.ts) to avoid a circular import between this file,
// labelPrintingService.ts, and workstationService.ts.
function normalizeWorkplace(name: string): string {
    return name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // strip diacritics
        .replace(/[^a-zA-Z0-9]/g, "") // strip spaces/punctuation
        .toLowerCase();
}

const WORKPLACE_TO_PBOM_TYPE_MAP: Record<string, number> = {
    hardware: DOCUMENT_TYPES.PBOM_HARDWARE,
    predmontazoptolisty: DOCUMENT_TYPES.PBOM_HARDWARE,

    motor: DOCUMENT_TYPES.PBOM_MOTOR,

    predpripravahridele: DOCUMENT_TYPES.PBOM_PREASSEMBLED_SHAFT,
    predhridel: DOCUMENT_TYPES.PBOM_PREASSEMBLED_SHAFT,

    mandoor: DOCUMENT_TYPES.PBOM_DOORLEAF,
    "2kv": DOCUMENT_TYPES.PBOM_DOORLEAF,
    balirnakridlo: DOCUMENT_TYPES.PBOM_DOORLEAF,
    kridlo: DOCUMENT_TYPES.PBOM_DOORLEAF,

    vedeni: DOCUMENT_TYPES.PBOM_RAILS,
    vedeniindy: DOCUMENT_TYPES.PBOM_RAILS,
    vedeniguardy: DOCUMENT_TYPES.PBOM_RAILS,
};

/**
 * Resolves which PBOM document_type a workplace's "open BOM" action should
 * fetch. Falls back to PBOM_HARDWARE for unrecognized workplaces, matching
 * the previous (hardcoded) behavior, so nothing breaks for workplaces not
 * yet in the map — but logs so the mapping can be extended.
 */
export function resolvePbomTypeForWorkplace(workplace: string): number {
    const key = normalizeWorkplace(workplace || "");
    const resolved = WORKPLACE_TO_PBOM_TYPE_MAP[key];
    if (resolved === undefined) {
        console.log(
            `[PBOM] workplace="${workplace}" not recognized (normalized: "${key}") – defaulting to PBOM_HARDWARE. ` +
                `If this workplace should open a different BOM, add it to WORKPLACE_TO_PBOM_TYPE_MAP.`,
        );
        return DOCUMENT_TYPES.PBOM_HARDWARE;
    }
    return resolved;
}

// ─── "Open any BOM" (search screen) ────────────────────────────────────────
//
// The set of document types considered "a BOM" for the purposes of letting
// someone pick freely from whatever doc_manager actually has for a given
// order/position, rather than assuming Hardware.
export const BOM_DOCUMENT_TYPES: number[] = [
    DOCUMENT_TYPES.CUSTOMER_BOM,
    DOCUMENT_TYPES.PBOM_CABLES,
    DOCUMENT_TYPES.PBOM_DOORLEAF,
    DOCUMENT_TYPES.PBOM_FIXED_TOP_PANEL,
    DOCUMENT_TYPES.PBOM_HARDWARE,
    DOCUMENT_TYPES.PBOM_MOTOR,
    DOCUMENT_TYPES.PBOM_DECLANATION,
    DOCUMENT_TYPES.PBOM_PREASSEMBLED_SHAFT,
    DOCUMENT_TYPES.PBOM_PROFILES,
    DOCUMENT_TYPES.PBOM_RAILS,
    DOCUMENT_TYPES.PBOM_OTHER,
];
