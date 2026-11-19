# `cdpn` — CodePen Commander

Sync local folders with [CodePen 2.0](https://codepen.io) Pens using the [CodePen API v2](https://blog.codepen.io/docs/api/api-v2/).

- Clone Pens (text & binary files) to a local folder and pull remote updates
- Track diffs between local files and the online saved head
- Push additions, edits, and deletions as a single version — waiting for builds and syncing compiler patches back locally
- Deploy, undeploy, manage custom domains, browse versions & roll back, inspect/edit metadata & settings

## Installation

```bash
npm install -g codepen-commander
```

Requires Node.js 20 or newer.

## Authentication & Profiles

Generate personal (`cp_user_…`) and/or team (`cp_team_…`) API keys at [codepen.io/settings/api](https://codepen.io/settings/api), or run:

```bash
cdpn auth login              # Add a profile (e.g. bramus)
cdpn auth login username     # Add another profile (e.g. a team account)
```

`cdpn` stores named profiles in **`~/.cdpn`** (with strict `0600` owner-only permissions):

```json
{
  "default": "bramus",
  "profiles": {
    "bramus": "cp_user_...",
    "username": "cp_team_..."
  }
}
```

When running commands, `cdpn` resolves credentials in this order:

1. An explicit `--profile <name>` flag (e.g. `cdpn list --profile username`)
2. The `CODEPEN_API_KEY` environment variable (useful in CI)
3. The `"profile"` stored in the Pen folder’s `.cdpn.json`
4. Your sole profile in `~/.cdpn`, a stored profile matching the Pen owner (automatically selected by `cdpn clone <url>`), or—when multiple profiles exist and none matches—an interactive prompt

Check your authentication status or list profiles at any time:

```bash
cdpn auth status
cdpn auth list
```

## Quick Start

```bash
# 1. Authenticate (add one or more profiles)
cdpn auth login bramus
cdpn auth login username

# 2. Clone an existing Pen into a local folder (automatically uses "username" when stored)
cdpn clone https://codepen.io/username/pen/abcde my-pen
cd my-pen

# 3. Edit files locally, then check differences (automatically uses "username")
cdpn status

# 4. Push local changes (additions, edits, and deletions) to CodePen
cdpn push -m "Tweak layout and styles"

# 5. Push and deploy live to CodePen Hosting
cdpn deploy
```

## Sync Metadata (`.cdpn.json`)

Every synced Pen folder contains a `.cdpn.json` file at its root:

```json
{
  "url": "https://codepen.io/username/pen/abcde",
  "pen_id": "01a08738-73f0-7847-b6a8-5789d289c158",
  "profile": "username",
  "last_synced_version_id": "01a08738-73f0-7848-b8bf-e8e7e91b1ae2"
}
```

> **Why `.cdpn.json` instead of `.codepen`?**  
> CodePen 2.0 Pens already contain a `.codepen/` directory (housing `.codepen/pen.config.json`). Using `.cdpn.json` avoids filesystem collisions while allowing `.codepen/pen.config.json` to sync cleanly with CodePen.

You can also add an optional `.cdpnignore` file in a Pen folder to exclude extra local files from syncing (`.cdpn.json`, `.cdpnignore`, `.git`, `node_modules`, and `.DS_Store` are ignored automatically).

## Scaffolding & Templates (`cdpn new`)

`cdpn new [folder]` is dedicated to scaffolding a brand-new CodePen 2.0 Pen from a CodePen Template into a new or empty local folder (for pushing an existing local demo folder, run `cdpn push` inside that folder instead).

CodePen stores your reusable scaffolds as **Templates** (any Pen marked with `template: true` on CodePen or via `cdpn info --template true` / `cdpn new --as-template`), alongside CodePen's built-in 2.0 starter. When you run `cdpn new` interactively, it fetches your account's Templates from CodePen and lets you pick one (or use CodePen's default starter):

```bash
cdpn new my-demo                                 # Interactive picker (your CodePen Templates + CodePen default starter)
cdpn new my-demo --template "CSS Demo Base"      # Scaffold from a CodePen Template by title, ID, or URL
cdpn new my-starter --as-template                # Create a new reusable Template on CodePen
```

To fork one of your own 2.0 Pens into a new local folder, use `cdpn fork`:

```bash
cdpn fork https://codepen.io/username/pen/abcde              # Prompts for target folder (or auto-generates one)
cdpn fork https://codepen.io/username/pen/abcde my-fork      # Forks directly into ./my-fork
```

> **Note:** CodePen API v2 keys can only access and fork Pens owned by the key's account (other users' Pens return `404`, even when public). When you run `cdpn fork` or `cdpn clone` on another user's Pen URL interactively, `cdpn` offers to open the Pen in your browser so you can fork it on `codepen.io` and paste your forked URL back to clone immediately.

## Commands

All commands accept the global `--profile <name>` flag to override the active profile. Every data/state command also accepts `--json` (everything except interactive-only `cdpn auth login` and browser-opening `cdpn open`).

| Command | Description |
| --- | --- |
| `cdpn auth status [--offline] [--json]` | Show loaded API keys/profiles (`CODEPEN_API_KEY` & `~/.cdpn`) and verify them |
| `cdpn auth login [profile] [--default] [--no-open]` | Open CodePen API settings, verify key, and save a profile to `~/.cdpn` or print shell export lines |
| `cdpn auth list [--json]` | List stored profiles in `~/.cdpn` (alias: `cdpn auth ls`) |
| `cdpn auth default [profile] [--json]` | Set the default profile in `~/.cdpn` |
| `cdpn auth logout [profile] [--all] [--json]` | Remove a specific profile or delete `~/.cdpn` completely |
| `cdpn new [folder] [--template <id\|url\|title>] [--as-template] [--json]` | Scaffold a brand-new 2.0 Pen from a CodePen Template (or CodePen default starter) into a new or empty folder |
| `cdpn fork <url> [folder] [--title ...] [--access ...] [--json]` | Fork one of your own 2.0 Pens into a local folder (for other users' Pens, offers to open in browser to fork and clone back) |
| `cdpn clone <url> [folder] [--force] [--json]` | Clone a CodePen Pen into a local folder (auto-matches stored profile by URL owner; offers browser fork-and-clone fallback for unowned Pens) |
| `cdpn pull [--force] [--json]` | Pull latest remote changes into an existing cloned folder (requires `.cdpn.json`) |
| `cdpn status [--json]` | Show active profile, file diffs (added/modified/deleted), remote head, build & deployment status |
| `cdpn push [-m <label>] [--force] [--dry-run] [--no-wait] [--json]` | Push local changes (text & binary + deletions), or push an unlinked local demo folder as a new Pen (checks `index.html`, asks account, title, and visibility) |
| `cdpn deploy [--no-push] [--version <id>] [--force] [--json]` | Push local changes (creating a Pen first if unlinked) and deploy to CodePen Hosting |
| `cdpn undeploy [--yes] [--json]` | Take down the live deployment (Pen & versions remain intact) |
| `cdpn domains [list] [--json]` | Show the default deployed URL, custom domains, verification status, and required DNS records |
| `cdpn domains add <host> [--json]` | Attach a custom domain to the Pen's deployment |
| `cdpn domains delete <host> [--yes] [--json]` | Delete a custom domain (aliases: `cdpn domains del`, `cdpn domains rm`) |
| `cdpn open [--preview \| --deploy]` | Open the Pen's editor, preview, or deployed URL in your browser (prompts to choose when multiple domains exist; `--live` is an alias for `--deploy`) |
| `cdpn list [--search ...] [--templates] [--deployed] [--editor V2\|Classic] [--json]` | List and search your Pens (or Templates) on CodePen (alias: `cdpn ls`) |
| `cdpn versions [--limit <n>] [--json]` | List saved versions with build status, labels, and markers (`head`, `local`, `deployed`) |
| `cdpn rollback [version-id] [-m <label>] [--yes] [--json]` | Restore an older saved version to head and sync files locally |
| `cdpn privacy [level] [--password <pw>] [--show] [--json]` | View or update Pen privacy (`Public`, `Private`, `Protected`, `Collaborators`; alias: `cdpn access`; requires `.cdpn.json` in current folder) |
| `cdpn delete [--yes] [--json]` | Delete the online Pen on CodePen (moves to Deleted Items for 3 days) and remove `.cdpn.json` while keeping local files untouched (aliases: `cdpn del`, `cdpn rm`) |
| `cdpn info [--title ...] [--tags ...] [--access ...] [--template true\|false] [--json]` | View or update Pen metadata |
| `cdpn settings [--auto-deploy ...] [--indent-with ...] [--json]` | View or update Pen editor & deployment settings |

## JSON Output (`--json`)

When `--json` is passed, `cdpn` runs non-interactively, suppresses human-readable progress output, and prints a single JSON envelope to `stdout` (even on errors):

```json
{
  "status": {
    "code": 200,
    "message": "Up to date with CodePen (3 file(s))."
  },
  "contents": {
    "...": "raw command data"
  }
}
```

- `status.code` uses HTTP-style status codes (`200` OK, `201` Created, `400` Bad Request / missing required flag such as `--yes`, `401` Unauthorized, `403` Forbidden, `404` Not Found, `409` Conflict, `422` Build Failed, `429` Rate Limited, `500` Internal Error).
- `status.message` is a plain, human-readable summary string (ANSI-free).
- `contents` holds the structured payload for tools to consume (or error metadata / `null` on failure).
- Non-`2xx` outcomes exit with a non-zero exit code (`1`).

## Development & Publishing

Source files live in `./src` and compile into `./dist`. Only the contents of `./dist` are published to npm (with paths in `dist/package.json` rewritten cleanly to package root):

```bash
npm run build      # Compiles src/ -> dist/ and prepares dist/package.json, README.md, LICENSE
npm test           # Builds and runs the full test suite
npm run typecheck  # Runs strict TypeScript checks across src/ and test/
npm run pub        # Builds and publishes ./dist to npm
```

Running `npm publish` directly from the repository root is intentionally blocked via `prepublishOnly` so you never accidentally publish `./src` or a nested `./dist` folder.

## License

MIT
