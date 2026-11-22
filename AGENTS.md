# Agent Instructions (`codepen-commander`)

**`codepen-commander`** (`cdpn`) is a standalone Node.js CLI (TypeScript, `NodeNext` ESM, Node >= 20) for syncing local folders with CodePen 2.0 Pens via the CodePen API v2, previewing Pens/collections locally (`cdpn serve`), and building static demo sites (`cdpn build`).

---

## 1. Layered Acyclic Architecture (`src/`)

Every module in `src/` belongs to a strict 7-layer acyclic dependency graph (**`L0` → `L6`**). Modules may only import from their own layer (without cycles) or lower layers:

```text
src/
├── errors.ts                       # L0: CliError, isCliError
├── constants.ts                    # L0: shared filenames, size limits, PEN_ACCESS_CHOICES
├── api/
│   ├── types.ts                    # L0: CodePen API v2 domain types
│   ├── errors.ts                   # L0: CodePenApiError, isCodePenApiError
│   └── client.ts                   # L2: CodePenClient (HTTP, multipart, pagination, builds)
├── utils/                          # L1: pure/IO utilities (zero domain config/workflow deps)
│   ├── browser.ts                  # Cross-platform openInBrowser (HTTPS-only guard)
│   ├── cli-options.ts              # Shared flag parsers (visibility/access, booleans, labels, inherited --json)
│   ├── codepen-url.ts              # Pen URL & slug/owner parsing
│   ├── format.ts                   # ANSI formatting, stripAnsi, tables, dates, shortId
│   ├── fs-safe.ts                  # isWithinRoot, realpath containment, safe path resolution
│   ├── html.ts                     # extractHtmlTitle, escapeHtml
│   ├── json.ts                     # JsonEnvelope, createJsonResponse, printJsonResponse, errorToJsonEnvelope
│   ├── output.ts                   # CommandOutput, defaultOutput, createSilentOutput, createBufferedOutput
│   ├── package-paths.ts            # Package root & bundled shell/ asset resolution
│   ├── strings.ts                  # slugify, isPlainObject, isLoopbackHost, control-char checks
│   ├── watcher.ts                  # Debounced recursive filesystem watcher
│   └── prompts/                    # Interactive TTY prompt primitives (zero external prompt deps)
│       ├── types.ts                # SelectOption, PromptCanceledError, isPromptCanceledError
│       ├── tty-list.ts             # Raw-mode arrow-key list widget
│       ├── text.ts                 # promptText, promptConfirm
│       ├── select.ts               # promptSelect
│       ├── multi-select.ts         # promptMultiSelect
│       ├── secret.ts               # promptSecret (masked input)
│       └── index.ts                # Barrel export + isInteractive
├── config/                         # L2: local & global persistence
│   ├── auth.ts                     # Profile name validation, API key type/masking, ResolvedAuth
│   ├── user-store.ts               # ~/.cdpn multi-profile store + global config.shell (0600 perms)
│   ├── project.ts                  # .cdpn.json discovery, read/write, unlinked info-only state
│   └── pen-blocks.ts               # .codepen/pen.config.json & classic.config.json builders
├── sync/                           # L2: filesystem ↔ CodePen diff & materialization
│   ├── fs.ts                       # Local folder scanning, ignore rules, SHA-256 hashing, binary detection
│   ├── diff.ts                     # Three-way file diffing & dirty-state detection
│   ├── info.ts                     # .cdpn.json `info` hashing, 3-way metadata sync, PATCH builder
│   └── materialize.ts              # Safe remote-to-local file writing & pruning
├── site/                           # L3: local preview server & static site builder
│   ├── detect.ts                   # Single-Pen vs multi-Pen collection auto-detection
│   ├── manifest.ts                 # demos.json manifest scanner & generator
│   ├── shell.ts                    # Built-in vs custom shell resolution, export & token rendering
│   ├── ignore-files.ts             # .cdpnignore parsing & path matching
│   ├── builder.ts                  # Static deployable site builder (`cdpn build`)
│   ├── server.ts                   # Local preview dev server (`cdpn serve`, 127.0.0.1 only)
│   └── blocks/                     # Local CodePen Blocks runtime emulation
│       ├── context.ts              # Shared block config & file resolution
│       ├── classic.ts              # Classic block HTML/CSS/JS assembly & head injection
│       ├── packages.ts             # Packages block importmap injection
│       ├── unsupported-page.ts     # Friendly HTML notice for unsupported build blocks
│       └── index.ts                # Block pipeline dispatcher
├── workflows/                      # L4: cross-command multi-step orchestration (acyclic)
│   ├── auth-context.ts             # Command auth & interactive profile selection
│   ├── batch-pens.ts               # Multi-Pen tree-walk batch runners, double-confirm & summaries
│   ├── batch-target.ts             # `[target]` (`all` vs directory) resolution, `./all` disambiguation & fallback offer
│   ├── classic-convert.ts          # Interactive Classic → V2 Pen conversion prompt loop
│   ├── clone-pen.ts                # Clone workflow (accepts optional `forkUnowned` callback — no cycle!)
│   ├── create-pen.ts               # First-time local directory → new Pen creation
│   ├── discover-pens.ts            # Symlink-safe recursive `.cdpn.json` Pen tree discovery
│   ├── fork-pen.ts                 # Fork workflow (imports clone-pen one-way)
│   ├── missing-pen.ts              # Missing/Trashed remote Pen recovery, purge, unlink, `.codepen/` removal
│   ├── pull-pen.ts                 # Shared `executePull` (single-Pen, sync, batch, `--dry-run`)
│   ├── push-pen.ts                 # Shared `executePush` used by `push`, `sync`, `deploy`, and batch
│   ├── scaffold.ts                 # Shared target-directory & template scaffolding helpers
│   ├── sync-pen.ts                 # 3-way sync state classification & single-Pen `executeSync`
│   └── unowned-pen.ts              # Browser-assisted fork fallback for unowned CodePen URLs
├── commands/                       # L5: strictly 1 file per top-level CLI command (25 commands)
│   ├── auth/                       # Nested subcommands (`index.ts`, `status.ts`, `list.ts`, `default.ts`, `login.ts`, `logout.ts`)
│   └── <command>.ts                # build, clone, delete, deploy, domains, fork, info, init, list,
│                                   # new, open, privacy, pull, push, restore, rollback, serve,
│                                   # settings, shell, status, sync, undeploy, unlink, versions
└── cli.ts                          # L6: Commander program assembly, error handling, process.exitCode
```

