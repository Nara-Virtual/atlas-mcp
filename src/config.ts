import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export type AtlasConfig = {
  project?: string;
  autoCapture?: boolean;
  toolsets?: string[];
  readOnly?: boolean;
  redactSecretsInLogs?: boolean;
};

export type Resolved = {
  baseUrl: string;
  apiKey: string | null;
  config: AtlasConfig;
  /** Workspace root for localPath — the IDE's cwd, not a .atlas marker. */
  cwd: string;
};

/** Machine-wide defaults (set by `cursor-install` / `install`). */
export function globalConfigPath() {
  return join(homedir(), ".atlas", "config.json");
}

/** Optional per-repo override — walk up from cwd. */
export function findDotAtlas(start = process.cwd()): { path: string; root: string } | null {
  let dir = start;
  for (let i = 0; i < 40; i++) {
    const p = join(dir, ".atlas");
    if (existsSync(p)) return { path: p, root: dir };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readConfigFile(path: string): AtlasConfig {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as AtlasConfig) : {};
  } catch {
    return {};
  }
}

export function loadConfig(): Resolved {
  const found = findDotAtlas();
  // Global first, optional repo .atlas overrides (most users only need global).
  let config: AtlasConfig = { ...readConfigFile(globalConfigPath()) };
  if (found) config = { ...config, ...readConfigFile(found.path) };

  return {
    baseUrl: (process.env.ATLAS_BASE_URL || "https://atlas.naravirtual.in").replace(/\/$/, ""),
    apiKey: process.env.ATLAS_MCP_KEY || process.env.ATLAS_API_KEY || null,
    config,
    cwd: process.cwd(),
  };
}

/** Default toolsets when config doesn't specify. Write is ON by default. */
export const DEFAULT_TOOLSETS = ["context", "capture", "tasks", "write"];
