<p align="center">
  <img src="https://raw.githubusercontent.com/fuatkeles/uiquarter/master/logo.svg" alt="UIQuarter" width="120" />
</p>

<h1 align="center">UIQuarter</h1>

<p align="center">
  <strong>Your AI doesn't know your codebase. Fix that.</strong>
</p>

<p align="center">
  Static analysis CLI that extracts component patterns, dependency graphs, and architectural insights from UI codebases — then generates optimized context files for every major AI coding assistant.
</p>

<p align="center">
  <a href="https://uiquarter.com">Website</a> · <a href="https://uiquarter.com/docs">Docs</a> · <a href="https://uiquarter.com/about">About</a>
</p>

---

## Why UIQuarter?

AI coding assistants waste thousands of tokens exploring your project structure through trial and error. UIQuarter analyzes your codebase once and generates a single context file that gives any AI instant understanding.

**Real benchmark** on an 11-file React project (71,322 chars):

| Metric | Without UIQuarter | With UIQuarter | Improvement |
|--------|:-----------------:|:--------------:|:-----------:|
| Context tokens | ~17,800 | ~325 | **98% less** |
| Exploration steps | 12 calls | 1 read | **12x fewer** |
| Time to context | ~36s | ~4s | **9x faster** |
| Component resolution | 0/4 | 4/4 | **100%** |
| Dependencies mapped | 0 | 10 | **10 found** |
| Architecture insights | 0 | 5 | **5 found** |

> 71,322 characters compressed to 1,299 characters of structured context — **55x compression ratio**.

---

## Install

```bash
npm install -g uiquarter
```

Requires Node.js >= 18. Works on macOS, Linux, and Windows.

## Quick Start

```bash
# 1. Analyze your project
uiquarter init

# 2. Generate context for all AI tools
uiquarter generate --target all

# 3. Done — your AI now knows your codebase
```

---

## At a Glance

| | |
|---|---|
| **20** Analyzers | Core, Framework, Backend, Quality |
| **13** Commands | Analyze, query, generate, lint, drift, CI |
| **7** AI Targets | Claude, Codex, Cursor, Windsurf, Cline, Copilot, Aider |
| **500+** Tests | 36 test files, deterministic output |
| **10** Frameworks | React, Vue, Svelte, Angular, Next.js, Nuxt, SvelteKit, Solid, Lit, Qwik |

---

## AI Targets

One command generates context files for every major coding assistant:

```bash
uiquarter generate --target all
```

| Target | Output File | Tool |
|--------|-------------|------|
| `claude` | `CLAUDE.md` | Claude Code |
| `codex` | `AGENTS.md` | OpenAI Codex |
| `cursor` | `.cursorrules` | Cursor |
| `windsurf` | `.windsurfrules` | Windsurf |
| `cline` | `.clinerules` | Cline |
| `copilot` | `.github/copilot-instructions.md` | GitHub Copilot |
| `aider` | `CONVENTIONS.md` | Aider |

---

## Commands

### Analysis

**`uiquarter init`** — Run the full analysis pipeline: file discovery, 20 analyzers, normalization, indexing, and insight generation.

```bash
uiquarter init -d ./my-project
uiquarter init --no-cache          # skip cache, full re-analysis
uiquarter init --debug             # show timing and diagnostics
```

**`uiquarter watch`** — Watch for file changes and re-analyze incrementally.

```bash
uiquarter watch -d ./my-project --debounce 500 --verbose
```

**`uiquarter explain`** — Print a human-readable project architecture summary.

```bash
uiquarter explain -d ./my-project
```

### Querying

**`uiquarter query`** — Query the intelligence index.

```bash
uiquarter query stats                    # project statistics
uiquarter query component <name>         # find a component
uiquarter query deps <name>              # list dependencies
uiquarter query dependents <name>        # list dependents
uiquarter query hubs                     # hub components
uiquarter query chains                   # deep dependency chains
uiquarter query insights [type]          # architectural insights
```

**`uiquarter resolve`** — Match a free-form task to relevant patterns using inverted index + synonym + fuzzy matching.

```bash
uiquarter resolve "add dark mode toggle"
uiquarter resolve "fix modal accessibility" --synonyms --fuzzy
uiquarter resolve "refactor button" --debug --format md
```

**`uiquarter prompt`** — Generate AI-optimized architecture context with optional token budget.

```bash
uiquarter prompt --budget 2000 --format md
```

### Generation

**`uiquarter generate`** — Generate AI tool context files from the analysis.

```bash
uiquarter generate --target all         # all 7 targets
uiquarter generate --target claude      # only CLAUDE.md
uiquarter generate --target cursor      # only .cursorrules
uiquarter generate --dry-run            # preview without writing
```

**`uiquarter report`** — Generate a self-contained HTML dashboard with dependency graphs, component tables, and insights.

```bash
uiquarter report
uiquarter report --output dashboard.html
uiquarter report --open                 # open in browser after generating
```

### DevOps

**`uiquarter ci`** — CI/CD analysis — detect regressions and optionally post PR comments.

```bash
uiquarter ci                             # check for regressions
uiquarter ci --fail-on warning           # fail on warnings too
uiquarter ci --format md --output report.md
uiquarter ci --pr 42 --repo owner/repo   # post PR comment
uiquarter ci --template                  # print GitHub Action template
```

