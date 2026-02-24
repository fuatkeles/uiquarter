# UIQuarter

Static analysis CLI for UI codebases. Extracts component patterns, dependency graphs, architectural insights, and generates AI-optimized context files for any coding assistant.

Supports React, Vue, Svelte, Angular, Next.js, Nuxt, SvelteKit, Solid, Lit, Qwik, and backend patterns (API routes, database models, auth, env config).

## Install

```bash
npm install -g uiquarter
```

Requires Node.js >= 18.

## Quick Start

```bash
# Analyze your project
uiquarter init

# Query the analysis
uiquarter query stats
uiquarter query hubs
uiquarter query component Button

# Resolve a task to relevant patterns
uiquarter resolve "add a modal dialog"

# Generate AI tool context files
uiquarter generate --target all

# Detect drift between analysis snapshots
uiquarter drift --save          # save baseline
uiquarter drift                 # compare current vs baseline

# Run as MCP server for AI tool integration
uiquarter serve
uiquarter serve --transport http --port 3100
```

## Commands

### `uiquarter init`

Run the full analysis pipeline: file discovery, analyzer orchestration, normalization, indexing, and insight generation. Produces a `.uiq/` directory with the intelligence index.

```bash
uiquarter init -d ./my-project
uiquarter init --no-cache       # skip cache, full re-analysis
uiquarter init --debug          # show timing and diagnostics
```

### `uiquarter query <subcommand>`

Query the intelligence index.

```bash
uiquarter query stats                    # project statistics
uiquarter query component <name>         # find a component
uiquarter query deps <name>              # list dependencies
uiquarter query dependents <name>        # list dependents
uiquarter query hubs                     # hub components
uiquarter query chains                   # deep dependency chains
uiquarter query insights [type]          # architectural insights
```

### `uiquarter resolve <task>`

Match a free-form task description to relevant patterns using inverted index + synonym + fuzzy matching.

```bash
uiquarter resolve "add dark mode toggle"
uiquarter resolve "fix modal accessibility" --synonyms --fuzzy
uiquarter resolve "refactor button" --debug --format md
```

### `uiquarter explain`

Print a human-readable project architecture summary.

```bash
uiquarter explain -d ./my-project
```

### `uiquarter prompt`

Generate AI-optimized architecture context with optional token budget.

```bash
uiquarter prompt --budget 2000 --format md
```

### `uiquarter export`

Export analysis data to disk.

```bash
uiquarter export -t context --format json --out context.json
uiquarter export -t resolve --task "add modal" --format md
```

### `uiquarter generate`

Generate AI tool context files from the analysis.

```bash
uiquarter generate --target all         # all 7 targets
uiquarter generate --target claude      # only CLAUDE.md
uiquarter generate --target cursor      # only .cursorrules
uiquarter generate --dry-run            # preview without writing
```

Supported targets:

| Target | Output File |
|--------|-------------|
| `claude` | `CLAUDE.md` |
| `codex` | `AGENTS.md` |
| `cursor` | `.cursorrules` |
| `windsurf` | `.windsurfrules` |
| `cline` | `.clinerules` |
| `copilot` | `.github/copilot-instructions.md` |
| `aider` | `CONVENTIONS.md` |

### `uiquarter watch`

Watch for file changes and re-analyze incrementally.

```bash
uiquarter watch -d ./my-project --debounce 500 --verbose
```

### `uiquarter drift`

Detect changes between a saved baseline snapshot and the current analysis.

```bash
uiquarter drift --save                  # capture baseline
uiquarter drift                         # compare current vs baseline
uiquarter drift --format json           # machine-readable output
uiquarter drift --compare main          # compare against another branch
```

### `uiquarter serve`

Start an MCP (Model Context Protocol) server for real-time AI tool integration.

```bash
uiquarter serve                                # stdio transport (default)
uiquarter serve --transport http --port 3100   # HTTP transport
```

### `uiquarter ci`

Run CI/CD analysis — detect regressions and optionally post PR comments.

```bash
uiquarter ci                             # check for regressions
uiquarter ci --fail-on warning           # fail on warnings too
uiquarter ci --format md --output report.md
uiquarter ci --pr 42 --repo owner/repo   # post PR comment
uiquarter ci --template                  # print GitHub Action template
```

### `uiquarter lint`

Check project conventions against configurable rules.

```bash
uiquarter lint                           # check conventions
uiquarter lint --format md               # markdown output
uiquarter lint --format json             # machine-readable output
```

