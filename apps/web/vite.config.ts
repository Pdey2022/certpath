import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      ...(process.env.VITE_CERTPATH_STAGING === "true"
        ? { configPath: "./wrangler.staging.jsonc" }
        : process.env.VITE_CERTPATH_PILOT === "true"
          ? { configPath: "./wrangler.pilot.jsonc" }
          : process.env.VITE_CERTPATH_PUBLIC_RELEASE === "true"
            ? { configPath: "./wrangler.site.jsonc" }
            : process.env.VITE_CERTPATH_UI_PREVIEW === "true"
              ? { configPath: "./wrangler.preview.jsonc" }
              : {}),
    }),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
