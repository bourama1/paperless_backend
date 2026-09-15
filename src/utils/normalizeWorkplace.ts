/** Case/diacritic/punctuation-insensitive key for a workplace name. */
export function normalizeWorkplace(name: string): string {
    return name
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "") // strip diacritics
        .replace(/[^a-zA-Z0-9]/g, "") // strip spaces/punctuation
        .toLowerCase();
}
