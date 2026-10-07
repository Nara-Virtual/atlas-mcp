# atlas-mcp

Connect any AI coding agent (Cursor, Claude Code, Claude Desktop, Codex, Gemini CLI, Windsurf, VS Code/Copilot, Cline…) to your team's
**Atlas** knowledge hub. The agent pulls your approved prompts, docs and scoped secrets as context —
and Atlas passively captures what the AI builds, so the team can see it without anyone using Jira.

## Install globally (once per machine)

```bash
bun install -g github:Nara-Virtual/atlas-mcp#main
# or: npm install -g github:Nara-Virtual/atlas-mcp#main
```

This puts **`atlas`** on your PATH — repo setup, hooks, and the stdio MCP server IDEs spawn.

## Update to latest

```bash
atlas update
# or without a prior global install:
npx -y github:Nara-Virtual/atlas-mcp#main update
```

Pulls the latest commit from GitHub `main` (IDE `npx` configs from `atlas install` already use `#main`).

## One-command install into your AI clients

```bash
atlas install --key atlas_mcp_… --project Nara     # every client below that you use
atlas install --key atlas_mcp_… --only codex,gemini # just those
atlas uninstall [--only cursor]                      # take atlas out again (other servers stay)
atlas doctor                                         # check key, connection, tools, prompts, wired clients
```

Cursor, Claude Code, Claude Desktop, Windsurf, VS Code (+ Insiders), GitHub Copilot CLI, Codex CLI
(`~/.codex/config.toml`) and Gemini CLI (`~/.gemini/settings.json`). Claude Desktop and Codex take the key
literally (they cannot read your shell profile), so they need `--key`; the others use `${ATLAS_MCP_KEY}`.
A config file that is not plain JSON (comments, a typo) is skipped and never rewritten; the first change to any
file leaves a one-time `<file>.atlas-bak` copy. Zed and Cline keep JSONC settings — add the stdio entry by hand
(`command: npx`, `args: ["-y", "github:Nara-Virtual/atlas-mcp#main"]`, `env: ATLAS_MCP_KEY`, `ATLAS_BASE_URL`).

## One-command setup

```bash
# in your repo root — uses folder name as project; creates if missing
atlas .
# or pin a specific Atlas project by name:
atlas . --project Conference
```

Requires `ATLAS_MCP_KEY` in your environment (or pass `--key`). If the project exists, you get linked immediately; if not, Atlas asks to create it.

Then create an **MCP key** in Atlas → Settings → API keys → *MCP key* (pick toolsets, read-only, expiry),
and export it:

```bash
export ATLAS_MCP_KEY=atlas_mcp_xxxxxxxx      # add to your shell profile
export ATLAS_BASE_URL=https://atlas.naravirtual.in
```

Claude Code only — capture every prompt + session automatically (zero agent cooperation):

```bash
atlas hooks install
```

## Env files and logs from the terminal

Needs `ATLAS_API_KEY` with `secrets:read`, `secrets:reveal`, `secrets:write` (and `logs:write` for `atlas log`).
The project comes from `.atlas` / `~/.atlas/config.json`, `ATLAS_PROJECT` or `--project`.

```bash
atlas env pull production -o .env      # exact file (comments, order, quotes kept); remembers v<N>
atlas env diff                         # + added  ~ changed  - removed keys — values never printed
atlas env push -m "rotate stripe key"  # shows the diff, asks, pushes as v<N+1>; rejected if Atlas moved on
atlas env watch --yes                  # push on every save (without --yes it asks each time)
atlas env run --file production -- bun start   # env injected into the process, never written to disk
bun start 2>&1 | atlas log --source api --level info   # tees stdin and ships lines to Atlas logs
```

Base versions live in `.atlas.env.json` (paths and version numbers only — add it to `.gitignore`).
A push whose base is stale gets a 409: pull, merge, push again. Nothing is ever overwritten silently.

## Sync docs, prompts and code from a local folder

Needs `ATLAS_API_KEY` with `docs`, `prompts` and `code` read + write (only the kinds your mappings use).

```bash
atlas sync init --project Nara     # writes .atlas.sync.json with mappings detected from this folder
atlas sync status                  # + new  ↑ changed here  ↓ changed in Atlas  ! conflict  - deleted on one side
atlas sync push                    # shows the plan, asks, pushes (--yes to skip the question, --dry-run to only look)
atlas sync pull                    # same, the other way
atlas sync push --delete           # also delete in Atlas what you deleted here (pull --delete: the reverse)
atlas sync push --ours docs/a.md   # conflict: keep the local file   (--theirs <path> takes Atlas's; bare flag = all)
atlas sync watch --yes             # push on every save (debounced); conflicts are reported, never overwritten
```

