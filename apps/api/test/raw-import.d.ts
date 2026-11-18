// Vite's `?raw` import, used by the config test that reads the committed
// `apps/web/wrangler.jsonc` without a Node filesystem (the vitest environment is
// a Worker). This file must stay a global script: a `declare module` inside a
// module file is an augmentation, not an ambient declaration.
declare module "*?raw" {
  const value: string;
  export default value;
}
