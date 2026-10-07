import { readFileSync, writeFileSync, existsSync, watch as fsWatch } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createInterface as createPrompt } from "node:readline/promises";
import { loadConfig, findDotAtlas } from "./config.js";
/**
 * `atlas env …` and `atlas log` — sync env files with Atlas and ship logs.
 * Env files are transferred as exact text (comments, order, quotes, line endings kept). Diffs are
 * computed by the server by key and never print values. `env run` injects values into a child
 * process only — nothing is written to disk.
 *
 * Local state (base versions for optimistic pushes) lives in `.atlas.env.json` next to `.atlas`
 * (or in the current folder). Add it to .gitignore — it holds no values, only versions and paths.
 */
const say = (m) => process.stderr.write(m + "\n");
/** Tiny argv parser: `-o x`, `--out x`, `--yes`, and everything after `--` untouched. */
export function parseArgs(argv, short = {}, bools = []) {
    const out = { pos: [], flags: {}, rest: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--") {
            out.rest = argv.slice(i + 1);
            break;
        }
        const m = /^--?([\w-]+)(?:=(.*))?$/.exec(a);
        if (!m) {
            out.pos.push(a);
            continue;
        }
        const name = a.startsWith("--") ? m[1] : (short[m[1]] ?? m[1]);
        if (m[2] !== undefined)
            out.flags[name] = m[2];
        else if (bools.includes(name) || i + 1 >= argv.length || argv[i + 1].startsWith("-"))
            out.flags[name] = true;
        else
            out.flags[name] = argv[++i];
    }
    return out;
}
function statePath() {
    const found = findDotAtlas();
    return join(found?.root ?? process.cwd(), ".atlas.env.json");
}
function readState() {
    try {
        return existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), "utf8")) : { files: {} };
    }
    catch {
        return { files: {} };
    }
}
function writeState(s) {
    writeFileSync(statePath(), JSON.stringify(s, null, 2) + "\n");
}
function ctx(flags) {
    const { baseUrl, apiKey, config } = loadConfig();
    const key = (typeof flags.key === "string" ? flags.key : null) ?? apiKey;
    const project = (typeof flags.project === "string" ? flags.project : null) ?? process.env.ATLAS_PROJECT ?? config.project;
    const base = ((typeof flags["base-url"] === "string" ? flags["base-url"] : null) ?? baseUrl).replace(/\/$/, "");
    if (!key)
        throw new Error("No API key — set ATLAS_API_KEY (scopes secrets:read/reveal/write) or pass --key");
    if (!project)
        throw new Error("No project — run `atlas .` to bind this folder, set ATLAS_PROJECT, or pass --project");
    return { base, key, project };
}
async function call(c, method, path, body) {
    try {
        return await fetch(`${c.base}${path}`, {
            method,
            headers: { Authorization: `Bearer ${c.key}`, "User-Agent": "atlas-cli", ...(body ? { "Content-Type": "application/json" } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
    }
    catch {
        throw new Error(`Can't reach Atlas at ${c.base}`);
    }
}
async function failFrom(res, what) {
    let msg = `${res.status}`;
    try {
        msg = (await res.json()).error ?? msg;
    }
    catch {
        /* not json */
    }
    throw new Error(`${what} failed: ${msg}`);
}
const envPath = (c, file, suffix = "", q = "") => `/api/v1/env/${encodeURIComponent(file)}${suffix}?projectId=${encodeURIComponent(c.project)}${q}`;
const stateKey = (c, file) => `${c.project}/${file}`;
const tracked = (c, file) => readState().files[stateKey(c, file)] ?? null;
/** Resolve which file + local path a command is about (file defaults to the only tracked one). */
function target(p, c) {
    const known = Object.values(readState().files).filter((v) => v.project === c.project);
    const knownNames = Object.keys(readState().files).filter((k) => k.startsWith(`${c.project}/`)).map((k) => k.slice(c.project.length + 1));
    const file = p.pos[0] ?? (knownNames.length === 1 ? knownNames[0] : undefined);
    if (!file)
        throw new Error(known.length ? `Which file? Tracked: ${knownNames.join(", ")}` : "Name the env file, e.g. `atlas env pull production`");
    const s = tracked(c, file);
    const out = typeof p.flags.out === "string" ? p.flags.out : (s?.path ?? ".env");
    return { file, path: resolve(out), version: s?.version ?? null };
}
function remember(c, file, path, version) {
    const st = readState();
    st.files[stateKey(c, file)] = { path, version, project: c.project };
    writeState(st);
}
async function serverDiff(c, file, content) {
    const res = await call(c, "POST", `/api/v1/env/${encodeURIComponent(file)}/diff`, { projectId: c.project, content });
    if (!res.ok)
        await failFrom(res, "diff");
    return (await res.json());
}
function printDiff(d) {
    if (d.identical)
        return say("  no changes — identical to Atlas");
    for (const k of d.added)
        say(`  + ${k}`);
    for (const k of d.changed)
        say(`  ~ ${k}`);
    for (const k of d.removed)
        say(`  - ${k}`);
    if (!d.added.length && !d.changed.length && !d.removed.length)
        say("  values identical — only comments, order or formatting differ");
    say(`  (${d.unchanged} unchanged; values never shown)`);
}
async function confirm(q) {
    if (!process.stdin.isTTY)
        return false;
    const rl = createPrompt({ input: process.stdin, output: process.stderr });
    const a = (await rl.question(`${q} [y/N] `)).trim().toLowerCase();
    rl.close();
    return a === "y" || a === "yes";
}
async function pull(p) {
    const c = ctx(p.flags);
    const t = target(p, c);
    const res = await call(c, "GET", envPath(c, t.file));
    if (!res.ok)
        await failFrom(res, "pull");
    const text = await res.text();
    const version = Number(res.headers.get("x-atlas-env-version") ?? 0);
    writeFileSync(t.path, text, { mode: 0o600 });
    remember(c, t.file, t.path, version);
    say(`✓ ${t.file} v${version} → ${t.path} (exact file, ${text.length} bytes)`);
}
async function diff(p) {
    const c = ctx(p.flags);
    const t = target(p, c);
    if (!existsSync(t.path))
        throw new Error(`${t.path} not found — run \`atlas env pull ${t.file}\` first`);
    const d = await serverDiff(c, t.file, readFileSync(t.path, "utf8"));
    say(`${t.file}: local ${t.path} vs Atlas v${d.version}${d.exists ? "" : " (new file)"}`);
    printDiff(d);
    if (t.version !== null && t.version !== d.version)
        say(`  ! Atlas moved from v${t.version} (your base) to v${d.version} — pull before pushing`);
}
/** Push a local file. Returns false when nothing was pushed. */
async function pushOnce(c, file, path, opts) {
    const content = readFileSync(path, "utf8");
    const t = { version: tracked(c, file)?.version ?? null };
    const d = await serverDiff(c, file, content);
    say(`${file}: ${path} → Atlas${d.exists ? ` v${d.version}` : " (new file)"}`);
    printDiff(d);
    if (d.identical)
        return false;
    if (t.version !== null && t.version !== d.version)
        say(`  ! Atlas is at v${d.version} but you pulled v${t.version} — this push will be rejected; pull first`);
    if (!opts.yes && !(await confirm(`Push as v${d.version + 1}?`))) {
        say("  · not pushed" + (process.stdin.isTTY ? "" : " (non-interactive: pass --yes)"));
        return false;
    }
    const res = await call(c, "PUT", `/api/v1/env/${encodeURIComponent(file)}`, {
        projectId: c.project,
        content,
        baseVersion: t.version ?? (d.exists ? d.version : 0),
        message: opts.message,
        source: "cli",
    });
    if (res.status === 409) {
        const j = (await res.json());
        say(`✗ Someone else saved ${file} (now v${j.currentVersion}) since your base v${t.version}.`);
        say(`  Your file was NOT pushed. Save your copy, run \`atlas env pull ${file}\`, merge, then push again.`);
        process.exitCode = 1;
        return false;
    }
    if (!res.ok)
        await failFrom(res, "push");
    const r = (await res.json());
    remember(c, file, path, r.version);
    say(`✓ pushed ${file} v${r.version}`);
    return true;
}
async function push(p) {
    const c = ctx(p.flags);
    const t = target(p, c);
    if (!existsSync(t.path))
        throw new Error(`${t.path} not found`);
    await pushOnce(c, t.file, t.path, { message: typeof p.flags.message === "string" ? p.flags.message : undefined, yes: !!p.flags.yes });
}
async function watch(p) {
    const c = ctx(p.flags);
    const t = target(p, c);
    if (!existsSync(t.path))
        throw new Error(`${t.path} not found`);
    say(`watching ${t.path} → ${t.file} (${p.flags.yes ? "auto-push" : "confirm each push"}) — Ctrl+C to stop`);
    let timer = null;
    let busy = false;
    let last = readFileSync(t.path, "utf8");
    // watch the folder: editors often replace the file (rename), which kills a file watcher
    fsWatch(resolve(t.path, ".."), (_e, name) => {
        if (name && resolve(t.path, "..", name.toString()) !== t.path)
            return;
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(async () => {
            if (busy || !existsSync(t.path))
                return;
            const now = readFileSync(t.path, "utf8");
            if (now === last)
                return;
            busy = true;
            try {
                if (await pushOnce(c, t.file, t.path, { message: "atlas env watch", yes: !!p.flags.yes }))
                    last = now;
            }
            catch (e) {
                say(`✗ ${e.message}`);
            }
            finally {
                busy = false;
            }
        }, 800);
    });
    await new Promise(() => { });
}
async function runCmd(p) {
    const c = ctx(p.flags);
    const file = typeof p.flags.file === "string" ? p.flags.file : p.pos[0];
    if (!file || !p.rest.length)
        throw new Error("Usage: atlas env run --file <name> -- <command…>");
    const res = await call(c, "GET", envPath(c, file, "", "&format=json"));
    if (!res.ok)
        await failFrom(res, "fetch env");
    const values = (await res.json());
    // values go straight into the child's environment — never to disk or stdout
    const child = spawn(p.rest[0], p.rest.slice(1), { stdio: "inherit", env: { ...process.env, ...values }, shell: process.platform === "win32" });
    for (const sig of ["SIGINT", "SIGTERM"])
        process.on(sig, () => child.kill(sig));
    child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    child.on("error", (e) => {
        say(`✗ ${e.message}`);
        process.exit(127);
    });
}
async function log(p) {
    const c = ctx(p.flags);
    const source = typeof p.flags.source === "string" ? p.flags.source : null;
    if (!source)
        throw new Error("Usage: <cmd> | atlas log --source <name> [--level info]");
    const levels = ["debug", "info", "warn", "error", "fatal"];
    // no --level: Atlas infers each line's level (ERROR…, [warn], level=…, JSON level)
    const level = typeof p.flags.level === "string" && levels.includes(p.flags.level) ? p.flags.level : undefined;
    const quiet = !!p.flags.quiet;
    let batch = [];
    let sent = 0;
    let failed = 0;
    const flush = async () => {
        if (!batch.length)
            return;
        const entries = batch.splice(0, 500);
        try {
            const res = await call(c, "POST", "/api/v1/logs", { projectId: c.project, source, entries });
            if (!res.ok) {
                failed += entries.length;
                say(`[atlas log] ${res.status} — dropped ${entries.length} lines`);
            }
            else
                sent += entries.length;
        }
        catch (e) {
            failed += entries.length;
            say(`[atlas log] ${e.message}`);
        }
    };
    const timer = setInterval(() => void flush(), 1000);
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) {
        if (!quiet)
            process.stdout.write(line + "\n"); // tee: piping through atlas log doesn't swallow output
        if (!line.trim())
            continue;
        // the API rejects messages over 8 KB, so long lines are split rather than dropped
        const at = new Date().toISOString();
        for (let i = 0; i < line.length; i += 8000)
            batch.push({ level, message: line.slice(i, i + 8000), at });
        if (batch.length >= 500)
            await flush();
    }
    clearInterval(timer);
    while (batch.length)
        await flush();
    say(`[atlas log] ${sent} lines sent to ${source}${failed ? `, ${failed} dropped` : ""}`);
    if (failed)
        process.exitCode = 1;
}
export const ENV_HELP = `Env files (exact text — comments kept; values never printed):
  atlas env pull [file] [-o .env]           download the file, remember its version
  atlas env push [file] [-m msg] [--yes]    key-level diff, confirm, push (409 if Atlas moved on)
  atlas env diff [file]                     what would change (added / changed / removed keys)
  atlas env watch [file] [--yes]            push on every save (confirms unless --yes)
  atlas env run --file <name> -- <cmd…>     run a command with the env injected (never written to disk)
Logs:
  <cmd> | atlas log --source <name> [--level info|warn|error] [--quiet]   (level inferred per line if omitted)
Common flags: --project <name> (default: .atlas / ~/.atlas/config.json), --key, --base-url
Needs ATLAS_API_KEY with secrets:read / secrets:reveal / secrets:write (and logs:write for atlas log).`;
export async function envCli(argv) {
    const sub = argv[0];
    const p = parseArgs(argv.slice(1), { o: "out", m: "message", y: "yes", p: "project" }, ["yes", "quiet"]);
    if (sub === "pull")
        return pull(p);
    if (sub === "push")
        return push(p);
    if (sub === "diff")
        return diff(p);
    if (sub === "watch")
        return watch(p);
    if (sub === "run")
        return runCmd(p);
    say(ENV_HELP);
    if (sub && sub !== "help")
        process.exitCode = 1;
}
export async function logCli(argv) {
    return log(parseArgs(argv, { s: "source", l: "level", p: "project" }, ["quiet"]));
}
