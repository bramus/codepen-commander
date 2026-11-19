# `cdpn` — CodePen Sync CLI

Sync local folders with [CodePen 2.0](https://codepen.io) Pens using the [CodePen API v2](https://blog.codepen.io/docs/api/api-v2/).

- Pull Pens (text & binary files) to a local folder
- Track diffs between local files and the online saved head
- Push additions, edits, and deletions as a single version — waiting for builds and syncing compiler patches back locally
- Deploy, undeploy, manage custom domains, browse versions & roll back, inspect/edit metadata & settings

## Installation

```bash
npm install -g cdpn
```

Requires Node.js 20 or newer.

## Authentication

Generate a personal (`cp_user_…`) or team (`cp_team_…`) API key at [codepen.io/settings/api](https://codepen.io/settings/api), or run:

```bash
cdpn auth login
```

`cdpn` resolves your API key in this order:

1. The `CODEPEN_API_KEY` environment variable
2. `~/.codepen` (saved with `0600` owner-only permissions when configured via `cdpn auth login`)

Check your current authentication status at any time:

```bash
cdpn auth status
```

## Quick Start

```bash
# 1. Authenticate
cdpn auth login

# 2. Pull an existing Pen into a local folder
cdpn pull https://codepen.io/username/pen/abcde my-pen
cd my-pen

# 3. Edit files locally, then check differences
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
  "last_synced_version_id": "01a08738-73f0-7848-b8bf-e8e7e91b1ae2"
}
```

> **Why `.cdpn.json` instead of `.codepen`?**  
> CodePen 2.0 Pens already contain a `.codepen/` directory (housing `.codepen/pen.config.json`). Using `.cdpn.json` avoids filesystem collisions while allowing `.codepen/pen.config.json` to sync cleanly with CodePen.

You can also add an optional `.cdpnignore` file in a Pen folder to exclude extra local files from syncing (`.cdpn.json`, `.cdpnignore`, `.git`, `node_modules`, and `.DS_Store` are ignored automatically).

## Commands

| Command | Description |
| --- | --- |
| `cdpn auth status [--offline]` | Show where the API key is loaded from and verify it against CodePen API v2 |
| `cdpn auth login [--no-open]` | Open CodePen API settings, verify key, and save to `~/.codepen` or print shell export lines |
| `cdpn auth logout` | Remove `~/.codepen` |
| `cdpn pull [url] [folder] [--force]` | Pull a Pen into a new folder (prompts if omitted), or update the current synced folder |
| `cdpn status [--json]` | Show file diffs (added/modified/deleted), remote head status, build & deployment status |
| `cdpn push [-m <label>] [--force] [--dry-run] [--no-wait]` | Push local changes (text & binary + deletions), wait for build, and sync compiler patches back |
| `cdpn deploy [--no-push] [--version <id>] [--force]` | Push local changes and deploy to CodePen Hosting |
| `cdpn undeploy [--yes]` | Take down the live deployment (Pen & versions remain intact) |
| `cdpn domains [list]` | List custom domains, verification status, and required DNS records |
| `cdpn domains add <host>` | Attach a custom domain to the Pen's deployment |
| `cdpn domains remove <host> [--yes]` | Remove a custom domain |
| `cdpn new [folder] [--title ...] [--access ...] [--starter]` | Create a new 2.0 Pen from local files or CodePen starter files |
| `cdpn open [--preview \| --live]` | Open the Pen's editor, preview, or live deployed URL in your browser |
| `cdpn list [--search ...] [--deployed] [--editor V2\|Classic]` | List and search your Pens on CodePen (alias: `cdpn ls`) |
| `cdpn versions [--limit <n>]` | List saved versions with build status, labels, and markers (`head`, `local`, `deployed`) |
| `cdpn rollback [version-id] [-m <label>] [--yes]` | Restore an older saved version to head and sync files locally |
| `cdpn info [--title ...] [--tags ...] [--access ...]` | View or update Pen metadata |
| `cdpn settings [--auto-deploy ...] [--indent-with ...]` | View or update Pen editor & deployment settings |

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
