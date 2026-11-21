# `cdpn` — CodePen Commander

Sync local folders with [CodePen 2.0](https://codepen.io) Pens using the [CodePen API v2](https://blog.codepen.io/docs/api/api-v2/).

- Clone Pens (text & binary files) to a local folder and pull remote updates
- Track diffs between local files and the online saved head
- Push additions, edits, and deletions as a single version — waiting for builds and syncing compiler patches back locally
- Serve and build local Pens (with CodePen `classic` & `packages` Blocks support) or whole directories of Pens with an automatic, customizable index shell
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
  "last_synced_version_id": "01a08738-73f0-7848-b8bf-e8e7e91b1ae2",
  "last_synced_info_hash": "a1b2c3d4...",
  "editor": "V2",
  "info": {
    "title": "My Awesome Pen",
    "description": "A short description of the Pen",
    "tags": ["css", "demo"],
    "access": "Public",
    "template": false
  }
}
```

The `info` section tracks the Pen’s editable metadata (`title`, `description`, `tags`, `access`, and `template`) and syncs automatically with `cdpn status`, `cdpn push`, `cdpn pull`, `cdpn info`, and `cdpn privacy`. Edit `info.title`, `info.tags`, etc. directly in `.cdpn.json` and run `cdpn push` to update them on CodePen (passwords for `Protected` Pens are never stored in `.cdpn.json`; use `cdpn privacy protected` or `cdpn info --access Protected --password ...` instead).

Older `.cdpn.json` files created without an `info` section remain fully supported: `cdpn` will never overwrite remote metadata when `info` is absent, and will seamlessly populate `info` on your next `cdpn pull` or `cdpn push`.

You can also run `cdpn delete --keep-info` to delete the online Pen while stripping `.cdpn.json` down to only its `info` section (unlinked). When you later push the folder for the first time with `cdpn push` or `cdpn deploy`, the saved `title`, `description`, `tags`, `access`, and `template` are reused automatically without re-prompting for title or visibility (explicit `--title` / `--access` flags still override them, and `Protected` Pens still prompt for or require `--password`).

> **Why `.cdpn.json` instead of `.codepen`?**  
> CodePen 2.0 Pens already contain a `.codepen/` directory (housing `.codepen/pen.config.json`). Using `.cdpn.json` avoids filesystem collisions while allowing `.codepen/pen.config.json` to sync cleanly with CodePen.

You can also add an optional `.cdpnignore` file in a Pen folder to exclude extra local files from syncing (`.cdpn.json`, `.cdpnignore`, `.git`, `node_modules`, and `.DS_Store` are ignored automatically).

## Initializing & Scaffolding (`cdpn init` & `cdpn new`)

### Initialize an existing local folder (`cdpn init`)

Run `cdpn init [dir]` inside any local folder to mark it as a CodePen demo by creating an unlinked `.cdpn.json` metadata file and `.codepen/pen.config.json` (plus a starter `.codepen/classic.config.json` if the `classic` block is selected):

```bash
cdpn init                                        # Interactive: asks for title, visibility, and blocks (multi-select)
cdpn init ./my-demo -t "Scroll Demo" --visibility Public --blocks packages
cdpn init -t "Template" -d "Starter pen" --tags css,layout --as-template
```

- Interactively prompts for **Pen title**, **Pen visibility**, and **CodePen blocks** (multi-select; `validate` and `fingerprint` are required and cannot be unselected), then offers to push the demo to CodePen right away (defaults to `No`).
- Optional CLI flags let you bypass prompts (`-t/--title`, `--visibility`/`--access`, `--blocks`) and set extra metadata (`-d/--description`, `--tags`, `--template [bool]` / `--as-template`) without prompting.
- Once initialized, the folder is immediately discovered by `cdpn serve` / `cdpn build` and ready for `cdpn push`.

### Scaffold from a CodePen Template (`cdpn new`)

`cdpn new [folder]` scaffolds a brand-new CodePen 2.0 Pen from a CodePen Template into a new or empty local folder. Running `cdpn new` in a directory that already has files is disallowed (use `cdpn init` to convert an existing local demo into a CodePen demo, or pass a new folder name like `cdpn new my-demo`).

CodePen stores your reusable scaffolds as **Templates** (any Pen marked with `template: true` on CodePen or via `cdpn info --template true` / `cdpn new --as-template`), alongside CodePen's built-in 2.0 starter. When you run `cdpn new` interactively, it fetches your account's Templates from CodePen and lets you pick one (or use CodePen's default starter):

```bash
cdpn new my-demo                                 # Interactive picker (your CodePen Templates + CodePen default starter)
cdpn new my-demo --template "CSS Demo Base"      # Scaffold from a CodePen Template by title, ID, or URL
cdpn new my-starter --as-template --blocks packages -d "Reusable starter" --tags css,starter
```

To fork one of your own 2.0 Pens into a new local folder, use `cdpn fork`:

```bash
cdpn fork https://codepen.io/username/pen/abcde              # Prompts for target folder (or auto-generates one)
cdpn fork https://codepen.io/username/pen/abcde my-fork      # Forks directly into ./my-fork
```

> **Note:** CodePen API v2 keys can only access and fork Pens owned by the key's account (other users' Pens return `404`, even when public). When you run `cdpn fork` or `cdpn clone` on another user's Pen URL interactively, `cdpn` offers to open the Pen in your browser so you can fork it on `codepen.io` and paste your forked URL back to clone immediately.

## Local Serving, Static Builds & Custom Shells

`cdpn` can preview and statically build both individual Pens and multi-Pen directories locally—supporting CodePen 2.0 `classic` (`.pen.html` + `.codepen/classic.config.json`) and `packages` (`package.json` importmaps via `esm.sh`) blocks on the fly:

```bash
# Serve a single Pen or a directory of Pens on http://127.0.0.1:3000
cdpn serve
cdpn serve my-demos --port 8080 --open