Configure rules in `.uiqrc.json`:

```json
{
  "rules": {
    "file-naming": { "enabled": true },
    "barrel-exports": { "enabled": true },
    "circular-deps": { "enabled": true },
    "min-accessibility": { "enabled": true, "threshold": 0.5 }
  }
}
```

### `uiquarter report`

Generate a self-contained HTML dashboard with dependency graphs, component tables, and insights.

```bash
uiquarter report                         # generate report.html
uiquarter report --output dashboard.html
uiquarter report --open                  # open in browser after generating
```

## Architecture

```
CLI Command
  |
  v
FileDiscovery ---- .uiqignore, symlinks, deterministic ordering
  |
  v
AnalyzerOrchestrator ---- dependency graph, parallel execution, timeouts
  |
  v
20 Analyzers (Core + Framework + Backend + Quality)
  |
  v
Normalizer ---- canonical output format, deterministic serialization
  |
  v
CacheLayer ---- SHA-256 hashing, analyzer versioning, corruption recovery
  |
  v
IntelligenceIndexer ---- pattern merging, confidence scoring, .uiq/ output
  |
  v
InsightEngine ---- hub detection, orphans, cycles, deep chains, smells
  |
  v
QueryEngine ---- inverted index, synonym/fuzzy matching, token budget
  |
  v
Generate/Export ---- CLAUDE.md, AGENTS.md, .cursorrules, etc.
  |
  v
MCP Server ---- stdio/HTTP transport, real-time AI tool integration
```

## Analyzers

All analyzers implement the `Analyzer` interface with `fileFilter`, `capabilities`, and `dependencies`. The orchestrator resolves the dependency graph and runs independent analyzers in parallel.

### Core

| Analyzer | Capabilities |
|----------|-------------|
| ImportAnalyzer | imports, barrels, re-exports |
| ComponentAnalyzer | React, Vue, Svelte component detection, props, hooks |
| StylingAnalyzer | Tailwind, CSS Modules, styled-components, inline styles |
| FileStructureAnalyzer | directory roles, naming conventions, co-location |
| DependencyAnalyzer | render, hook, HOC, provider edges |
| StructureAnalyzer | file-level structure heuristics |
| UxAnalyzer | accessibility, error/loading/empty states, responsive, navigation |

### Framework

| Analyzer | Capabilities |
|----------|-------------|
| NextjsAnalyzer | pages, app router, API routes, middleware, layouts |
| NuxtAnalyzer | pages, composables, server routes, middleware |
| SvelteKitAnalyzer | routes, load functions, server endpoints |
| AngularAnalyzer | components, services, modules, directives, pipes, routes |
| SolidAnalyzer | signals, effects, resources, stores, control flow |
| LitAnalyzer | custom elements, shadow DOM, properties, reactive controllers |
| QwikAnalyzer | resumable components, signals, server functions, routes |

### Backend

| Analyzer | Capabilities |
|----------|-------------|
| ApiRouteAnalyzer | Express, Fastify, NestJS, Hono, tRPC, GraphQL |
| DatabaseAnalyzer | Prisma, TypeORM, Drizzle, Sequelize, Mongoose |
| AuthAnalyzer | JWT, sessions, OAuth, guards, RBAC |
| EnvConfigAnalyzer | .env parsing, secret detection, validation |

### Quality

| Analyzer | Capabilities |
|----------|-------------|
| CoverageAnalyzer | LCOV, Istanbul coverage mapping |
| PerformanceAnalyzer | React DevTools profiler, Lighthouse scores |

## MCP Server

UIQuarter includes a Model Context Protocol server for real-time integration with AI coding tools. Exposes tools (`query`, `scope-context`) and resources (`stats`, `insights`, `components`) over stdio or HTTP.

```bash
# Use with Claude Code
uiquarter serve

# Use over HTTP (for custom integrations)
uiquarter serve --transport http --port 3100
```

## Output Structure

```
.uiq/
  index.json          # master intelligence index
  meta.json           # hash, timestamps, stats, build number
  insights.json       # architectural insights
  snapshot.json       # drift detection baseline (after drift --save)
  cache/              # analyzer result cache
  patterns/           # per-pattern detail files
```

## Development

```bash
npm install
npm run build         # tsup dual ESM+CJS build
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm test              # 36 test files, 500+ tests
npm run dev           # tsup --watch
```

## License

MIT
