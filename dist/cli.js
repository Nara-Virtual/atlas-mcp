#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { runServer } from "./index.js";
import { loadConfig, DEFAULT_TOOLSETS, globalConfigPath } from "./config.js";
import { envCli, logCli, ENV_HELP } from "./env.js";
import { syncCli, SYNC_HELP } from "./sync.js";
function out(m) {
    process.stderr.write(m + "\n");
}
function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}
function readJson(p) {
    try {
        return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
    }
    catch {
        return {};
    }
}
function writeJson(p, data) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
}
// Install once globally: bun install -g github:Nara-Virtual/atlas-mcp#main
export const GITHUB_REPO = "Nara-Virtual/atlas-mcp";
export const GITHUB_PKG = `github:${GITHUB_REPO}`;
/** Pin to main so npx/bun always resolve the latest commit (not a stale lock). */
export const GITHUB_PKG_LATEST = `${GITHUB_PKG}#main`;
function run(cmd) {
    execSync(cmd, {
        stdio: "inherit",
        shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    });
}
/** Refresh global atlas-mcp from GitHub main (bun or npm). */
export function selfUpdate() {
    out(`\nUpdating atlas-mcp from ${GITHUB_PKG_LATEST} …\n`);
    const bun = (() => {
        try {
            execSync("bun --version", { stdio: ["ignore", "pipe", "ignore"] });
            return true;
        }
        catch {
            return false;
        }
    })();
    if (bun) {
        try {
            run(`bun remove -g atlas-mcp`);
        }
        catch {
            /* not installed via bun yet */
        }
        run(`bun install -g ${GITHUB_PKG_LATEST}`);
    }
    else {
        run(`npm install -g ${GITHUB_PKG_LATEST}`);
    }
    out(`\n✓ Updated. Restart Cursor / Claude Code MCP, or reload the window.\n`);
}
/** Stdio MCP entry for IDEs. npx = zero global install; atlas = faster cold start if on PATH. */
export function stdioMcpEntry(baseUrl, token = "${ATLAS_MCP_KEY}", via = "npx") {
    const env = { ATLAS_MCP_KEY: token, ATLAS_BASE_URL: baseUrl };
    if (via === "global")
        return { command: "atlas", args: [], env };
    return { command: "npx", args: ["-y", GITHUB_PKG_LATEST], env };
}
function vscodeUserMcpPath(variant = "Code") {
    const home = homedir();
    if (process.platform === "win32") {
        const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
        return join(appData, variant, "User", "mcp.json");
    }
    if (process.platform === "darwin") {
        return join(home, "Library", "Application Support", variant, "User", "mcp.json");
    }
    return join(home, ".config", variant, "User", "mcp.json");
}
/** VS Code mcp.json uses `servers` + explicit stdio type. */
function vscodeMcpEntry(baseUrl, token) {
    const { command, args, env } = stdioMcpEntry(baseUrl, token, "npx");
    return { type: "stdio", command, args, env };
}
function writeGlobalAtlasConfig(patch) {
    const path = globalConfigPath();
    writeJson(path, { ...readJson(path), ...patch });
    return path;
}
/** Machine-wide IDE MCP configs only — never project-local files. */
function writeGlobalAgentConfigs(baseUrl, token) {
    const entry = stdioMcpEntry(baseUrl, token, "npx");
    const vscodeEntry = vscodeMcpEntry(baseUrl, token);
    const home = homedir();
    const merge = (c, root, server) => ({
        ...c,
        [root]: { ...(c[root] ?? {}), atlas: server },
    });
    const targets = [
        {
            name: "Cursor (~/.cursor/mcp.json)",
            path: join(home, ".cursor", "mcp.json"),
            apply: (c) => merge(c, "mcpServers", entry),
        },
        {
            name: "Claude Code (~/.claude.json)",
            path: join(home, ".claude.json"),
            apply: (c) => merge(c, "mcpServers", entry),
        },
        {
            name: "Windsurf (~/.codeium/windsurf/mcp_config.json)",
            path: join(home, ".codeium", "windsurf", "mcp_config.json"),
            apply: (c) => merge(c, "mcpServers", entry),
        },
        {
            name: "VS Code (User/mcp.json)",
            path: vscodeUserMcpPath("Code"),
            apply: (c) => merge(c, "servers", vscodeEntry),
        },
        {
            name: "VS Code Insiders (User/mcp.json)",
            path: vscodeUserMcpPath("Code - Insiders"),
            apply: (c) => merge(c, "servers", vscodeEntry),
        },
        {
            name: "GitHub Copilot CLI (~/.copilot/mcp-config.json)",
            path: join(home, ".copilot", "mcp-config.json"),
            apply: (c) => merge(c, "mcpServers", entry),
        },
    ];
    for (const t of targets) {
        try {
            writeJson(t.path, t.apply(readJson(t.path)));
            out(`  ✓ ${t.name}`);
        }
        catch (e) {
            out(`  · skipped ${t.name} (${e.message})`);
        }
    }
}
/** Optional: write repo-level .atlas override (does not touch IDE configs). */
function writeRepoDotAtlas(project, existing) {
    writeJson(join(process.cwd(), ".atlas"), {
        project,
        autoCapture: existing.autoCapture ?? true,
        toolsets: existing.toolsets ?? DEFAULT_TOOLSETS,
        readOnly: existing.readOnly ?? false,
        redactSecretsInLogs: existing.redactSecretsInLogs ?? true,
    });
}
async function apiFetch(baseUrl, key, path, init) {
    try {
        const res = await fetch(`${baseUrl}${path}`, {
            ...init,
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
        });
        if (!res.ok)
            return null;
        return (await res.json());
    }
    catch {
        return null;
    }
}
/** Look up by name; link if exists, else ask and create. Returns canonical project name. */
async function ensureProjectLinked(baseUrl, key, projectName) {
    const name = projectName.trim();
    if (!name)
        throw new Error("Project name is required");
    if (!key) {
        out(`\nLinked to project "${name}" locally — set ATLAS_MCP_KEY to verify or create on Atlas.`);
        return name;
    }
    const who = await apiFetch(baseUrl, key, "/api/v1/projects");
    const projects = who?.projects ?? [];
    const match = projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (match) {
        out(`\n✓ Linked to existing Atlas project "${match.name}"`);
        return match.name;
    }
    const interactive = process.stdin.isTTY && !process.env.CI;
    if (!interactive) {
        out(`\n· Project "${name}" not found in Atlas (non-interactive). Create it in the app or re-run in a terminal.`);
        return name;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const yn = (await rl.question(`Project "${name}" doesn't exist in Atlas. Create it? [Y/n] `)).trim().toLowerCase();
    rl.close();
    if (yn !== "" && yn !== "y" && yn !== "yes") {
        out(`\n· Skipped create — binding this repo to "${name}" anyway (create the project in Atlas when ready).`);
        return name;
    }
    const created = await apiFetch(baseUrl, key, "/api/v1/projects", {
        method: "POST",
        body: JSON.stringify({ name }),
    });
    if (created) {
        out(`  ✓ Created project "${created.name}" and linked this repo`);
        return created.name;
    }
    out(`  · Could not create (check key has projects:write) — binding by name anyway.`);
    return name;
}
async function globalInstall(opts = {}) {
    const key = arg("key") || process.env.ATLAS_MCP_KEY;
    const baseUrl = (arg("base-url") || process.env.ATLAS_BASE_URL || "https://atlas.naravirtual.in").replace(/\/$/, "");
    const token = key?.trim() || "${ATLAS_MCP_KEY}";
    const folder = process.cwd().split(/[\\/]/).filter(Boolean).pop() || "general";
    const flagProject = arg("project");
    let project;
    if (flagProject)
        project = await ensureProjectLinked(baseUrl, key, flagProject);
    else if (key)
        project = await ensureProjectLinked(baseUrl, key, folder);
    else
        project = folder;
    out(`\nGlobal Atlas MCP install (machine-wide, not per-repo):`);
    if (opts.cursorOnly) {
        const path = join(homedir(), ".cursor", "mcp.json");
        const cfg = readJson(path);
        cfg.mcpServers ??= {};
        cfg.mcpServers.atlas = stdioMcpEntry(baseUrl, token, "npx");
        writeJson(path, cfg);
        out(`  ✓ Cursor (~/.cursor/mcp.json)`);
    }
    else {
        writeGlobalAgentConfigs(baseUrl, token);
    }
    if (project) {
        const cfgPath = writeGlobalAtlasConfig({
            project,
            autoCapture: true,
            toolsets: DEFAULT_TOOLSETS,
            readOnly: false,
            redactSecretsInLogs: true,
        });
        out(`  ✓ Default project "${project}" → ${cfgPath}`);
    }
    out(`Transport: npx → ${GITHUB_PKG_LATEST} (tools sync from server on each connect; localPath reads from workspace)`);
    if (!key)
        out(`Set ATLAS_MCP_KEY in your shell, or re-run with --key atlas_mcp_…`);
    out(`Restart Cursor, Claude Code, Windsurf, VS Code, or Copilot CLI.\n`);
}
/** Optional per-repo override — does NOT touch IDE MCP configs (use install for that). */
async function bindRepo() {
    const key = arg("key") || process.env.ATLAS_MCP_KEY;
    const folder = process.cwd().split(/[\\/]/).filter(Boolean).pop() || "general";
    const baseUrl = (arg("base-url") || process.env.ATLAS_BASE_URL || "https://atlas.naravirtual.in").replace(/\/$/, "");
    const dotAtlas = join(process.cwd(), ".atlas");
    const existing = existsSync(dotAtlas) ? readJson(dotAtlas) : {};
    const flagProject = arg("project");
    let project;
    if (flagProject) {
        project = await ensureProjectLinked(baseUrl, key, flagProject);
    }
    else if (typeof existing.project === "string" && existing.project.trim()) {
        project = existing.project;
        out(`\nAlready linked to "${project}" (.atlas). Pass --project <name> to change.`);
    }
    else {
        project = await ensureProjectLinked(baseUrl, key, folder);
    }
    writeRepoDotAtlas(project, existing);
    out(`\nWrote .atlas → project "${project}"`);
    out(`IDE MCP is machine-wide — run: npx -y ${GITHUB_PKG} install --key $ATLAS_MCP_KEY --project ${project}\n`);
}
async function init() {
    out(`\nTip: MCP is global — prefer: npx -y ${GITHUB_PKG} install --key $ATLAS_MCP_KEY --project <name>\n`);
    await bindRepo();
}
/** Install Claude Code hooks that POST prompts + sessions to Atlas (zero-cooperation capture). */
function hooksInstall() {
    const settingsPath = join(process.cwd(), ".claude", "settings.json");
    const s = readJson(settingsPath);
    s.hooks ??= {};
    const hook = (event) => ({
        matcher: "*",
        hooks: [{ type: "command", command: `atlas hook ${event}` }],
    });
    s.hooks.UserPromptSubmit = [hook("prompt")];
    s.hooks.Stop = [hook("stop")];
    writeJson(settingsPath, s);
    out(`Installed Claude Code hooks → ${settingsPath}`);
    out(`UserPromptSubmit + Stop now POST to Atlas activity. Restart Claude Code.`);
}
/** Hook runner: reads the hook event JSON on stdin and logs to Atlas. */
async function hook(event) {
    const { baseUrl, apiKey, config } = loadConfig();
    if (!apiKey)
        return; // silently no-op without a key
    let payload = {};
    try {
        payload = JSON.parse(readFileSync(0, "utf8")); // stdin
    }
    catch {
        /* ignore */
    }
    let branch;
    let files = [];
    try {
        branch = execSync("git rev-parse --abbrev-ref HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
        files = execSync("git diff --name-only HEAD", { stdio: ["ignore", "pipe", "ignore"] })
            .toString()
            .split("\n")
            .filter(Boolean)
            .slice(0, 100);
    }
    catch {
        /* not a git repo */
    }
    const body = event === "prompt"
        ? { client: "claude-code", kind: "prompt", prompt: payload.prompt ?? payload.user_prompt, branch }
        : { client: "claude-code", kind: "session", summary: `Session in ${config.project ?? "repo"}`, files, branch };
    try {
        await fetch(`${baseUrl}/api/v1/activity`, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    }
    catch {
        /* best-effort */
    }
}
const invokedAs = process.argv[1]?.split(/[\\/]/).pop()?.replace(/\.(js|cjs|mjs)$/, "") ?? "";
const cmd = process.argv[2];
function shouldRunServer() {
    // IDEs spawn `atlas` with piped stdio (not a TTY). A bare `atlas` in your terminal shows help.
    return cmd === "serve" || invokedAs === "atlas-mcp" || (!cmd && !process.stdin.isTTY);
}
function showHelp() {
    out(`atlas — connect your IDE to Atlas (global, one-time per machine)\n`);
    out(`Recommended (no global npm install):\n`);
    out(`  npx -y ${GITHUB_PKG} install --key atlas_mcp_… --project Nara`);
    out(`    → Cursor, Claude Code, Windsurf, VS Code, Copilot CLI + ~/.atlas/config.json\n`);
    out(`  npx -y ${GITHUB_PKG} cursor-install --key atlas_mcp_… --project Nara   Cursor only\n`);
    out(`Optional per-repo override (not required for MCP):\n`);
    out(`  atlas . [--project Name]   link repo; creates project if missing (uses folder name by default)`);
    out(`  npx -y ${GITHUB_PKG} bind --project foo   writes ./.atlas only\n`);
    out(`Other:\n`);
    out(`  atlas update            pull latest atlas-mcp from GitHub (bun/npm global)`);
    out(`  npx -y ${GITHUB_PKG_LATEST} update   same, without a prior global install`);
    out(`  atlas hooks install     Claude Code auto-capture hooks (per repo)`);
    out(`  atlas serve             stdio MCP server (IDEs spawn via npx)\n`);
    out(ENV_HELP + "\n");
    out(SYNC_HELP + "\n");
}
(async () => {
    // `atlas .` or `atlas init` → scaffold .atlas + agent configs in the current folder
    if (cmd === "install")
        await globalInstall();
    else if (cmd === "cursor-install" || (cmd === "cursor" && process.argv[3] === "install"))
        await globalInstall({ cursorOnly: true });
    else if (cmd === "bind" || cmd === "." || cmd === "init" || cmd === "setup") {
        if (cmd === "." || cmd === "init" || cmd === "setup")
            await init();
        else
            await bindRepo();
    }
    else if (cmd === "update" || cmd === "self-update")
        selfUpdate();
    else if (cmd === "hooks" && process.argv[3] === "install")
        hooksInstall();
    else if (cmd === "hook")
        await hook(process.argv[3] ?? "stop");
    else if (cmd === "env")
        await envCli(process.argv.slice(3));
    else if (cmd === "log")
        await logCli(process.argv.slice(3));
    else if (cmd === "sync")
        await syncCli(process.argv.slice(3));
    else if (shouldRunServer())
        await runServer();
    else if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h")
        showHelp();
    else {
        out(`Unknown command: ${cmd}\n`);
        showHelp();
        process.exit(1);
    }
})().catch((e) => {
    process.stderr.write(`[atlas-mcp] ${e.message}\n`);
    process.exit(1);
});
