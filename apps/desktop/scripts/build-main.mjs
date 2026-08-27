import { build } from "esbuild";

const sharedOptions = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
};

await build({
  ...sharedOptions,
  entryPoints: ["src/main/main.ts"],
  format: "esm",
  outfile: "dist/main/main.js",
});

await build({
  ...sharedOptions,
  entryPoints: ["src/preload/preload.cts"],
  format: "cjs",
  outfile: "dist/preload/preload.cjs",
});
