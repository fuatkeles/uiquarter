import { QueryEngine } from "../query/QueryEngine.js";
import { ContextBuilder } from "../context/ContextBuilder.js";
import { TaskScopedBuilder } from "../context/TaskScopedBuilder.js";
import { stableStringify } from "../core/utils.js";
import type {
  McpToolDefinition,
  McpToolResult,
  McpResourceDefinition,
  RegisteredTool,
  RegisteredResource,
} from "./types.js";

// -----------------------------------------------------------------------------
// Tool definitions
// -----------------------------------------------------------------------------

const TOOL_DEFS: readonly McpToolDefinition[] = [
  {
    name: "uiq_query_component",
    description: "Find a UI component by name and return its full context including dependencies, dependents, and type information.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Component name to search for" },
      },
      required: ["name"],
    },
  },
  {
    name: "uiq_find_dependencies",
    description: "Get the direct dependencies of a component — what it imports and uses.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Component name" },
      },
      required: ["name"],
    },
  },
  {
    name: "uiq_find_dependents",
    description: "Get components that depend on (import/use) the given component.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Component name" },
      },
      required: ["name"],
    },
  },
  {
    name: "uiq_resolve_task",
    description: "Given a free-form task description, find the most relevant components. Returns scored matches.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task description (e.g. 'refactor the login form')" },
        fuzzy: { type: "string", description: "Enable fuzzy matching", enum: ["true", "false"], default: "false" },
        synonyms: { type: "string", description: "Enable synonym expansion", enum: ["true", "false"], default: "true" },
        maxResults: { type: "string", description: "Maximum number of results (default: 10)" },
      },
      required: ["task"],
    },
  },
  {
    name: "uiq_scope_context",
    description: "Get minimal, task-scoped architectural context. This is the most token-efficient way to understand relevant parts of the project for a specific task.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task description" },
        format: { type: "string", description: "Output format", enum: ["json", "text", "md"], default: "text" },
        charBudget: { type: "string", description: "Character budget for output" },
      },
      required: ["task"],
    },
  },
  {
    name: "uiq_get_insights",
    description: "Get architectural insights about the project, optionally filtered by type or severity.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: "Filter by insight type",
          enum: ["hub-component", "orphan-component", "dependency-cycle", "deep-dependency-chain", "mixed-styling", "architectural-smell"],
        },
        severity: {
          type: "string",
          description: "Filter by severity",
          enum: ["error", "warning", "info"],
        },
      },
    },
  },
  {
    name: "uiq_get_stats",
    description: "Get project statistics: total components, patterns, insights, and framework breakdown.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// -----------------------------------------------------------------------------
// Resource definitions
// -----------------------------------------------------------------------------

const RESOURCE_DEFS: readonly McpResourceDefinition[] = [
  {
    uri: "uiq://stats",
    name: "Project Statistics",
    description: "Component counts, insight counts, and framework breakdown",
    mimeType: "application/json",
  },
  {
    uri: "uiq://components",
    name: "Component List",
    description: "All discovered components with type and framework",
    mimeType: "application/json",
  },
  {
    uri: "uiq://insights",
    name: "Architectural Insights",
    description: "All architectural insights sorted by severity",
    mimeType: "application/json",
  },
];

// -----------------------------------------------------------------------------
// Handler factory
// -----------------------------------------------------------------------------

/**
 * Create MCP tool and resource handlers for a loaded project.
 *
 * The engine and contextBuilder must be loaded before calling this.
 */
export function createHandlers(
  engine: QueryEngine,
  contextBuilder: ContextBuilder,
): {
  tools: readonly RegisteredTool[];
  resources: readonly RegisteredResource[];
} {
  const scopedBuilder = new TaskScopedBuilder(engine);

  const toolHandlers: Record<string, RegisteredTool["handler"]> = {
    uiq_query_component: async (args) => {
      const name = String(args["name"] ?? "");
      if (name.length === 0) {
        return errorResult("Missing required parameter: name");
      }

      const pattern = engine.findComponent(name);
      if (pattern === null) {
        return textResult(`No component found with name "${name}".`);
      }

      const deps = engine.findDependencies(name);
      const dependents = engine.findDependents(name);

      return textResult(stableStringify({
        name: pattern.name,
        type: pattern.type,
        framework: pattern.framework,
        filePath: pattern.filePath,
        confidence: pattern.confidence.value,
        dependencies: deps.map((d) => ({ name: d.name, type: d.type, filePath: d.filePath })),
        dependents: dependents.map((d) => ({ name: d.name, type: d.type, filePath: d.filePath })),
        properties: pattern.properties,
      }));
    },

    uiq_find_dependencies: async (args) => {
      const name = String(args["name"] ?? "");
      if (name.length === 0) {
        return errorResult("Missing required parameter: name");
      }

      const deps = engine.findDependencies(name);
      if (deps.length === 0) {
        return textResult(`Component "${name}" has no dependencies (or not found).`);
      }

      return textResult(stableStringify(
        deps.map((d) => ({ name: d.name, type: d.type, framework: d.framework, filePath: d.filePath })),
      ));
    },

    uiq_find_dependents: async (args) => {
      const name = String(args["name"] ?? "");
      if (name.length === 0) {
        return errorResult("Missing required parameter: name");
      }

      const dependents = engine.findDependents(name);
      if (dependents.length === 0) {
        return textResult(`Component "${name}" has no dependents (or not found).`);
      }

      return textResult(stableStringify(
        dependents.map((d) => ({ name: d.name, type: d.type, framework: d.framework, filePath: d.filePath })),
      ));
    },

    uiq_resolve_task: async (args) => {
      const task = String(args["task"] ?? "");
      if (task.length === 0) {
        return errorResult("Missing required parameter: task");
      }

      const fuzzy = String(args["fuzzy"] ?? "false") === "true";
      const synonyms = String(args["synonyms"] ?? "true") === "true";
      const maxResults = parseInt(String(args["maxResults"] ?? "10"), 10) || 10;

      const results = engine.resolveTask(task, { fuzzy, synonyms });
      const top = results.slice(0, maxResults);

      if (top.length === 0) {
        return textResult("No matching components found for this task.");
      }

      return textResult(stableStringify(
        top.map((r) => ({
          patternId: r.patternId,
          score: r.score,
          matchedTokens: r.matchedTokens,
        })),
      ));
    },

    uiq_scope_context: async (args) => {
      const task = String(args["task"] ?? "");
      if (task.length === 0) {
        return errorResult("Missing required parameter: task");
      }

      const format = String(args["format"] ?? "text");
      const charBudget = args["charBudget"] !== undefined
        ? parseInt(String(args["charBudget"]), 10) || undefined
        : undefined;

      const options = { synonyms: true, charBudget };

      if (format === "md") {
        return textResult(scopedBuilder.buildMarkdown(task, options));
      }
      if (format === "json") {
        return textResult(stableStringify(scopedBuilder.build(task, options)));
      }
      return textResult(scopedBuilder.buildText(task, options));
    },

    uiq_get_insights: async (args) => {
      const typeFilter = args["type"] !== undefined ? String(args["type"]) : null;
      const severityFilter = args["severity"] !== undefined ? String(args["severity"]) : null;

      const allTypes = [
        "hub-component",
        "orphan-component",
        "dependency-cycle",
        "deep-dependency-chain",
        "mixed-styling",
        "architectural-smell",
      ] as const;

      const types = typeFilter !== null
        ? allTypes.filter((t) => t === typeFilter)
        : allTypes;

      const insights: Array<{
        type: string;
        severity: string;
        title: string;
        confidence: number;
      }> = [];

      for (const type of types) {
        const typeInsights = engine.findInsights(type);
        for (const insight of typeInsights) {
          if (severityFilter !== null && insight.severity !== severityFilter) continue;
          insights.push({
            type: insight.category,
            severity: insight.severity,
            title: insight.title,
            confidence: insight.confidence,
          });
        }
      }

      if (insights.length === 0) {
        return textResult("No insights found matching the given filters.");
      }

      return textResult(stableStringify(insights));
    },

    uiq_get_stats: async () => {
      const stats = engine.getStats();
      const project = contextBuilder.buildProjectContext();

      return textResult(stableStringify({
        totalPatterns: stats.totalPatterns,
        totalComponents: stats.totalComponents,
        totalInsights: stats.totalInsights,
        hubCount: project.summary.hubCount,
        deepChainCount: project.summary.deepChainCount,
      }));
    },
  };

  // Build registered tools
  const tools: RegisteredTool[] = TOOL_DEFS.map((def) => ({
    definition: def,
    handler: toolHandlers[def.name]!,
  }));

  // Build registered resources
  const resources: RegisteredResource[] = [
    {
      definition: RESOURCE_DEFS[0]!,
      handler: async () => {
        const stats = engine.getStats();
        return {
          contents: [{
            uri: "uiq://stats",
            mimeType: "application/json",
            text: stableStringify(stats),
          }],
        };
      },
    },
    {
      definition: RESOURCE_DEFS[1]!,
      handler: async () => {
        const project = contextBuilder.buildProjectContext();
        const components = project.components.map((c) => ({
          name: c.name,
          filePath: c.filePath,
          dependencyCount: c.dependencyCount,
          dependentCount: c.dependentCount,
          isHub: c.isHub,
          isOrphan: c.isOrphan,
        }));
        return {
          contents: [{
            uri: "uiq://components",
            mimeType: "application/json",
            text: stableStringify(components),
          }],
        };
      },
    },
    {
      definition: RESOURCE_DEFS[2]!,
      handler: async () => {
        const project = contextBuilder.buildProjectContext();
        return {
          contents: [{
            uri: "uiq://insights",
            mimeType: "application/json",
            text: stableStringify(project.insights),
          }],
        };
      },
    },
  ];

  return { tools, resources };
}

// -----------------------------------------------------------------------------
// Response helpers
// -----------------------------------------------------------------------------

function textResult(text: string): McpToolResult {
  return {
    content: [{ type: "text", text }],
  };
}

function errorResult(message: string): McpToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}
