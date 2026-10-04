/**
 * In-place "ignore explicitly-undefined fields" patch, shared by every
 * RPC service's Patch* handler here (SupervisorService.PatchMetadata's
 * immutable variant is mergeDefined in supervisor.ts; this is the mutating
 * form for patching scalar state objects like SupervisorState.player or
 * SchedulerState.config directly).
 *
 * Proto3 `optional` fields arrive as `undefined` when unset, so a plain
 * `Object.assign(target, patch)` would clobber good values with undefined.
 */
export function applyDefined<T extends object>(target: T, patch: Partial<T>): void {
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const value = patch[key];
    if (value !== undefined) target[key] = value;
  }
}
