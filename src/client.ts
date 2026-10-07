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

function ensureDir() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}
function cacheKey(path: string) {
  return join(CACHE_DIR, encodeURIComponent(path) + ".json");
}
function log(msg: string) {
  // NEVER write to stdout — it corrupts the stdio JSON-RPC stream. stderr only.
  process.stderr.write(`[atlas-mcp] ${msg}\n`);
}

export class AtlasClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  private headers() {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  /** Cached GET: serve fresh cache; otherwise fetch, falling back to stale cache when offline. */
  async get<T = unknown>(path: string, opts: { cache?: boolean } = { cache: true }): Promise<T> {
    ensureDir();
    const file = cacheKey(path);
    if (opts.cache && existsSync(file)) {
      try {
        const { at, data } = JSON.parse(readFileSync(file, "utf8"));
        if (Date.now() - at < TTL_MS) return data as T;
      } catch {
        /* ignore */
      }
    }
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers() });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const data = (await res.json()) as T;
      if (opts.cache) writeFileSync(file, JSON.stringify({ at: Date.now(), data }));
      return data;
    } catch (e) {
      // offline / error → serve stale cache if we have it
      if (existsSync(file)) {
        try {
          log(`offline — serving stale cache for ${path}`);
          return JSON.parse(readFileSync(file, "utf8")).data as T;
        } catch {
          /* ignore */
        }
      }
      throw e;
    }
  }

  /** POST that queues on failure (offline) and flushes later. */
  async post<T = unknown>(path: string, body: unknown, opts: { queue?: boolean } = {}): Promise<T | { queued: true }> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return (await res.json()) as T;
    } catch (e) {
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
  async patch<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  /** Flush any queued writes (best-effort, called on startup). */
  async flushQueue(): Promise<void> {
    if (!existsSync(QUEUE_FILE)) return;
    let q: { path: string; body: unknown }[] = [];
    try {
      q = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
    } catch {
      return;
    }
    const remaining: typeof q = [];
    for (const item of q) {
      try {
        const res = await fetch(`${this.baseUrl}${item.path}`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(item.body),
        });
        if (!res.ok) remaining.push(item);
      } catch {
        remaining.push(item);
      }
    }
    writeFileSync(QUEUE_FILE, JSON.stringify(remaining));
    if (q.length && remaining.length < q.length) log(`flushed ${q.length - remaining.length} queued writes`);
  }
}
