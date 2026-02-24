# Changelog

All notable changes to UIQuarter will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-06-01

### Added

- **Core pipeline:** FileDiscovery, AnalyzerOrchestrator, normalizer, CacheLayer, IntelligenceIndexer
- **Analyzers:** StructureAnalyzer, ImportAnalyzer, ComponentAnalyzer, StylingAnalyzer, FileStructureAnalyzer, DependencyAnalyzer
- **Framework analyzers:** NextjsAnalyzer (App/Pages Router, Server/Client Components), NuxtAnalyzer (pages, composables, server routes), SvelteKitAnalyzer (routes, runes, load functions)
- **InsightEngine:** hub detection, orphan detection, cycle detection, deep chain analysis, god component detection, naming inconsistency detection
- **Query system:** InvertedIndex with exact/fuzzy/synonym search, ResolverScorer, QueryEngine
- **AI context generation:** PromptBuilder, BudgetPromptBuilder with token budget packing
- **Multi-target generate:** CLAUDE.md, AGENTS.md, .cursorrules, .windsurfrules, .clinerules, .github/copilot-instructions.md, CONVENTIONS.md
- **Context drift detection:** snapshot save/compare, text/markdown/JSON output
- **Schema migration:** versioned .uiq/ format with migration path support
- **CLI commands:** init, query, explain, prompt, resolve, watch, export, generate, drift
- **Watch mode:** file system watcher with incremental re-analysis and debouncing
- **Export:** context and resolve results in json/txt/md formats
