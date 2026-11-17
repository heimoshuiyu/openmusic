// Android substitutes its origin-scoped native transport at build time.
export const apiFetch: typeof fetch = (...args) => fetch(...args)
