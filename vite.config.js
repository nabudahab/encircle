import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  if (env.VITE_USE_LOCAL_API !== "true") return {};
  const proxy = { "/api": { target: env.ENCIRCLE_API_URL || "http://127.0.0.1:3001" } };
  return { server: { proxy }, preview: { proxy } };
});
