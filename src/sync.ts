import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, unlinkSync, appendFileSync, watch as fsWatch } from "node:fs";
import { join, dirname, relative, basename } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.js";
import { parseArgs } from "./env.js";

/**
 * `atlas sync …` — keep a local folder's markdown docs, prompt files and code files in step with an
 * Atlas project. `.atlas.sync.json` (commit it) says which globs go where; `.atlas.sync-state.json`
 * (gitignored) remembers, per file, the content hash and the Atlas rev it was last in sync at. From
 * those three facts (local hash, remote rev, remembered base) every file is: in sync, changed here,
 * changed in Atlas, new on one side, deleted on one side, or changed on BOTH (a conflict). Conflicts
 * are never overwritten silently: pick --ours / --theirs per file or answer the prompt. Deletions only
 * propagate with --delete. Atlas also refuses a push whose base rev is stale (a race is a conflict too).
 */

const say = (m: string) => process.stderr.write(m + "\n");

type Kind = "doc" | "prompt" | "code";
const KIND_OF: Record<string, Kind> = { docs: "doc", doc: "doc", prompts: "prompt", prompt: "prompt", code: "code" };
const KIND_LABEL: Record<Kind, string> = { doc: "doc", prompt: "prompt", code: "code" };

export const CONFIG_FILE = ".atlas.sync.json";
export const STATE_FILE = ".atlas.sync-state.json";
const DEFAULT_MAX_BYTES = 256 * 1024;
const ALWAYS_SKIP = /(^|\/)(\.git|node_modules|\.next|dist|build|\.turbo|\.venv|__pycache__)(\/|$)/;

type SyncConfig = { project?: string; mappings: Record<string, string>; maxBytes?: number; ignore?: string[] };
type StateEntry = { kind: Kind; id: string; hash: string; rev: string };
type State = { project?: string; files: Record<string, StateEntry> };
type Remote = { kind: Kind; id: string; name: string; path: string | null; rev: string; hash: string | null };
type Local = { kind: Kind; content: string; hash: string; base: string };

/* ---------------- globs ---------------- */

