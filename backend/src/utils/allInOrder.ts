/**
 * Waits for independent reads started side by side, and fails as awaiting them one after the other would: with the
 * error of the first of them, in the order given, that failed. Promise.all fails with whichever failed first in time.
 *
 * It waits for every promise to settle before throwing, so a failure surfaces only once the slowest read is over.
 * Pass promises already started, built from async functions or lazy queries: an element that threw synchronously
 * while the array is built would throw before any read is awaited, leaving those already started unhandled.
 */
export const allInOrder = async <T extends readonly unknown[]>(reads: { [K in keyof T]: PromiseLike<T[K]> }): Promise<T> => {
    const settled = await Promise.allSettled(reads)
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected")
    if (failed) throw failed.reason
    return settled.map(result => (result as PromiseFulfilledResult<unknown>).value) as unknown as T
}
