import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CompleteRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourceTemplatesRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { AtlasClient } from "./client.js";
/** Thin local bridge — tool catalog and handlers live on the Atlas server (auto-sync on every connect). */
export const CLIENT_VERSION = "0.7.0";
/** How often the tool list is re-read, so a server deploy shows up without restarting the IDE. */
const MANIFEST_REFRESH_MS = 5 * 60_000;
const dynamicInput = z.object({}).passthrough();
// these span every project the key reaches (task tools take the project from the task itself)
const NO_PROJECT_DEFAULT = new Set([
    "atlas_whoami",
    "atlas_list_projects",
    "atlas_create_project",
    "atlas_log_work",
    "atlas_my_tasks",
    "atlas_deployments",
    "atlas_deploy_action",
    "atlas_dokploy_api_search",
    "atlas_dokploy_api_call",
    "atlas_chat_send",
]);
function log(m) {
    process.stderr.write(`[atlas-mcp] ${m}\n`);
}
async function readLocalFile(repoRoot, localPath) {
    const abs = resolve(repoRoot, localPath);
    const rel = relative(resolve(repoRoot), abs);
    if (rel.startsWith(".."))
        throw new Error("localPath must stay inside the repo");
    return readFile(abs, "utf-8");
}
/** The bound project (.atlas / the key's first) for every tool that takes one and wasn't given one — e.g. atlas_uptime check=. */
export function withDefaultProject(args, boundRef, toolName) {
    if (!boundRef || NO_PROJECT_DEFAULT.has(toolName))
        return args;
    if (typeof args.project === "string" && args.project.trim())
        return args;
    if (typeof args.projectId === "string" && args.projectId.trim())
        return args;
    return { ...args, project: boundRef };
}
async function resolveLocalPath(toolName, args, cwd) {
    if (toolName !== "atlas_write")
        return args;
    const localPath = args.localPath;
    if (typeof localPath !== "string" || !localPath.trim())
        return args;
    const content = await readLocalFile(cwd, localPath);
    const { localPath: _drop, ...rest } = args;
    return { ...rest, content };
}
/** The text, then any images as image content (the agent sees them). Keep in sync with mcpContent in the server's format.ts. */
function toMcpContent(result) {
    let text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    if (result && typeof result === "object" && "format" in result && "body" in result) {
        const r = result;
        text = `${r.body}${r.meta ? `\n\n---\n${JSON.stringify(r.meta)}` : ""}`;
    }
    const images = result?.images ?? [];
    return {
        content: [{ type: "text", text }, ...images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }))],
    };
}
/**
 * Prompts, resources and completions live on the remote endpoint; forwarding them here gives stdio-only clients
 * (Claude Desktop, Codex, Gemini CLI…) the same MCP surface as a URL config. Every call is read-only and goes
 * through the key, so scopes and per-item access apply on the server.
 */
export function registerRemoteHandlers(server, client) {
    server.server.registerCapabilities({ prompts: { listChanged: false }, resources: { listChanged: false, subscribe: false }, completions: {} });
    const forward = (method) => async (req) => (await client.rpc(method, req.params ?? {}));
    const h = server.server.setRequestHandler.bind(server.server);
    h(ListPromptsRequestSchema, forward("prompts/list"));
    h(GetPromptRequestSchema, forward("prompts/get"));
    h(ListResourcesRequestSchema, forward("resources/list"));
    h(ListResourceTemplatesRequestSchema, forward("resources/templates/list"));
    h(ReadResourceRequestSchema, forward("resources/read"));
    h(CompleteRequestSchema, forward("completion/complete"));
}
/** The MCP server for one connection: the manifest's tools plus the remote prompts / resources / completions. */
export function buildServer(client, manifest, boundRef, cwd) {
    const server = new McpServer({ name: "atlas", version: manifest.version }, { instructions: manifest.instructions + (boundRef ? ` Bound project: ${boundRef}.` : "") });
    const registered = new Map();
    const sigOf = (t) => JSON.stringify([t.title, t.description, t.annotations]);
    const add = (tool) => {
        const reg = server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: dynamicInput, annotations: tool.annotations }, async (args) => {
            try {
                let resolved = withDefaultProject(args, boundRef, tool.name);
                resolved = await resolveLocalPath(tool.name, resolved, cwd);
                const out = await client.post("/api/v1/mcp/call", {
                    name: tool.name,
                    arguments: resolved,
                });
                if ("queued" in out)
                    return toMcpContent("Queued — will flush when online.");
                return toMcpContent(out.result);
            }
            catch (e) {
                return { ...toMcpContent(e.message), isError: true };
            }
        });
        registered.set(tool.name, { sig: sigOf(tool), tool: reg });
    };
    /** Make the registered tools match the manifest; connected clients are told the list changed. */
    const syncTools = (tools) => {
        const names = new Set(tools.map((t) => t.name));
        for (const [name, r] of registered) {
            if (!names.has(name)) {
                r.tool.remove();
                registered.delete(name);
            }
        }
        for (const t of tools) {
            const have = registered.get(t.name);
            if (!have)
                add(t);
            else if (have.sig !== sigOf(t)) {
                have.tool.update({ title: t.title, description: t.description, annotations: t.annotations });
                have.sig = sigOf(t);
            }
        }
    };
    syncTools(manifest.tools);
    registerRemoteHandlers(server, client);
    return { server, syncTools };
}
export async function runServer() {
    const { baseUrl, apiKey, config, cwd } = loadConfig();
    if (!apiKey) {
        log("No ATLAS_MCP_KEY set. Run: npx -y github:Nara-Virtual/atlas-mcp install --key atlas_mcp_…");
        process.exit(1);
    }
    const client = new AtlasClient(baseUrl, apiKey);
    // fresh from Atlas when reachable; the last copy when it is not, so an IDE opened offline still has its tools
    let manifest;
    try {
        manifest = await client.get("/api/v1/mcp/manifest", { cache: true, fresh: true });
    }
    catch (e) {
        log(`Could not load MCP manifest from ${baseUrl}: ${e.message}`);
        process.exit(1);
    }
    await client.flushQueue().catch(() => { });
    // Resolve ~/.atlas default project name for optional projectId injection
    let boundRef = config.project?.trim() || undefined;
    if (!boundRef) {
        try {
            const who = await client.get("/api/v1/whoami", { cache: false });
            boundRef = who.projects[0]?.name ?? who.projects[0]?.id;
        }
        catch {
            /* optional */
        }
    }
    log(`server MCP v${manifest.version} · client v${CLIENT_VERSION} · ${manifest.tools.length} tools · project=${boundRef ?? "none"}`);
    const { server, syncTools } = buildServer(client, manifest, boundRef, cwd);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // a deploy that adds or changes tools reaches this session within minutes, no restart
    setInterval(() => {
        client
            .get("/api/v1/mcp/manifest", { cache: true, fresh: true })
            .then((m) => syncTools(m.tools))
            .catch(() => { });
    }, MANIFEST_REFRESH_MS).unref();
    log(`ready (cwd=${cwd}) — tools synced from server, prompts / resources / completions forwarded`);
}
