import { z } from "zod";
import { Param, RawToolSchema, Tool } from "./types.js";

const HINT_TAGS = new Set([
  "openworldhint",
  "mcpignore",
  "readonlyhint",
  "idempotenthint",
  "updatehint",
  "destructivehint",
  "createhint",
  "important",
  "deprecated",
  "graphql",
  "mutation",
]);

const STOP_WORDS = new Set([
  "A",
  "AN",
  "THE",
  "FOR",
  "IN",
  "ON",
  "TO",
  "FROM",
  "OF",
  "BY",
  "WITH",
  "ALL",
  "AND",
  "OR",
  "AS",
  "AT",
  "IS",
  "ARE",
]);

const SERVICE_SYNONYMS: Record<string, string> = {
  repositories: "repos",
  repository: "repos",
  repository_management: "repos",
  pull_requests: "pulls",
  pull_request: "pulls",
  pull_request_management: "pulls",
  organizations: "orgs",
  organization: "orgs",
  organization_management: "orgs",
  user: "users",
  user_management: "users",
  users_and_access: "users",
  team_management: "teams",
  package_management: "packages",
  release_management: "releases",
  environment_management: "environments",
  deployments_and_environments: "deployments",
  workflow: "workflows",
  workflow_management: "workflows",
  workflow_and_automation_management: "actions",
  check_suites_runs: "checks",
  code_spaces: "codespaces",
  project: "projects",
  project_and_card_management: "projects",
  issue_types: "issues",
  label_and_milestone_management: "issues",
  labels_and_milestones: "issues",
  webhooks_and_deliveries: "webhooks",
  secrets_management: "secrets",
  security_and_protection_management: "security",
  commits_and_activity: "commits",
};

/**
 * Singularize common English plural forms so tokens match cleanly (e.g. ISSUES -> ISSUE, REPOSITORIES -> REPOSITORY).
 */
export function singularize(word: string): string {
  const w = word.toUpperCase();
  if (w.length <= 3) return w;
  if (w.endsWith("IES") && w.length > 4) return w.slice(0, -3) + "Y";
  if (w.endsWith("USES") || w.endsWith("SSES") || w.endsWith("CHES") || w.endsWith("SHES")) {
    return w.slice(0, -2);
  }
  if (w.endsWith("S") && !w.endsWith("SS") && !w.endsWith("US") && !w.endsWith("IS")) {
    return w.slice(0, -1);
  }
  return w;
}

/**
 * Split camelCase and snake_case identifiers into uppercase singular tokens.
 */
export function tokenizeIdentifier(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
}

function classifyVerb(tokens: string[]): Tool["verb"] {
  // Look at the first 3 tokens (after toolkit prefix) for action verb
  const head = tokens.slice(0, 3);
  if (head.includes("LIST")) return "LIST";
  if (head.includes("SEARCH")) return "SEARCH";
  if (head.includes("FIND") || head.includes("LOOKUP")) return "FIND";
  if (head.includes("GET") || head.includes("READ") || head.includes("FETCH")) return "GET";
  if (head.includes("CREATE") || head.includes("ADD") || head.includes("GENERATE")) return "CREATE";
  if (head.includes("DELETE") || head.includes("REMOVE") || head.includes("CLEAR")) return "DELETE";
  if (head.includes("UPDATE") || head.includes("SET") || head.includes("EDIT")) return "UPDATE";
  return "ACTION";
}

function extractOutputSchemaInfo(outputSchema: Record<string, any> | undefined): {
  fields: Set<string>;
  paths: Set<string>;
  objects: Set<string>;
} {
  const fields = new Set<string>();
  const paths = new Set<string>();
  const objects = new Set<string>();

  if (!outputSchema || typeof outputSchema !== "object") {
    return { fields, paths, objects };
  }

  const defs = outputSchema.$defs ?? outputSchema.definitions ?? {};

  function walk(schema: any, prefix: string, depth: number, visitedRefs: Set<string>) {
    if (!schema || typeof schema !== "object" || depth > 6) return;

    if (typeof schema.$ref === "string") {
      const refName = schema.$ref.split("/").pop() ?? "";
      if (refName) {
        objects.add(refName);
        if (!visitedRefs.has(refName) && defs[refName]) {
          const nextVisited = new Set(visitedRefs);
          nextVisited.add(refName);
          walk(defs[refName], prefix, depth + 1, nextVisited);
        }
      }
      return;
    }

    if (schema.type === "array" && schema.items) {
      walk(schema.items, prefix, depth + 1, visitedRefs);
      return;
    }

    for (const key of ["anyOf", "oneOf", "allOf"]) {
      if (Array.isArray(schema[key])) {
        for (const sub of schema[key]) {
          walk(sub, prefix, depth + 1, visitedRefs);
        }
      }
    }

    const props = schema.properties;
    if (props && typeof props === "object") {
      for (const [propName, propVal] of Object.entries<any>(props)) {
        if (propName === "error" || propName === "successful") continue;
        fields.add(propName);
        const nextPrefix = propName === "data" ? prefix : prefix ? `${prefix}.${propName}` : propName;
        if (nextPrefix) paths.add(nextPrefix);
        walk(propVal, nextPrefix, depth + 1, visitedRefs);
      }
    }
  }

  walk(outputSchema, "", 0, new Set());
  return { fields, paths, objects };
}

