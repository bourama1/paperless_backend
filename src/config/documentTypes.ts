// doc_manager document_type IDs, shared between the STARTED-cycle document
// printing flow (workstationService.printDocumentsForOrder) and the
// finished-order retention archival flow (services/archivalService.ts).
export const DOCUMENT_TYPES = {
    DECLARATION_CONFORMITY: 4,
    DECLARATION_PERFORMANCE: 5,
    PBOM_HARDWARE: 14,
    CONFIRMATION: 21,
} as const;

export const DOCUMENT_TYPE_NAMES: Record<number, string> = {
    [DOCUMENT_TYPES.DECLARATION_CONFORMITY]: "declaration_conformity",
    [DOCUMENT_TYPES.DECLARATION_PERFORMANCE]: "declaration_performance",
    [DOCUMENT_TYPES.PBOM_HARDWARE]: "pbom_hardware",
    [DOCUMENT_TYPES.CONFIRMATION]: "confirmation",
};

export function documentTypeName(typeId: number): string {
    return DOCUMENT_TYPE_NAMES[typeId] || `type${typeId}`;
}