/** `**` any depth, `*` / `?` within a segment, `{a,b}` alternatives. Paths use `/`. */
export function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") re += "(?:";
    else if (c === "}") re += ")";
    else if (c === ",") re += glob.slice(0, i).lastIndexOf("{") > glob.slice(0, i).lastIndexOf("}") ? "|" : ",";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Static folder prefix of a glob: "docs/**\/*.md" → "docs/". */
export function globBase(glob: string): string {
  const parts = glob.split("/");
  const i = parts.findIndex((p) => /[*?{]/.test(p));
  return i <= 0 ? "" : parts.slice(0, i).join("/") + "/";
}

/* ---------------- files ---------------- */

function findRoot(start = process.cwd()): string | null {
  let dir = start;
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Every file under root that git wouldn't ignore (falls back to a plain walk outside git). */
function listFiles(root: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
    return out.split("\0").filter((p) => p && existsSync(join(root, p)) && !ALWAYS_SKIP.test(p));
  } catch {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        const rel = relative(root, abs).split("\\").join("/");
        if (ALWAYS_SKIP.test(rel)) continue;
        const st = statSync(abs);
        if (st.isDirectory()) walk(abs);
        else if (st.isFile()) out.push(rel);
      }
    };
    walk(root);
    return out;
  }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function readJson<T>(p: string, fallback: T): T {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

function mappings(cfg: SyncConfig): { glob: string; re: RegExp; kind: Kind; base: string }[] {
  return Object.entries(cfg.mappings ?? {}).flatMap(([glob, v]) => {
    const kind = KIND_OF[v];
    if (!kind) {
      say(`  · ignoring mapping "${glob}": "${v}" (use docs | prompts | code)`);
      return [];
    }
    return [{ glob, re: globToRegex(glob), kind, base: globBase(glob) }];
  });
}

function scanLocal(root: string, cfg: SyncConfig): { files: Map<string, Local>; skipped: string[] } {
  const maps = mappings(cfg);
  const ignore = (cfg.ignore ?? []).map(globToRegex);
  const max = cfg.maxBytes ?? DEFAULT_MAX_BYTES;
  const files = new Map<string, Local>();
  const skipped: string[] = [];
  for (const rel of listFiles(root)) {
    if (rel.startsWith(".atlas") || ignore.some((r) => r.test(rel))) continue;
    const m = maps.find((x) => x.re.test(rel));
    if (!m) continue;
    const size = statSync(join(root, rel)).size;
    if (size > max) {
      skipped.push(`${rel} (${Math.round(size / 1024)} KB > ${Math.round(max / 1024)} KB cap)`);
      continue;
    }
    const content = readFileSync(join(root, rel), "utf8");
    if (content.includes("\0")) {
      skipped.push(`${rel} (binary)`);
      continue;
    }
    files.set(rel, { kind: m.kind, content, hash: sha(content), base: m.base });
  }
  return { files, skipped };
}

/* ---------------- markdown title ---------------- */

const titleFromFile = (path: string) => basename(path).replace(/\.[^.]+$/, "").replace(/[-_]/g, " ").trim() || basename(path);

/** A leading `# Heading` is the title (and is not repeated in the body); otherwise the file name. */
function splitTitle(path: string, content: string): { title: string; body: string } {
  const m = /^\s*#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(content);
  if (m) return { title: m[1].trim().slice(0, 120), body: content.slice(m[0].length).replace(/^\s*\n/, "") };
  return { title: titleFromFile(path), body: content };
}

function joinTitle(path: string, title: string, body: string): string {
  const text = title === titleFromFile(path) ? body : `# ${title}\n\n${body}`;
  return text.endsWith("\n") ? text : text + "\n";
}

const safeSegment = (s: string) => s.replace(/[\\/:*?"<>|]/g, "-").trim() || "untitled";
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled";

/* ---------------- http ---------------- */

type Ctx = { base: string; key: string; project: string; root: string; cfg: SyncConfig };

function ctx(flags: Record<string, string | true>): Ctx {
  const root = findRoot();
  if (!root) throw new Error(`No ${CONFIG_FILE} here or above — run \`atlas sync init\` first`);
  const cfg = readJson<SyncConfig>(join(root, CONFIG_FILE), { mappings: {} });
  const { baseUrl, apiKey, config } = loadConfig();
  const key = (typeof flags.key === "string" ? flags.key : null) ?? apiKey;
  const project = (typeof flags.project === "string" ? flags.project : null) ?? cfg.project ?? process.env.ATLAS_PROJECT ?? config.project;
  const base = ((typeof flags["base-url"] === "string" ? flags["base-url"] : null) ?? baseUrl).replace(/\/$/, "");
  if (!key) throw new Error("No API key — set ATLAS_API_KEY (docs/prompts/code read+write scopes) or pass --key");
  if (!project) throw new Error(`No project — set "project" in ${CONFIG_FILE} or pass --project`);
  return { base, key, project, root, cfg };
}

async function api<T>(c: Ctx, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${c.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${c.key}`, "User-Agent": "atlas-cli", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Can't reach Atlas at ${c.base}`);
  }
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* not json */
    }
    throw new Error(`${method} ${path.split("?")[0]} failed: ${msg}`);
  }
  return (await res.json()) as T;
}

/* ---------------- plan ---------------- */

type Action =
  | "clean"
  | "push-new" // only here
  | "push" // changed here
  | "pull-new" // only in Atlas
  | "pull" // changed in Atlas
  | "conflict" // changed on both sides (or deleted on one, changed on the other)
  | "local-deleted" // deleted here, unchanged in Atlas
  | "remote-deleted" // deleted in Atlas, unchanged here
  | "gone"; // deleted on both sides

type Entry = { path: string; kind: Kind; action: Action; local?: Local; remote?: Remote; state?: StateEntry; why?: string };

function localPathFor(r: Remote, maps: ReturnType<typeof mappings>): string | null {
  if (r.path) return r.path;
  const m = maps.find((x) => x.kind === r.kind);
  if (!m) return null;
  if (r.kind === "code") return r.name;
  if (r.kind === "doc") return m.base + r.name.split("/").map(safeSegment).join("/") + ".md";
  return `${m.base}${slug(r.name)}.md`;
}

async function plan(c: Ctx): Promise<{ entries: Entry[]; state: State; skipped: string[] }> {
  const maps = mappings(c.cfg);
  const kinds = [...new Set(maps.map((m) => m.kind))];
  if (!kinds.length) throw new Error(`${CONFIG_FILE} has no mappings`);
  const state = readJson<State>(join(c.root, STATE_FILE), { files: {} });
  if (state.project && state.project !== c.project) {
    say(`  · state was for project "${state.project}" — starting fresh for "${c.project}"`);
    state.files = {};
  }
  state.project = c.project;
  const { files, skipped } = scanLocal(c.root, c.cfg);
  const manifest = await api<{ items: Remote[] }>(c, "GET", `/api/v1/sync?projectId=${encodeURIComponent(c.project)}&kinds=${kinds.join(",")}`);

  const remoteByPath = new Map<string, Remote>();
  const remoteById = new Map<string, Remote>();
  for (const r of manifest.items) {
    remoteById.set(`${r.kind}:${r.id}`, r);
    let p = localPathFor(r, maps);
    // only items that land inside a mapping of their own kind are in scope
    if (!p || !maps.some((m) => m.kind === r.kind && m.re.test(p!))) continue;
    for (let n = 2; remoteByPath.has(p); n++) p = p.replace(/(-\d+)?(\.[^./]+)$/, `-${n}$2`);
    remoteByPath.set(p, r);
  }
  // a tracked item keeps its tracked path even if Atlas would name it differently
  for (const [p, s] of Object.entries(state.files)) {
    const r = remoteById.get(`${s.kind}:${s.id}`);
    if (!r) continue;
    for (const [q, x] of remoteByPath) if (x === r && q !== p) remoteByPath.delete(q);
    remoteByPath.set(p, r);
  }

  const paths = new Set([...files.keys(), ...remoteByPath.keys(), ...Object.keys(state.files)]);
  const entries: Entry[] = [];
  for (const path of [...paths].sort()) {
    const local = files.get(path);
    const s = state.files[path];
    // a tracked item that was deleted in Atlas is simply missing from the manifest
    const remote = remoteByPath.get(path);
    const kind = (local?.kind ?? remote?.kind ?? s?.kind)!;
    const e: Entry = { path, kind, local, remote, state: s, action: "clean" };
    const lc = local && s ? local.hash !== s.hash : !!local;
    const rc = remote && s ? remote.rev !== s.rev : !!remote;
    if (local && remote) {
      if (remote.hash && remote.hash === local.hash) e.action = "clean"; // Atlas holds exactly this content
      else if (!s) [e.action, e.why] = ["conflict", "exists on both sides, not synced before"];
      else if (lc && rc) [e.action, e.why] = ["conflict", "changed here and in Atlas"];
      else e.action = lc ? "push" : rc ? "pull" : "clean";
    } else if (local) {
      if (!s) e.action = "push-new";
      else if (lc) [e.action, e.why] = ["conflict", "changed here, deleted in Atlas"];
      else e.action = "remote-deleted";
    } else if (remote) {
      if (!s) e.action = "pull-new";
      else if (rc) [e.action, e.why] = ["conflict", "deleted here, changed in Atlas"];
      else e.action = "local-deleted";
    } else e.action = "gone";
    entries.push(e);
    if (e.action === "gone") delete state.files[path];
    // Atlas holds exactly this content (e.g. a fresh clone of a synced repo): that's the base now
    if (e.action === "clean" && local && remote && remote.hash === local.hash) state.files[path] = { kind, id: remote.id, hash: local.hash, rev: remote.rev };
  }
  return { entries, state, skipped };
}

/* ---------------- apply ---------------- */

type Flags = Record<string, string | true>;

function resolution(flags: Flags, path: string): "ours" | "theirs" | null {
  const has = (f: string) => flags[f] === true || (typeof flags[f] === "string" && (flags[f] as string).split(",").map((s) => s.trim()).includes(path));
  if (has("ours")) return "ours";
  if (has("theirs")) return "theirs";
  return null;
}

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const a = (await rl.question(q)).trim().toLowerCase();
  rl.close();
  return a;
}

