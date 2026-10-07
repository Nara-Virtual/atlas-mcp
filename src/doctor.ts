import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { AtlasClient, networkErrorMessage } from "./client.js";
import { loadConfig } from "./config.js";
import { hasAtlas, targets } from "./clients.js";
import { CLIENT_VERSION, type McpManifest } from "./index.js";

type Line = { ok: boolean | "warn"; text: string };

/** `atlas doctor`: every reason "it doesn't connect" in one pass, each with what to do about it. Exit 1 on a failure. */
export async function doctor(): Promise<number> {
  const lines: Line[] = [];
  const say = (ok: Line["ok"], text: string) => lines.push({ ok, text });
  const { baseUrl, apiKey, config } = loadConfig();

  say(true, `atlas-mcp client v${CLIENT_VERSION} · Node ${process.versions.node}`);
  if (Number(process.versions.node.split(".")[0]) < 18) say(false, "Node 18 or newer is required.");

  // 1. reachable
  const t0 = Date.now();
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(10_000) });
    say(res.ok, res.ok ? `Atlas reachable at ${baseUrl} (${Date.now() - t0} ms)` : `Atlas answered ${res.status} at ${baseUrl}/api/health`);
  } catch (e) {
    say(false, networkErrorMessage(e, baseUrl));
  }

  // 2. key
  if (!apiKey) say(false, "No key: set ATLAS_MCP_KEY (Atlas → Settings → API keys → MCP key) or run `atlas install --key atlas_mcp_…`.");
  else {
    say(true, `Key present (${apiKey.slice(0, 10)}…)`);
    const client = new AtlasClient(baseUrl, apiKey);
    try {
      const who = await client.get<{ scopes: string[]; toolsets: string[]; readOnly: boolean; projects: { id: string; name: string }[] }>("/api/v1/whoami", { cache: false });
      say(true, `Signed in · ${who.projects.length} project${who.projects.length === 1 ? "" : "s"}${who.readOnly ? " · read-only key" : ""} · toolsets: ${who.toolsets.join(", ") || "all"}`);
      if (config.project) {
        const found = who.projects.some((p) => p.name.toLowerCase() === config.project!.toLowerCase() || p.id === config.project);
        say(found ? true : "warn", found ? `Bound project "${config.project}" is reachable` : `Bound project "${config.project}" is not one this key reaches — fix ~/.atlas/config.json or .atlas`);
      } else say("warn", "No bound project (~/.atlas/config.json or .atlas) — the first project of the key is used");
    } catch (e) {
      say(false, (e as Error).message);
    }
    try {
      const m = await client.get<McpManifest>("/api/v1/mcp/manifest", { cache: false });
      say(true, `Tools: ${m.tools.length} (server MCP v${m.version})`);
      // the server's number is its tool surface, versioned apart from this client: only an OLDER client is worth a warning
      const mm = (v: string) => v.split(".").slice(0, 2).map(Number) as [number, number];
      const [sa, sb] = mm(m.version);
      const [ca, cb] = mm(CLIENT_VERSION);
      if (ca < sa || (ca === sa && cb < sb)) say("warn", `This client (v${CLIENT_VERSION}) is older than the server (v${m.version}) — run \`atlas update\`.`);
    } catch (e) {
      say(false, `Tool manifest: ${(e as Error).message}`);
    }
    try {
      const p = await client.rpc<{ prompts: unknown[] }>("prompts/list");
      const r = await client.rpc<{ resources: unknown[] }>("resources/list");
      say(true, `Prompts ${p.prompts?.length ?? 0} · resources ${r.resources?.length ?? 0} (forwarded through the bridge)`);
    } catch (e) {
      say("warn", `Prompts / resources: ${(e as Error).message}`);
    }
  }

  // 3. local state
  const dir = join(homedir(), ".atlas");
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, ".doctor");
    writeFileSync(probe, "ok");
    rmSync(probe);
    say(true, `Local cache writable (${dir})`);
  } catch (e) {
    say(false, `Cannot write ${dir}: ${(e as Error).message} — the offline cache and write queue need it.`);
  }
  const queue = join(dir, "queue.json");
  if (existsSync(queue)) {
    try {
      const n = (JSON.parse(readFileSync(queue, "utf8")) as unknown[]).length;
      if (n) say("warn", `${n} queued write${n === 1 ? "" : "s"} waiting to be sent (they flush on the next connect)`);
    } catch {
      say("warn", `${queue} is unreadable`);
    }
  }

  // 4. which clients are wired up
  const wired = targets().filter((t) => hasAtlas(t));
  const missing = targets().filter((t) => !hasAtlas(t));
  say(wired.length ? true : "warn", wired.length ? `Configured in: ${wired.map((t) => t.name.split(" (")[0]).join(", ")}` : "No AI client has an atlas server yet — run `atlas install --key atlas_mcp_…`.");
  if (wired.length && missing.length) say(true, `Not configured: ${missing.map((t) => t.name.split(" (")[0]).join(", ")} (only matters if you use them)`);

  for (const l of lines) process.stderr.write(`  ${l.ok === true ? "✓" : l.ok === "warn" ? "!" : "✗"} ${l.text}\n`);
  const bad = lines.filter((l) => l.ok === false).length;
  process.stderr.write(bad ? `\n${bad} problem${bad === 1 ? "" : "s"} found.\n` : "\nAll good.\n");
  return bad ? 1 : 0;
}