# Build a Pen (prompts for destination, defaults to ./build, updates .cdpnignore & offers .gitignore)
cdpn build
cdpn build --out dist --yes --watch

# Customize the demo index shell used for multi-Pen directories
cdpn shell show                         # Show active shell (built-in or custom ~/.cdpn path)
cdpn shell export ./my-shell --set      # Export built-in shell files to edit & set as default in ~/.cdpn
cdpn shell set ./my-shell               # Point ~/.cdpn to a custom shell directory
cdpn shell reset                        # Revert back to the built-in shell

# Override shell or index metadata per invocation
cdpn serve --shell ./my-shell --title "CSS Demos" --subtitle "Handcrafted experiments"
cdpn build --out dist --shell ./my-shell --title "CSS Demos"
```

- **Pen folder** (contains `.cdpn.json`): serves or builds the Pen directly (if `.codepen/` is missing, `cdpn serve` serves it as plain static files with a helpful tip). When building a Pen into a subfolder of itself, `cdpn build` automatically adds that subfolder to `.cdpnignore` and offers to create/update `.gitignore`.
- **Directory of Pens** (no `.cdpn.json` at the root): recursively discovers subdirectories containing `.cdpn.json` and generates an in-memory `demos.json` (on `serve`) or static `demos.json` (on `build`) with the index shell—preserving an existing root `index.html` if present. Subdirectories without a `.cdpn.json` file are not indexed or served; the shell displays a hint to run `cdpn init` in any missing demo folder to mark it as a CodePen demo.

## Commands

All commands accept the global `--profile <name>` flag to override the active profile. Every data/state command also accepts `--json` (everything except interactive-only `cdpn auth login`, browser-opening `cdpn open`, and long-running `cdpn serve`).

| Command | Description |
| --- | --- |
| `cdpn auth status [--offline] [--json]` | Show loaded API keys/profiles (`CODEPEN_API_KEY` & `~/.cdpn`) and verify them |
| `cdpn auth login [profile] [--default] [--no-open]` | Open CodePen API settings, verify key, and save a profile to `~/.cdpn` or print shell export lines |
| `cdpn auth list [--json]` | List stored profiles in `~/.cdpn` (alias: `cdpn auth ls`) |
| `cdpn auth default [profile] [--json]` | Set the default profile in `~/.cdpn` |
| `cdpn auth logout [profile] [--all] [--json]` | Remove a specific profile or clear all profiles from `~/.cdpn` (preserves global config if set) |
| `cdpn init [dir] [-t ...] [--visibility ...] [--blocks ...] [-d ...] [--tags ...] [--template [bool]\|--as-template] [-f\|-y] [--json]` | Initialize a local directory as a CodePen demo by creating `.cdpn.json` and `.codepen/pen.config.json` |
| `cdpn new [folder] [-t ...] [-d ...] [--tags ...] [--access\|--visibility ...] [--blocks ...] [--template <id\|url\|title>] [--as-template] [--json]` | Scaffold a brand-new 2.0 Pen from a CodePen Template (or CodePen default starter) into a new or empty folder |
| `cdpn fork <url> [folder] [--title ...] [--access ...] [--json]` | Fork one of your own 2.0 Pens into a local folder (for other users' Pens, offers to open in browser to fork and clone back) |
| `cdpn clone <url> [folder] [--force] [--json]` | Clone a CodePen Pen into a local folder (auto-matches stored profile by URL owner; offers to convert Classic Pens or clone them unlinked; offers browser fork-and-clone fallback for unowned Pens) |
| `cdpn pull [--force] [--json]` | Pull latest remote file and Pen info changes into an existing cloned folder (requires `.cdpn.json`) |
| `cdpn status [--json]` | Show active profile, file and Pen info diffs, remote head, build & deployment status |
| `cdpn push [-m <label>] [--force] [--dry-run] [--no-wait] [--json]` | Push local file and `.cdpn.json` Pen info changes (text & binary + deletions), or push an unlinked local demo folder as a new Pen (reuses retained `.cdpn.json` `info` if present; otherwise checks `index.html`, asks account, title, and visibility) |
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
| `cdpn delete [--keep-info] [--yes] [--json]` | Delete the online Pen on CodePen (moves to Deleted Items for 3 days) and remove `.cdpn.json` — or keep only its `info` section with `--keep-info` for a later first push — while keeping local files untouched (aliases: `cdpn del`, `cdpn rm`) |
| `cdpn info [--title ...] [--tags ...] [--access ...] [--template true\|false] [--json]` | View or update Pen metadata |
| `cdpn settings [--auto-deploy ...] [--indent-with ...] [--json]` | View or update Pen editor & deployment settings |
| `cdpn serve [dir] [-p <port>] [-o] [--shell <dir>] [--title ...] [--subtitle ...] [--footer ...]` | Serve a local Pen (`.cdpn.json`) or directory of `.cdpn.json` Pens on `127.0.0.1` with live in-memory `demos.json` and `classic`/`packages` Blocks support |
| `cdpn build [dir] [-o <dir>] [-y\|-f] [-w] [--shell <dir>] [--title ...] [--subtitle ...] [--footer ...] [--json]` | Build a local Pen or directory of `.cdpn.json` Pens into a static deployable folder (auto-updates `.cdpnignore` and offers `.gitignore` when building inside a Pen) |
| `cdpn shell [show] [--json]` | Show the active demo index shell (custom `~/.cdpn` path or built-in) |
| `cdpn shell export [dir] [--set] [-y\|-f] [--json]` | Copy the built-in shell files into a local directory for customization (aliases: `eject`, `init`) |
| `cdpn shell set <dir> [--json]` | Set a custom default shell directory in `~/.cdpn` |
| `cdpn shell reset [--json]` | Reset the global shell in `~/.cdpn` back to the built-in shell (aliases: `unset`, `clear`) |

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