`.atlas.sync.json` (commit it):

```json
{
  "project": "Nara",
  "mappings": {
    "prompts/**/*.{md,txt}": "prompts",
    "docs/**/*.md": "docs",
    "src/**/*.{ts,tsx,py,sh,sql}": "code"
  },
  "maxBytes": 262144,
  "ignore": ["docs/drafts/**"]
}
```

- The first matching glob wins, so list `prompts` before a broad `**/*.md`. `.gitignore`d files, binaries
  and files over `maxBytes` are never synced.
- Markdown → a doc: the title is the first `# heading` (or the file name), folders become parent pages.
  Prompt files → prompts (same title rule). Code files keep their path.
- `.atlas.sync-state.json` (gitignored automatically) remembers each file's content hash and the Atlas
  revision it was last in sync at, so status can tell "changed here", "changed in Atlas" and "both".
  Atlas also remembers which path each item came from, so a teammate's fresh clone lines up.
- Every push and pull is audited in Atlas as `sync.pushed` / `sync.pulled` (counts only).

## What it exposes (scope-gated — tools you can't use are hidden)

The tool catalog comes from the server on every connect (titles and read-only / destructive annotations included), so
it always matches your key's toolsets:

- **context**: `atlas_browse` (any surface), `atlas_read` (any item; images are shown to the agent), `atlas_search`, `atlas_context`, `atlas_get_secret`.
- **write**: `atlas_write` (docs, code, prompts, comments, scripts, images…; stdio supports `localPath`).
- **capture**: `atlas_log_work`, `atlas_save_prompt`.
- **tasks**: `atlas_my_tasks`, `atlas_list_tasks` (a task with its images), `atlas_get_image`, `atlas_create_task`, `atlas_update_task`, `atlas_comment_task`.
- **ops**: `atlas_uptime`, `atlas_logs`, `atlas_databases`, `atlas_deployments`, `atlas_server_usage`, `atlas_dokploy_api_search`, `atlas_dokploy_api_call` (reads); **deploy**: `atlas_deploy_action`, `atlas_dokploy_api_call` (operate / configure; destroy and instance-wide with "Allow Dokploy admin").
- **inbox / team / mynotes / chat**: through `atlas_browse` / `atlas_read` / `atlas_write`, plus `atlas_chat_send`.

MCP prompts (`work_on_task`, `my_day`, `ops_check`, your team's Prompt library), resources (`atlas://task|doc|code|image/{id}`),
resource templates and completions are forwarded to the remote endpoint (`<atlas>/api/mcp`) with your key, so a
stdio-only client has the same surface as a URL config. The tool list is re-read every 5 minutes: a server deploy
adds or changes tools in an open session without restarting the IDE, and an IDE opened offline starts from the last
copy of the manifest.

## How it works

Calls time out after 30 s; reads retry once on a network failure or a 5xx, writes never repeat. Errors say what to do
("key revoked → create a new MCP key", "rate limited — retry in 12 s").

A thin, cached client over the Atlas REST API. Reads are served from a local cache
(`~/.atlas/cache`, stale-while-revalidate) so they're instant and work offline; writes queue and flush
when the network returns. All auth, fine-grained scopes and audit are enforced server-side.

The `.atlas` file binds the repo to an Atlas project and selects toolsets:

```jsonc
{ "project": "general", "autoCapture": true, "toolsets": ["context","capture","tasks"], "readOnly": false }
```

The key (secret) is never in `.atlas` — it lives in your IDE env / shell profile.

---

## Agent transport options

Repo: https://github.com/Nara-Virtual/atlas-mcp

**Remote (zero local install beyond the key)** — point any client at the hosted server:

```bash
claude mcp add --transport http atlas https://atlas.naravirtual.in/api/mcp --header "Authorization: Bearer $ATLAS_MCP_KEY"
```

Or for Cursor/Windsurf/VS Code, paste the remote config (see Atlas → Connect agent for your exact snippet).

**Local (repo-aware, recommended for capture)** — stdio via globally installed `atlas` (reads `.atlas`, offline cache):

```bash
atlas .                              # set up a repo
# agents are configured to run:  atlas
```

Auth is read from `ATLAS_MCP_KEY` (set once in your shell profile). Default endpoint is
`https://atlas.naravirtual.in`; override with `ATLAS_BASE_URL`.