**`uiquarter drift`** — Detect changes between a saved baseline snapshot and the current analysis.

```bash
uiquarter drift --save                  # capture baseline
uiquarter drift                         # compare current vs baseline
uiquarter drift --format json           # machine-readable output
uiquarter drift --compare main          # compare against another branch
```

**`uiquarter lint`** — Check project conventions against configurable rules.

```bash
uiquarter lint
uiquarter lint --format md
uiquarter lint --format json
```

**`uiquarter serve`** — Start an MCP (Model Context Protocol) server for real-time AI tool integration.

```bash
uiquarter serve                                # stdio transport (default)
uiquarter serve --transport http --port 3100   # HTTP transport
```

---

## Architecture

```
CLI Command
  │
  ▼
FileDiscovery ──── .uiqignore, symlinks, deterministic ordering
  │
  ▼
AnalyzerOrchestrator ──── dependency graph, parallel execution, timeouts
  │
  ▼
20 Analyzers (Core + Framework + Backend + Quality)
  │
  ▼
Normalizer ──── canonical output format, deterministic serialization
  │
  ▼
CacheLayer ──── SHA-256 hashing, analyzer versioning, corruption recovery
  │
  ▼
IntelligenceIndexer ──── pattern merging, confidence scoring, .uiq/ output
  │
  ▼
InsightEngine ──── hub detection, orphans, cycles, deep chains, smells
  │
  ▼
QueryEngine ──── inverted index, synonym/fuzzy matching, token budget
  │
  ▼
Generate/Export ──── CLAUDE.md, AGENTS.md, .cursorrules, etc.
  │
  ▼
MCP Server ──── stdio/HTTP transport, real-time AI tool integration
```

---

## Analyzers

20 analyzers organized into 4 categories. All implement the `Analyzer` interface with `fileFilter`, `capabilities`, and `dependencies`. The orchestrator resolves the dependency graph and runs independent analyzers in parallel.

<details>
<summary><strong>Core (7)</strong></summary>

| Analyzer | Capabilities |
|----------|-------------|
| ImportAnalyzer | imports, barrels, re-exports |
| ComponentAnalyzer | React, Vue, Svelte component detection, props, hooks |
| StylingAnalyzer | Tailwind, CSS Modules, styled-components, inline styles |
| FileStructureAnalyzer | directory roles, naming conventions, co-location |
| DependencyAnalyzer | render, hook, HOC, provider edges |
| StructureAnalyzer | file-level structure heuristics |
| UxAnalyzer | accessibility, error/loading/empty states, responsive, navigation |

</details>

<details>
<summary><strong>Framework (7)</strong></summary>

| Analyzer | Capabilities |
|----------|-------------|
| NextjsAnalyzer | pages, app router, API routes, middleware, layouts |
| NuxtAnalyzer | pages, composables, server routes, middleware |
| SvelteKitAnalyzer | routes, load functions, server endpoints |
| AngularAnalyzer | components, services, modules, directives, pipes, routes |
| SolidAnalyzer | signals, effects, resources, stores, control flow |
| LitAnalyzer | custom elements, shadow DOM, properties, reactive controllers |
| QwikAnalyzer | resumable components, signals, server functions, routes |

</details>

<details>
<summary><strong>Backend (4)</strong></summary>

| Analyzer | Capabilities |
|----------|-------------|
| ApiRouteAnalyzer | Express, Fastify, NestJS, Hono, tRPC, GraphQL |
| DatabaseAnalyzer | Prisma, TypeORM, Drizzle, Sequelize, Mongoose |
| AuthAnalyzer | JWT, sessions, OAuth, guards, RBAC |
| EnvConfigAnalyzer | .env parsing, secret detection, validation |

</details>

<details>
<summary><strong>Quality (2)</strong></summary>

| Analyzer | Capabilities |
|----------|-------------|
| CoverageAnalyzer | LCOV, Istanbul coverage mapping |
| PerformanceAnalyzer | React DevTools profiler, Lighthouse scores |

</details>

---

## Configuration

Create a `.uiqrc.json` in your project root:

```json
{
  "rules": {
    "file-naming": { "enabled": true },
    "dir-naming": { "enabled": true },
    "barrel-exports": { "enabled": true },
    "circular-deps": { "enabled": true },
    "single-styling": { "enabled": true },
    "min-accessibility": { "enabled": true, "threshold": 0.5 },
    "max-nesting-depth": { "enabled": true, "limit": 8 }
  }
}
```

---

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

---

## MCP Server

UIQuarter includes a Model Context Protocol server for real-time integration with AI coding tools.

| Tool | Description |
|------|-------------|
| `uiq_scope_context` | Task-scoped architectural context under a token budget |
| `uiq_query_component` | Full component details with deps, dependents, and types |
| `uiq_resolve_task` | Free-form task to relevant files with scored matches |
| `uiq_find_insights` | Architectural issues filtered by severity and type |

```bash
uiquarter serve                                # stdio (for Claude Code)
uiquarter serve --transport http --port 3100   # HTTP (for custom integrations)
```

---

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
