import { sveltekit } from "@sveltejs/kit/vite";
import Icons from "unplugin-icons/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    sveltekit(),
    Icons({ compiler: "svelte" }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          const normalized = id.replace(/\\/g, "/");
          // Keep Svelte runtime internals in a single chunk to avoid chunk-order cycles.
          if (normalized.includes("/node_modules/svelte/")) {
            return "svelte-runtime";
          }
          return undefined;
        },
      },
    },
  },
});
