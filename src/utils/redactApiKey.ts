// Strips the ?apiKey=... query param value out of a URL or log line before
// it's printed, so the shared secret used by the PDF WebView/iframe (see
// middleware/apiKeyAuth.ts) never ends up in console output or log files.
export function redactApiKey(text: string): string {
    return text.replace(/([?&]apiKey=)[^&\s]+/gi, "$1***");
}