- **Acyclic workflow rule**: `workflows/fork-pen.ts` imports `workflows/clone-pen.ts` one-way. Never import `fork-pen.ts` or `commands/fork.ts` from `clone-pen.ts`; inject the fork callback via `forkUnowned` from `commands/clone.ts`.
- **1-file-per-command rule**: Every top-level CLI command has exactly one entry file in `src/commands/` (or folder with `index.ts` for multi-subcommand namespaces like `auth/`). Never place shared workflows in `src/commands/`.

---

## 2. Command Runner & CLI Contracts

1. **Standard exports per command module**:
   - `run<Name>Command(options)` — pure testable command runner.
   - `register<Name>Command(program)` — Commander option/argument binding calling `run<Name>Command`.
2. **Injectable output (`CommandOutput`)**:
   - Every `run<Name>Command` accepts `output?: CommandOutput` (defaulting to `defaultOutput`).
   - Do **NOT** call `console.log` / `console.error` directly inside commands or workflows; always route through `output` (only `src/utils/output.ts` and `src/cli.ts` call `console.*`).
3. **No `process.exitCode` mutation in runners**:
   - `run<Name>Command` functions **NEVER** read or write `process.exitCode`.
   - Return `{ ..., exitCode?: number }` for non-throwing non-zero exits (e.g., failed build, unauthenticated status) or throw `CliError(httpStatusCode, message, contents?)`.
   - Only `register<Name>Command` adapters and `src/cli.ts` translate `result.exitCode` / caught errors into `process.exitCode`.