function inferService(slugTokens: string[], tags: string[]): string {
  const domainTags = tags.filter((t) => !HINT_TAGS.has(t.toLowerCase()));
  if (domainTags.length > 0) {
    const shortLower = domainTags.find((t) => t === t.toLowerCase() && !t.includes(" "));
    const raw = (shortLower ?? domainTags[0])
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
    return SERVICE_SYNONYMS[raw] ?? raw;
  }

  const verbStop = new Set([
    ...STOP_WORDS,
    "LIST",
    "GET",
    "CREATE",
    "UPDATE",
    "DELETE",
    "REMOVE",
    "ADD",
    "SET",
    "CHECK",
    "FIND",
    "SEARCH",
    "ENABLE",
    "DISABLE",
    "VERIFY",
    "CANCEL",
    "APPROVE",
    "DISMISS",
    "MERGE",
    "DOWNLOAD",
    "UPLOAD",
  ]);
  const nouns = slugTokens.filter((t) => !verbStop.has(t));
  const candidate = (nouns[nouns.length - 1] ?? nouns[0] ?? "general").toLowerCase();
  return SERVICE_SYNONYMS[candidate] ?? candidate;
}

/**
 * Detect common toolkit prefix (e.g. "GITHUB_") across tools in the catalog so entity tokenization works for any toolkit.
 */
function detectToolkitPrefix(slugs: string[]): string | null {
  if (slugs.length < 2) return null;
  const firstTokens = slugs.map((s) => s.split("_")[0]).filter(Boolean);
  const counts = new Map<string, number>();
  for (const t of firstTokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  let best = "";
  let bestCount = 0;
  for (const [k, c] of counts.entries()) {
    if (c > bestCount) {
      best = k;
      bestCount = c;
    }
  }
  return bestCount >= slugs.length * 0.6 ? best : null;
}

/**
 * Adapter Pattern: Parse any toolkit's raw catalog JSON into normalized Tool objects.
 */
export function loadCatalog(rawData: unknown): Tool[] {
  const rawArray: unknown[] = Array.isArray(rawData)
    ? rawData
    : typeof rawData === "object" && rawData !== null
      ? ((rawData as any).tools ?? (rawData as any).items ?? (rawData as any).actions ?? [])
      : [];

  const parsedRaw = rawArray
    .map((item) => {
      const res = RawToolSchema.safeParse(item);
      return res.success ? res.data : null;
    })
    .filter((t): t is z.infer<typeof RawToolSchema> => t !== null);

  const rawSlugs = parsedRaw
    .map((t) => t.slug ?? t.name ?? t.function?.name)
    .filter((s): s is string => typeof s === "string" && s.length > 0);

  const toolkitPrefix = detectToolkitPrefix(rawSlugs);

  const tools: Tool[] = [];
  for (const raw of parsedRaw) {
    const slug = raw.slug ?? raw.name ?? raw.function?.name;
    if (!slug) continue;

    const allTokens = tokenizeIdentifier(slug);
    const strippedTokens =
      toolkitPrefix && allTokens[0] === toolkitPrefix && allTokens.length > 1
        ? allTokens.slice(1)
        : allTokens;

    const verb = classifyVerb(strippedTokens);
    const semanticTokens = strippedTokens
      .filter((t) => !STOP_WORDS.has(t))
      .map((t) => singularize(t));

    const inputSchema =
      raw.inputParameters ?? raw.parameters ?? raw.input_schema ?? raw.function?.parameters;
    const reqSet = new Set<string>(inputSchema?.required ?? []);
    const props = inputSchema?.properties ?? {};

    const inputs: Param[] = Object.entries(props).map(([paramName, pSchema]) => ({
      name: paramName,
      required: reqSet.has(paramName),
      type: typeof pSchema?.type === "string" ? pSchema.type : "string",
      description: pSchema?.description ?? pSchema?.title ?? "",
      isEnum: Array.isArray(pSchema?.enum) && pSchema.enum.length > 0,
    }));

    // Ensure required params that weren't listed in properties are still represented
    for (const reqName of reqSet) {
      if (!props[reqName]) {
        inputs.push({
          name: reqName,
          required: true,
          type: "string",
          description: "",
          isEnum: false,
        });
      }
    }

    const outInfo = extractOutputSchemaInfo(raw.outputParameters ?? raw.output_schema);
    const tags = Array.isArray(raw.tags) ? raw.tags : [];

    tools.push({
      slug,
      name: raw.name ?? slug,
      description: raw.description ?? raw.function?.description ?? "",
      service: inferService(strippedTokens, tags),
      verb,
      tokens: semanticTokens,
      inputs,
      requiredParams: [...reqSet],
      outputFields: outInfo.fields,
      outputPaths: outInfo.paths,
      outputObjects: outInfo.objects,
      tags,
    });
  }

  return tools;
}
