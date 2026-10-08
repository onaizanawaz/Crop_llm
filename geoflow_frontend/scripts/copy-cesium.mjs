/**
 * Puts Cesium's runtime assets where the browser can fetch them.
 *
 * Cesium is not a self-contained bundle: at runtime it fetches web workers,
 * the approximate terrain grid, its widget images and a few third-party
 * licences from whatever `window.CESIUM_BASE_URL` points at (set in
 * index.html). A bundler cannot inline those, so they are copied into
 * public/cesium and served as static files.
 *
 * vite-plugin-cesium does this for you, but it has not been updated for Vite 8;
 * twenty lines of copy is cheaper than a plugin that pins the build tool.
 *
 * Runs from `predev` and `prebuild`. Skips silently if the copy is already
 * current, so it costs nothing on a warm repo.
 */

import { cp, mkdir, rm, stat, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function main() {
  // Read the directory rather than require.resolve("cesium/package.json"):
  // Cesium's "exports" map does not expose its own package.json, so resolving
  // through it throws ERR_PACKAGE_PATH_NOT_EXPORTED.
  const pkgDir = join(root, "node_modules", "cesium");
  const pkgPath = join(pkgDir, "package.json");
  if (!(await exists(pkgPath))) {
    console.error("[cesium] not installed — skipping asset copy.");
    return;                       // `npm run lint` etc. must not hard-fail here
  }

  const version = JSON.parse(await readFile(pkgPath, "utf8")).version;
  const from = join(pkgDir, "Build", "Cesium");
  const to = join(root, "public", "cesium");
  const stamp = join(to, ".version");

  if (await sameVersion(stamp, version)) {
    console.log(`[cesium] public/cesium already at ${version}`);
    return;
  }

  if (!(await exists(from))) {
    console.error(`[cesium] no built assets at ${from} — skipping.`);
    return;
  }

  await rm(to, { recursive: true, force: true });
  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true });
  await writeFile(stamp, version);
  console.log(`[cesium] copied ${version} into public/cesium`);
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function sameVersion(stamp, version) {
  try { return (await readFile(stamp, "utf8")).trim() === version; } catch { return false; }
}

await main();