const MARK: Record<Action, string> = {
  clean: " ",
  "push-new": "+",
  push: "↑",
  "pull-new": "+",
  pull: "↓",
  conflict: "!",
  "local-deleted": "-",
  "remote-deleted": "-",
  gone: " ",
};
const DESC: Record<Action, string> = {
  clean: "in sync",
  "push-new": "new here → push",
  push: "changed here → push",
  "pull-new": "new in Atlas → pull",
  pull: "changed in Atlas → pull",
  conflict: "conflict",
  "local-deleted": "deleted here (push --delete removes it from Atlas)",
  "remote-deleted": "deleted in Atlas (pull --delete removes the local file)",
  gone: "deleted on both sides",
};

function printEntries(entries: Entry[], only?: (e: Entry) => boolean) {
  const list = entries.filter((e) => e.action !== "clean" && e.action !== "gone" && (!only || only(e)));
  const w = Math.min(60, Math.max(...list.map((e) => e.path.length), 10));
  for (const e of list) say(`  ${MARK[e.action]} ${e.path.padEnd(w)}  ${KIND_LABEL[e.kind].padEnd(6)} ${DESC[e.action]}${e.why ? ` — ${e.why}` : ""}`);
}

function summary(entries: Entry[]): string {
  const n = (a: Action[]) => entries.filter((e) => a.includes(e.action)).length;
  return [
    `${n(["clean"])} in sync`,
    `${n(["push", "push-new"])} to push`,
    `${n(["pull", "pull-new"])} to pull`,
    `${n(["conflict"])} conflict(s)`,
    `${n(["local-deleted", "remote-deleted"])} deleted on one side`,
  ].join(" · ");
}