4. **CLI flag & UX consistency**:
   - Support `--visibility <level>` as an alias for `--access <level>` on every command that sets Pen access (`init`, `new`, `push`, `sync`, `deploy`, `fork`, `info`).
   - Use `PEN_ACCESS_CHOICES` from `src/constants.ts` everywhere Pen visibility choices are rendered (`Private` = `"unlisted; anyone with the link can view it"`).
   - Every non-interactive/scriptable command supports `--json`, emitting `{ status: { code, message }, contents }` via `printJsonResponse`. `cdpn auth --json <subcommand>` inherits `--json` for `status`, `list`, `default`, and `logout` (while `auth login` stays interactive-only).
   - Use American single-L spelling (`Canceled`) for internal identifiers (`PromptCanceledError`, `isPromptCanceledError`, `action: 'canceled'`).

---

## 3. Security Invariants

1. **Filesystem containment**:
   - Always check candidate paths with `isWithinRoot(candidatePath, rootPath)` (candidate first, root second) and verify `fs.realpath()` containment before reading, writing, deleting, or serving files.
   - Never follow or delete symlinks escaping a Pen or site root (including symlinked `.codepen/`).
   - Never expose dotfiles (`.cdpn.json`, `.cdpn`, `.env`, `.git`, etc.) via `cdpn serve` or copy them into `cdpn build` output.
2. **Credentials & secrets**:
   - Store `~/.cdpn` with `0o600` permissions (POSIX), warn on group/world-readable permissions, and preserve global `config.shell` across profile login/logout.
   - Keep `AuthStore.profiles` as a null-prototype object (`Object.create(null)`) and validate profile names via `validateProfileName()` to block `__proto__`/`constructor`/`prototype`.
   - Never print raw API keys or Protected Pen passwords to stdout, stderr, `--json` envelopes, or `.cdpn.json`.
3. **Network, URLs, and Shell UI**:
   - Bind `cdpn serve` strictly to `127.0.0.1` (never `0.0.0.0`).
   - Enforce HTTPS-only URLs for API calls (with loopback HTTP allowed only for local mock testing), file downloads (no `Authorization` header on signed download URLs), and `openInBrowser`.
   - Keep `shell/` vanilla HTML/CSS/JS compatible with strict CSP (`script-src 'self'`, `style-src 'self'`); use safe DOM APIs (`textContent`, `createElement`, `<template>`), never `innerHTML`; HTML-escape any interpolated metadata.
   - Preserve any `TODO(security)` annotations unless explicitly resolved.

---

## 4. Packaging & Publishing Rules

- **Strictly CLI-only npm package**:
  - Runtime dependencies: `commander` only.
  - Dev dependencies: `typescript` and `@types/node` only (zero test frameworks or bundler dependencies).
  - `scripts/postbuild.js` prepares `./dist` as the publishable package directory with `bin: { cdpn: 'cli.js' }` and strips `main`, `types`, `exports`, `.d.ts`, and `.map` artifacts.
  - Always publish via `npm run pub` (verify first with `npm run pub:dry-run`). Direct `npm publish` from repo root is intentionally blocked by `prepublishOnly`.
- **TypeScript / ESM conventions**:
  - `"module": "NodeNext"` and `"verbatimModuleSyntax": true` — all relative imports must include `.js` extensions, and type-only imports must use `import type`.

---

## 5. Testing Guidelines

- Tests use Node's built-in `node:test` + `node:assert/strict` and mirror `src/` under `test/`:
  - `test/api/`, `test/commands/`, `test/config/`, `test/packaging/`, `test/site/`, `test/sync/`, `test/utils/`, `test/workflows/`.
  - Shared test utilities live in `test/helpers/` (`temp-dir.ts`, `output.ts`, `mock-codepen-api.ts`).
- **No global monkey-patching in tests**:
  - Use `createBufferedOutput()` / `createSilentOutput()` + `parseJsonOutput()` instead of overwriting `console.log`.
  - Assert returned `result.exitCode` (or thrown `CliError`) instead of mutating or saving/restoring `process.exitCode`.
- Run full verification before finishing any change:
  ```bash
  npm run typecheck && npm test
  ```
