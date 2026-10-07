import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
/** Machine-wide defaults (set by `cursor-install` / `install`). */
export function globalConfigPath() {
    return join(homedir(), ".atlas", "config.json");
}
/** Optional per-repo override — walk up from cwd. */
export function findDotAtlas(start = process.cwd()) {
    let dir = start;
    for (let i = 0; i < 40; i++) {
        const p = join(dir, ".atlas");
        if (existsSync(p))
            return { path: p, root: dir };
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return null;
}
function readConfigFile(path) {
    try {
        return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    }
    catch {
        return {};
    }
}
/** A key an app passed through unexpanded ("${ATLAS_MCP_KEY}") is not a key. */
export function cleanKey(v) {
    const k = v?.trim();
    return k && !k.includes("${") ? k : null;
}
export function loadConfig() {
    const found = findDotAtlas();
    // Global first, optional repo .atlas overrides (most users only need global).
    let config = { ...readConfigFile(globalConfigPath()) };
    if (found)
        config = { ...config, ...readConfigFile(found.path) };
    return {
        baseUrl: (process.env.ATLAS_BASE_URL || "https://atlas.naravirtual.in").replace(/\/$/, ""),
        apiKey: cleanKey(process.env.ATLAS_MCP_KEY) ?? cleanKey(process.env.ATLAS_API_KEY),
        config,
        cwd: process.cwd(),
    };
}
/** Default toolsets when config doesn't specify. Write is ON by default. */
export const DEFAULT_TOOLSETS = ["context", "capture", "tasks", "write"];
