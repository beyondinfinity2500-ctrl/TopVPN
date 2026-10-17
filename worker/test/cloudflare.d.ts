/**
 * Ambient declarations for the Cloudflare Vitest test modules so that `tsc`
 * can type-check the test files. `cloudflare:workers` is already declared by
 * @cloudflare/workers-types; the bindings it exposes at runtime are typed
 * explicitly in test/helpers.ts instead.
 */
declare module 'cloudflare:test' {
  export function createExecutionContext(): ExecutionContext;
  export function waitOnExecutionContext(ctx: ExecutionContext): Promise<void>;
  /** Deletes all data from attached bindings (schema is re-applied by tests). */
  export function reset(): Promise<void>;
}

declare module '*?raw' {
  const content: string;
  export default content;
}
