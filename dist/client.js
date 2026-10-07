import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
/**
 * Thin client over the Atlas REST API with a file-backed read cache (stale-while-revalidate,
 * near-offline) and a write queue that flushes when the network returns. All auth/scope
 * enforcement and audit happen server-side — this is just a fast, resilient edge cache.
 */
const CACHE_DIR = join(homedir(), ".atlas", "cache");
const QUEUE_FILE = join(homedir(), ".atlas", "queue.json");
const TTL_MS = 60_000;
const TIMEOUT_MS = 30_000;
function ensureDir() {
    if (!existsSync(CACHE_DIR))
        mkdirSync(CACHE_DIR, { recursive: true });
}
function cacheKey(path) {
    return join(CACHE_DIR, encodeURIComponent(path) + ".json");
}
function log(msg) {
    // NEVER write to stdout — it corrupts the stdio JSON-RPC stream. stderr only.
    process.stderr.write(`[atlas-mcp] ${msg}\n`);
}
/** What a failed HTTP call means for the person at the keyboard (the agent reads this text). */
export function httpErrorMessage(status, body, retryAfter) {
    const detail = body.trim().slice(0, 300);
    if (status === 401)
        return "Atlas rejected the key (401). It may be revoked or expired — create a new MCP key in Atlas → Settings → API keys and update ATLAS_MCP_KEY.";
    if (status === 403)
        return `The key is not allowed to do that (403): ${detail || "missing scope or role"}. Ask for a key with the right toolsets, or a role that can.`;
    if (status === 404)
        return `Not found (404): ${detail || "the item or project does not exist, or this key cannot see it"}.`;
    if (status === 409)
        return `Conflict (409): ${detail || "Atlas moved on — read it again and retry"}.`;
    if (status === 413)
        return "Too large for Atlas (413). Send less at once.";
    if (status === 429)
        return `Rate limited (429)${retryAfter ? ` — retry in ${retryAfter}s` : ""}. Slow down for a moment.`;
    if (status >= 500)
        return `Atlas had a server problem (${status}). Try again shortly.`;
    return `${status} ${detail}`.trim();
}
/** A network failure in plain words (fetch's "fetch failed" says nothing). */
export function networkErrorMessage(e, baseUrl) {
    const err = e;
    if (err?.name === "TimeoutError" || err?.name === "AbortError")
        return `Atlas did not answer within ${TIMEOUT_MS / 1000}s (${baseUrl}).`;
    const code = err?.cause?.code ?? err?.cause?.errors?.[0]?.code; // Node reports a refused dual-stack connect as an AggregateError
    if (code === "ENOTFOUND")
        return `Cannot find ${baseUrl} — check ATLAS_BASE_URL and your network.`;
    if (code === "ECONNREFUSED")
        return `Connection refused by ${baseUrl} — is Atlas running?`;
    return `Cannot reach Atlas at ${baseUrl}: ${err?.message ?? String(e)}`;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export class AtlasClient {
    baseUrl;
    apiKey;
    constructor(baseUrl, apiKey) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
    }
    /** fetch with a timeout and ONE retry for a network failure or a 5xx — only for calls that are safe to repeat. */
    async send(path, init, retry) {
        const once = () => fetch(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
        try {
            const res = await once();
            if (retry && res.status >= 500) {
                await wait(400);
                return await once();
            }
            return res;
        }
        catch (e) {
            if (!retry)
                throw new Error(networkErrorMessage(e, this.baseUrl));
            await wait(400);
            try {
                return await once();
            }
            catch (e2) {
                throw new Error(networkErrorMessage(e2, this.baseUrl));
            }
        }
    }
    async fail(res) {
        throw new Error(httpErrorMessage(res.status, await res.text(), res.headers.get("retry-after")));
    }
    /**
     * JSON-RPC to the remote MCP endpoint (`/api/mcp`) — how the stdio bridge serves prompts, resources and
     * completions. Reads only, so one retry is safe.
     */
    async rpc(method, params = {}) {
        const res = await this.send("/api/mcp", { method: "POST", headers: this.headers(), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }, true);
        const body = await res.json().then((j) => j).catch(() => null);
        if (body?.error)
            throw new Error(body.error.message);
        if (!res.ok || !body)
            return this.fail(res);
        return body.result;
    }
    headers() {
        return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
    }
    /** Cached GET: serve fresh cache; otherwise fetch, falling back to stale cache when offline. */
    async get(path, opts = { cache: true }) {
        ensureDir();
        const file = cacheKey(path);
        // fresh = always ask Atlas first, but still keep a copy and fall back to it offline (the tool manifest)
        if (opts.cache && !opts.fresh && existsSync(file)) {
            try {
                const { at, data } = JSON.parse(readFileSync(file, "utf8"));
                if (Date.now() - at < TTL_MS)
                    return data;
            }
            catch {
                /* ignore */
            }
        }
        try {
            const res = await this.send(path, { headers: this.headers() }, true);
            if (!res.ok)
                await this.fail(res);
            const data = (await res.json());
            if (opts.cache)
                writeFileSync(file, JSON.stringify({ at: Date.now(), data }));
            return data;
        }
        catch (e) {
            // offline / error → serve stale cache if we have it
            if (existsSync(file)) {
                try {
                    log(`offline — serving stale cache for ${path}`);
                    return JSON.parse(readFileSync(file, "utf8")).data;
                }
                catch {
                    /* ignore */
                }
            }
            throw e;
        }
    }
    /** POST that queues on failure (offline) and flushes later. */
    async post(path, body, opts = {}) {
        try {
            const res = await this.send(path, { method: "POST", headers: this.headers(), body: JSON.stringify(body) }, false);
            if (!res.ok)
                await this.fail(res);
            return (await res.json());
        }
        catch (e) {
            if (opts.queue) {
                ensureDir();
                const q = existsSync(QUEUE_FILE) ? JSON.parse(readFileSync(QUEUE_FILE, "utf8")) : [];
                q.push({ path, body, at: Date.now() });
                writeFileSync(QUEUE_FILE, JSON.stringify(q));
                log(`offline — queued POST ${path} (${q.length} pending)`);
                return { queued: true };
            }
            throw e;
        }
    }
    /** PATCH (no queue — task updates should fail loudly if offline). */
    async patch(path, body) {
        const res = await this.send(path, { method: "PATCH", headers: this.headers(), body: JSON.stringify(body) }, false);
        if (!res.ok)
            await this.fail(res);
        return (await res.json());
    }
    /** Flush any queued writes (best-effort, called on startup). */
    async flushQueue() {
        if (!existsSync(QUEUE_FILE))
            return;
        let q = [];
        try {
            q = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
        }
        catch {
            return;
        }
        const remaining = [];
        for (const item of q) {
            try {
                const res = await fetch(`${this.baseUrl}${item.path}`, {
                    method: "POST",
                    headers: this.headers(),
                    body: JSON.stringify(item.body),
                });
                if (!res.ok)
                    remaining.push(item);
            }
            catch {
                remaining.push(item);
            }
        }
        writeFileSync(QUEUE_FILE, JSON.stringify(remaining));
        if (q.length && remaining.length < q.length)
            log(`flushed ${q.length - remaining.length} queued writes`);
    }
}
