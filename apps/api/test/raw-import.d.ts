// Vite's raw imports, used by the config-coupling test to read the committed
// `apps/web/wrangler*.jsonc` files without a Node filesystem (the vitest
// environment is a Worker).
//
// `@cloudflare/vitest-plugin/types` does not ship Vite's client typings, so the
// one `import.meta.glob` shape this test uses is declared here. This file must
// stay a global script: a `declare module` inside a module file is an
// augmentation, not an ambient declaration.
declare module "*?raw" {
  const value: string;
  export default value;
}

interface ImportMeta {
  glob(
    pattern: string | string[],
    options: { query: string; import: string; eager: true },
  ): Record<string, string>;
}
