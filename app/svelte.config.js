import preprocess from 'svelte-preprocess';
import adapter from "@sveltejs/adapter-node";

const ignoredWarningCodes = new Set([
    "a11y_click_events_have_key_events",
    "a11y_no_static_element_interactions"
]);

/** @type {import('@sveltejs/kit').Config} */
const config = {
    preprocess: preprocess({
        sourceMap: true
    }),
    compilerOptions: {
        // Keep legacy interactive markup intact while reducing warning noise.
        warningFilter: (warning) => !ignoredWarningCodes.has(warning.code)
    },

    kit: {
        appDir: "svelte",
        adapter: adapter({ precompress: false }),
    }
};

export default config;
