/** Build a thenable that resolves to `value` when awaited via `.then()` */
export function thenable<T>(value: T) {
    return { then: (resolve: (v: T) => void) => resolve(value) };
}
