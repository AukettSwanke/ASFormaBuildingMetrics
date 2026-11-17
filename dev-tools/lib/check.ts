// A very small assertion helper shared by the node and browser suites.

export interface Result { name: string; ok: boolean; detail: string }

export const results: Result[] = [];

/** Records one check. `detail` is shown either way, so measured values appear in the log. */
export const check = (name: string, ok: boolean, detail: unknown = ''): boolean => {
    results.push({ name, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
    return ok;
};

export const near = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) <= tolerance;

/** Runs a test body and records a failure, rather than stopping the suite, if it throws. */
export const test = async (name: string, body: () => unknown | Promise<unknown>): Promise<void> => {
    try {
        await body();
    } catch (error) {
        check(`${name} (threw)`, false, error instanceof Error ? error.stack ?? error.message : String(error));
    }
};
