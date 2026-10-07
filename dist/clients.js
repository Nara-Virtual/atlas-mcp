import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
/**
 * The AI clients `atlas install` knows how to wire up, and how: where each keeps its MCP config, which shape, and
 * what to do when it cannot be done safely. A file that does not parse is NEVER rewritten (that would destroy a
 * person's settings); the first change to any file leaves a one-time `.atlas-bak` copy.
 */
export const GITHUB_PKG_LATEST = "github:Nara-Virtual/atlas-mcp#main";
export const KEY_PLACEHOLDER = "${ATLAS_MCP_KEY}";
export function stdioEntry(baseUrl, token = KEY_PLACEHOLDER, via = "npx") {
    const env = { ATLAS_MCP_KEY: token, ATLAS_BASE_URL: baseUrl };
    return via === "global" ? { command: "atlas", args: [], env } : { command: "npx", args: ["-y", GITHUB_PKG_LATEST], env };
}
/** Claude Desktop and Codex take env values literally, so a `${ATLAS_MCP_KEY}` placeholder would be sent AS the key. */
const needsRealKey = (token) => token.includes("${");
/* ------------------------------------------------------------------ files */
export class UnsafeFile extends Error {
}
/** Missing → {}. Present but not plain JSON (comments, a typo) → UnsafeFile: the caller skips it, untouched. */
export function readJsonStrict(path) {
    if (!existsSync(path))
        return {};
    const raw = readFileSync(path, "utf8");
    if (!raw.trim())
        return {};
    try {
        const v = JSON.parse(raw);
        if (v && typeof v === "object" && !Array.isArray(v))
            return v;
    }
    catch {
        /* falls through */
    }
    throw new UnsafeFile("not plain JSON (comments or a syntax error) — left untouched, add the entry by hand");
}
function backupOnce(path) {
    const bak = `${path}.atlas-bak`;
    if (existsSync(path) && !existsSync(bak))
        copyFileSync(path, bak);
}
function writeText(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    backupOnce(path);
    writeFileSync(path, text);
}
/* ------------------------------------------------------------------- TOML */
const tomlStr = (s) => JSON.stringify(s); // a JSON string is a valid TOML basic string
/** Codex `[mcp_servers.atlas]` + `.env` tables. */
export function codexBlock(e) {
    return [
        "[mcp_servers.atlas]",
        `command = ${tomlStr(e.command)}`,
        `args = [${e.args.map(tomlStr).join(", ")}]`,
        "",
        "[mcp_servers.atlas.env]",
        ...Object.entries(e.env).map(([k, v]) => `${k} = ${tomlStr(v)}`),
        "",
    ].join("\n");
}
const OURS = /^\s*\[\s*mcp_servers\.atlas(\.[^\]]+)?\s*\]\s*(#.*)?$/;
const ANY_TABLE = /^\s*\[/;
/** Drop the atlas tables (and only those); everything else in the file stays byte for byte. */
export function removeAtlasToml(raw) {
    const out = [];
    let skipping = false;
    for (const line of raw.split("\n")) {
        if (OURS.test(line))
            skipping = true;
        else if (ANY_TABLE.test(line))
            skipping = false;
        if (!skipping)
            out.push(line);
    }
    return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
export function upsertAtlasToml(raw, e) {
    const base = removeAtlasToml(raw).replace(/\s*$/, "");
    return (base ? base + "\n\n" : "") + codexBlock(e);
}
export function targets(home = homedir(), platform = process.platform, env = process.env) {
    const appData = env.APPDATA || join(home, "AppData", "Roaming");
    const userData = (app) => platform === "win32" ? join(appData, app) : platform === "darwin" ? join(home, "Library", "Application Support", app) : join(home, ".config", app);
    return [
        { id: "cursor", name: "Cursor (~/.cursor/mcp.json)", path: join(home, ".cursor", "mcp.json"), format: "json", root: "mcpServers" },
        { id: "claude-code", name: "Claude Code (~/.claude.json)", path: join(home, ".claude.json"), format: "json", root: "mcpServers" },
        { id: "claude-desktop", name: "Claude Desktop", path: join(userData("Claude"), "claude_desktop_config.json"), format: "json", root: "mcpServers", literalEnv: true },
        { id: "windsurf", name: "Windsurf (~/.codeium/windsurf/mcp_config.json)", path: join(home, ".codeium", "windsurf", "mcp_config.json"), format: "json", root: "mcpServers" },
        { id: "vscode", name: "VS Code (User/mcp.json)", path: join(userData("Code"), "User", "mcp.json"), format: "json", root: "servers", typed: true },
        { id: "vscode-insiders", name: "VS Code Insiders (User/mcp.json)", path: join(userData("Code - Insiders"), "User", "mcp.json"), format: "json", root: "servers", typed: true },
        { id: "copilot-cli", name: "GitHub Copilot CLI (~/.copilot/mcp-config.json)", path: join(home, ".copilot", "mcp-config.json"), format: "json", root: "mcpServers" },
        { id: "codex", name: "Codex CLI (~/.codex/config.toml)", path: join(home, ".codex", "config.toml"), format: "toml", literalEnv: true },
        { id: "gemini", name: "Gemini CLI (~/.gemini/settings.json)", path: join(home, ".gemini", "settings.json"), format: "json", root: "mcpServers" },
    ];
}
export function installTarget(t, e) {
    if (t.literalEnv && needsRealKey(e.env.ATLAS_MCP_KEY))
        return { ok: false, why: "needs the real key — re-run with --key atlas_mcp_… (it cannot read your shell profile)" };
    try {
        if (t.format === "toml") {
            const raw = existsSync(t.path) ? readFileSync(t.path, "utf8") : "";
            writeText(t.path, upsertAtlasToml(raw, e));
        }
        else {
            const cfg = readJsonStrict(t.path);
            const entry = t.typed ? { type: "stdio", ...e } : e;
            writeText(t.path, JSON.stringify({ ...cfg, [t.root]: { ...(cfg[t.root] ?? {}), atlas: entry } }, null, 2) + "\n");
        }
        return { ok: true };
    }
    catch (err) {
        return { ok: false, why: err.message };
    }
}
export function removeTarget(t) {
    if (!existsSync(t.path))
        return "absent";
    try {
        if (t.format === "toml") {
            const raw = readFileSync(t.path, "utf8");
            const next = removeAtlasToml(raw);
            if (next === raw)
                return "absent";
            writeText(t.path, next);
            return "removed";
        }
        const cfg = readJsonStrict(t.path);
        const servers = cfg[t.root];
        if (!servers || !("atlas" in servers))
            return "absent";
        const { atlas: _gone, ...rest } = servers;
        writeText(t.path, JSON.stringify({ ...cfg, [t.root]: rest }, null, 2) + "\n");
        return "removed";
    }
    catch (err) {
        return { ok: false, why: err.message };
    }
}
/** Does this client's config already have an `atlas` server? (doctor) */
export function hasAtlas(t) {
    try {
        if (!existsSync(t.path))
            return false;
        if (t.format === "toml")
            return readFileSync(t.path, "utf8").split("\n").some((l) => OURS.test(l));
        const servers = readJsonStrict(t.path)[t.root];
        return !!servers && "atlas" in servers;
    }
    catch {
        return false;
    }
}