function saveState(c: Ctx, state: State) {
  writeFileSync(join(c.root, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
}

function pushPayload(e: Entry, force: boolean) {
  const l = e.local!;
  const md = e.kind !== "code" ? splitTitle(e.path, l.content) : null;
  return {
    kind: e.kind,
    path: e.path,
    content: md ? md.body : l.content,
    hash: l.hash,
    title: md?.title,
    treePath: e.kind === "doc" ? e.path.slice(l.base.length) : undefined,
    id: e.remote?.id ?? e.state?.id,
    baseRev: e.remote ? (force ? e.remote.rev : (e.state?.rev ?? null)) : null,
    force,
  };
}

type Work = { push: { e: Entry; force: boolean }[]; pull: Entry[]; delRemote: Entry[]; delLocal: Entry[] };

async function run(mode: "push" | "pull", flags: Flags, opts: { quiet?: boolean } = {}): Promise<void> {
  const c = ctx(flags);
  const { entries, state, skipped } = await plan(c);
  const del = !!flags.delete;
  const dry = !!flags["dry-run"];
  const w: Work = { push: [], pull: [], delRemote: [], delLocal: [] };

  for (const e of entries) {
    if (mode === "push" && (e.action === "push" || e.action === "push-new")) w.push.push({ e, force: false });
    if (mode === "pull" && (e.action === "pull" || e.action === "pull-new")) w.pull.push(e);
    if (mode === "push" && e.action === "local-deleted" && del) w.delRemote.push(e);
    if (mode === "pull" && e.action === "remote-deleted" && del) w.delLocal.push(e);
  }

  const conflicts = entries.filter((e) => e.action === "conflict");
  const unresolved: Entry[] = [];
  for (const e of conflicts) {
    let r = resolution(flags, e.path);
    if (!r && process.stdin.isTTY && !dry && !opts.quiet) {
      say(`\n! ${e.path} — ${e.why}`);
      const a = await ask(`  keep [o]urs (push this file) / [t]heirs (take Atlas's) / [s]kip? `);
      r = a.startsWith("o") ? "ours" : a.startsWith("t") ? "theirs" : null;
    }
    if (!r) unresolved.push(e);
    else if (r === "ours") {
      if (e.local) w.push.push({ e, force: true });
      else w.delRemote.push(e); // deleted here, keep it deleted
    } else if (e.remote) w.pull.push(e);
    else w.delLocal.push(e); // deleted in Atlas, take the deletion
  }

  if (!opts.quiet || w.push.length || w.pull.length || w.delRemote.length || w.delLocal.length || unresolved.length) {
    const label = { push: "push", pull: "pull" }[mode];
    say(`atlas sync ${label} · ${c.project}${dry ? " (dry run)" : ""}`);
    for (const { e, force } of w.push) say(`  ↑ ${e.path}  ${KIND_LABEL[e.kind]}${force ? " (overwrite Atlas — ours)" : e.action === "push-new" ? " (new)" : ""}`);
    for (const e of w.pull) say(`  ↓ ${e.path}  ${KIND_LABEL[e.kind]}${e.action === "conflict" ? " (overwrite local — theirs)" : e.action === "pull-new" ? " (new)" : ""}`);
    for (const e of w.delRemote) say(`  - ${e.path}  delete in Atlas`);
    for (const e of w.delLocal) say(`  - ${e.path}  delete local file`);
    for (const e of unresolved) say(`  ! ${e.path}  conflict — ${e.why}; re-run with --ours ${e.path} or --theirs ${e.path}`);
    const other = entries.filter((e) => (mode === "push" ? ["pull", "pull-new"] : ["push", "push-new"]).includes(e.action)).length;
    if (other) say(`  · ${other} file(s) to ${mode === "push" ? "pull" : "push"} — run \`atlas sync ${mode === "push" ? "pull" : "push"}\``);
    const deletions = entries.filter((e) => e.action === (mode === "push" ? "local-deleted" : "remote-deleted")).length;
    if (deletions && !del) say(`  · ${deletions} deletion(s) not applied — add --delete`);
    if (skipped.length && !opts.quiet) say(`  · skipped ${skipped.length}: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? "…" : ""}`);
  }
  if (unresolved.length) process.exitCode = 1;

  const total = w.push.length + w.pull.length + w.delRemote.length + w.delLocal.length;
  if (!total) {
    saveState(c, state);
    if (!opts.quiet) say("  nothing to do");
    return;
  }
  if (dry) return;
  if (!flags.yes) {
    if (!process.stdin.isTTY) {
      say("  · not applied (non-interactive: pass --yes)");
      process.exitCode = 1;
      return;
    }
    if (!["y", "yes"].includes(await ask(`Apply ${total} change(s)? [y/N] `))) {
      say("  · cancelled");
      return;
    }
  }

  let ok = 0;
  let failed = 0;
  // push in chunks (count + payload size); deletes ride along
  const pushQ = w.push.map((x) => pushPayload(x.e, x.force));
  const delQ = w.delRemote.map((e) => ({ kind: e.kind, id: (e.remote ?? e.state)!.id, path: e.path, baseRev: e.remote?.rev ?? e.state?.rev ?? null, force: e.action === "conflict" }));
  while (pushQ.length || delQ.length) {
    const chunk: typeof pushQ = [];
    let bytes = 0;
    while (pushQ.length && chunk.length < 50 && bytes < 4_000_000) {
      const p = pushQ.shift()!;
      bytes += p.content.length;
      chunk.push(p);
    }
    const res = await api<{ items: { path: string; status: string; id?: string; rev?: string; error?: string }[]; deletes: { path: string; status: string; error?: string }[] }>(
      c,
      "POST",
      "/api/v1/sync/push",
      { projectId: c.project, items: chunk, deletes: delQ.splice(0, 50) },
    );
    for (const r of res.items) {
      const e = entries.find((x) => x.path === r.path)!;
      if ((r.status === "created" || r.status === "updated") && r.id && r.rev) {
        state.files[r.path] = { kind: e.kind, id: r.id, hash: e.local!.hash, rev: r.rev };
        ok++;
        say(`  ✓ ${r.path} ${r.status}`);
      } else {
        failed++;
        say(`  ✗ ${r.path} ${r.status === "conflict" ? "conflict — Atlas changed since you last synced; nothing written" : (r.error ?? r.status)}`);
      }
    }
    for (const d of res.deletes) {
      if (d.status === "deleted") {
        delete state.files[d.path];
        ok++;
        say(`  ✓ ${d.path} deleted in Atlas`);
      } else {
        failed++;
        say(`  ✗ ${d.path} ${d.status === "conflict" ? "changed in Atlas — not deleted" : (d.error ?? d.status)}`);
      }
    }
    saveState(c, state);
  }

  for (let i = 0; i < w.pull.length; i += 100) {
    const chunk = w.pull.slice(i, i + 100);
    const res = await api<{ items: ({ kind: Kind; id: string; rev: string; title: string; content: string } | { kind: Kind; id: string; error: string })[] }>(
      c,
      "POST",
      "/api/v1/sync/pull",
      { projectId: c.project, items: chunk.map((e) => ({ kind: e.kind, id: e.remote!.id })) },
    );
    for (const r of res.items) {
      const e = chunk.find((x) => x.remote!.id === r.id && x.kind === r.kind)!;
      if ("error" in r) {
        failed++;
        say(`  ✗ ${e.path} ${r.error}`);
        continue;
      }
      const text = r.kind === "code" ? r.content : joinTitle(e.path, r.title, r.content);
      const abs = join(c.root, e.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
      state.files[e.path] = { kind: e.kind, id: r.id, hash: sha(text), rev: r.rev };
      ok++;
      say(`  ✓ ${e.path} pulled`);
    }
    saveState(c, state);
  }

  for (const e of w.delLocal) {
    try {
      unlinkSync(join(c.root, e.path));
    } catch {
      /* already gone */
    }
    delete state.files[e.path];
    ok++;
    say(`  ✓ ${e.path} deleted locally`);
  }
  saveState(c, state);
  say(`${ok} applied${failed ? `, ${failed} failed` : ""}`);
  if (failed) process.exitCode = 1;
}

async function status(flags: Flags) {
  const c = ctx(flags);
  const { entries, skipped, state } = await plan(c);
  saveState(c, state); // only records bases for content Atlas already holds
  say(`atlas sync status · ${c.project} · ${c.root}`);
  printEntries(entries);
  say(summary(entries));
  if (skipped.length) say(`skipped ${skipped.length}: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? "…" : ""}`);
  if (entries.some((e) => e.action === "conflict")) say("Resolve conflicts with --ours <path> (keep local) or --theirs <path> (take Atlas), or answer the prompt on push/pull.");
}

/* ---------------- init ---------------- */

const CODE_EXT = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "rb", "java", "kt", "swift", "php", "cs", "c", "h", "cpp", "sh", "bash", "zsh", "sql", "css", "scss", "html", "vue", "svelte", "yaml", "yml", "toml"];

function detectMappings(root: string): Record<string, string> {
  const files = listFiles(root);
  const m: Record<string, string> = {};
  const dirHas = (d: string, re: RegExp) => files.some((f) => f.startsWith(d + "/") && re.test(f));
  for (const d of ["prompts", ".prompts", "ai/prompts"]) if (dirHas(d, /\.(md|txt)$/)) m[`${d}/**/*.{md,txt}`] = "prompts";
  if (dirHas("docs", /\.md$/)) m["docs/**/*.md"] = "docs";
  else if (files.some((f) => !f.includes("/") && f.endsWith(".md"))) m["*.md"] = "docs";
  for (const d of ["src", "lib", "app", "scripts", "sql", "migrations"]) {
    const exts = CODE_EXT.filter((x) => files.some((f) => f.startsWith(d + "/") && f.endsWith("." + x)));
    if (exts.length) m[`${d}/**/*.${exts.length === 1 ? exts[0] : `{${exts.join(",")}}`}`] = "code";
  }
  if (!Object.keys(m).length) m["**/*.md"] = "docs";
  return m;
}

function init(flags: Flags) {
  const root = process.cwd();
  const path = join(root, CONFIG_FILE);
  if (existsSync(path) && !flags.force) throw new Error(`${CONFIG_FILE} already exists (pass --force to overwrite)`);
  const { config } = loadConfig();
  const project = (typeof flags.project === "string" ? flags.project : null) ?? process.env.ATLAS_PROJECT ?? config.project ?? basename(root);
  const cfg: SyncConfig = { project, mappings: detectMappings(root), maxBytes: DEFAULT_MAX_BYTES, ignore: [] };
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  const gi = join(root, ".gitignore");
  if (existsSync(gi) && !readFileSync(gi, "utf8").split(/\r?\n/).includes(STATE_FILE)) appendFileSync(gi, `\n${STATE_FILE}\n`);
  const { files, skipped } = scanLocal(root, cfg);
  const count = (k: Kind) => [...files.values()].filter((f) => f.kind === k).length;
  say(`✓ wrote ${CONFIG_FILE} → project "${project}"`);
  for (const [g, k] of Object.entries(cfg.mappings)) say(`    ${g.padEnd(34)} → ${k}`);
  say(`  matched ${count("doc")} doc(s), ${count("prompt")} prompt(s), ${count("code")} code file(s)${skipped.length ? `; skipped ${skipped.length} over ${DEFAULT_MAX_BYTES / 1024} KB or binary` : ""}`);
  say(`  .gitignore'd files are never synced. ${STATE_FILE} holds hashes + revs only (keep it out of git).`);
  say(`  Next: atlas sync status   then   atlas sync push`);
}

/* ---------------- watch ---------------- */

async function watch(flags: Flags) {
  const c = ctx(flags);
  say(`watching ${c.root} → ${c.project} (${flags.yes ? "auto-push" : "confirm each push"}; conflicts are skipped, never overwritten) — Ctrl+C to stop`);
  let timer: NodeJS.Timeout | null = null;
  let busy = false;
  let again = false;
  const tick = async () => {
    if (busy) return void (again = true);
    busy = true;
    try {
      // watch never resolves conflicts on its own: strip --ours/--theirs
      await run("push", { ...flags, ours: "", theirs: "" }, { quiet: true });
    } catch (e) {
      say(`✗ ${(e as Error).message}`);
    } finally {
      busy = false;
      if (again) {
        again = false;
        schedule();
      }
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), 800);
  };
  // watch the whole folder (recursive): editors save by rename, which kills per-file watchers
  fsWatch(c.root, { recursive: true }, (_e, name) => {
    const rel = name?.toString().split("\\").join("/") ?? "";
    if (!rel || rel.startsWith(".atlas") || ALWAYS_SKIP.test(rel)) return;
    schedule();
  });
  await tick();
  await new Promise(() => {});
}

export const SYNC_HELP = `Sync a local folder (docs, prompts, code) with an Atlas project:
  atlas sync init [--project Name]          write ${CONFIG_FILE} with mappings detected from this folder
  atlas sync status                         what changed where (here, in Atlas, both = conflict)
  atlas sync push [--yes] [--dry-run] [--delete]   send local changes (--delete: remove files deleted here)
  atlas sync pull [--yes] [--dry-run] [--delete]   take Atlas changes (--delete: remove files deleted in Atlas)
  atlas sync watch [--yes]                  push on every save (debounced; conflicts are skipped)
  Conflicts: --ours <path[,path]> keeps local, --theirs <path[,path]> takes Atlas's (bare flag = all);
  otherwise push/pull asks per file. Markdown → docs (title = first "# heading" or the file name, folders
  kept), prompt files → prompts, code → code files (path kept). Needs ATLAS_API_KEY with docs / prompts /
  code read+write. ${STATE_FILE} holds hashes + revs only — keep it out of git.`;

export async function syncCli(argv: string[]) {
  const sub = argv[0];
  const p = parseArgs(argv.slice(1), { y: "yes", p: "project", n: "dry-run" }, ["yes", "dry-run", "delete", "force"]);
  if (sub === "init") return init(p.flags);
  if (sub === "status") return status(p.flags);
  if (sub === "push") return run("push", p.flags);
  if (sub === "pull") return run("pull", p.flags);
  if (sub === "watch") return watch(p.flags);
  say(SYNC_HELP);
  if (sub && sub !== "help") process.exitCode = 1;
}
