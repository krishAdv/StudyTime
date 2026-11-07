// Used only by the verification scripts (vite-node -c scripts/vite.scripts.config.ts ...).
// envDir: false stops Vite from loading .env / .env.local into the process, so the scripts see ONLY the environment
// variables the person running them set on purpose. (.env.local holds the production URL.)
const config = { envDir: false as const };
export default config;
