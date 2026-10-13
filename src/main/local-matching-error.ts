export type LocalFailureKind = "input" | "invalid-output" | "unavailable" | "inference" | "worker" | "timeout" | "cancelled";
export class LocalMatchingError extends Error {
  constructor(readonly kind: LocalFailureKind, message: string) { super(message); this.name = "LocalMatchingError"; }
}
