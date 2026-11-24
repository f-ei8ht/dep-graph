/**
 * Generator entrypoint. Read a toolkit catalog, infer its dependencies, write a graph.
 *
 * Pipeline Architecture:
 *   1. Adapter (catalog.ts): Parse and normalize raw toolkit catalog with Zod validation.
 *   2. Candidate Extractor & Strategies (candidates.ts): Identify consumer reference needs
 *      and propose producer->consumer edges using OutputSchemaStrategy + NameMatchStrategy.
 *   3. Dependency Injection Judge (llm.ts): Refine candidate edges via OpenAI LLM Judge
 *      (with Caching + Fallback Decorator to HeuristicJudge).
 *   4. GraphBuilder Validator (validate.ts): Enforce slug provenance, consumer param validity,
 *      self-loop/duplicate removal, cycle breaking, and deterministic ordering.
 *   5. Visualization (visualize.ts): Emit interactive Cytoscape HTML viewer (`graph.html`).
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { loadCatalog } from "./catalog.js";
import {
  findCandidates,
  NameMatchStrategy,
  OutputSchemaStrategy,
} from "./candidates.js";
import { createEdgeJudge } from "./llm.js";
import { DependencyGraph, EdgeJudge, EdgeStrategy } from "./types.js";
import { validateGraph } from "./validate.js";
import { writeVisualization } from "./visualize.js";

const CATALOG_PATH =
  process.argv.length > 2 ? process.argv[process.argv.length - 1] : undefined;
const OUT_PATH = resolve(process.cwd(), "dependency_graph.json");
const VIZ_PATH = resolve(process.cwd(), "graph.html");

export async function generateDependencyGraph(
  rawCatalog: unknown,
  strategies: EdgeStrategy[] = [new OutputSchemaStrategy(), new NameMatchStrategy()],
  judge: EdgeJudge = createEdgeJudge(),
): Promise<DependencyGraph> {
  const tools = loadCatalog(rawCatalog);
  const needs = findCandidates(tools);
  const proposed = strategies.flatMap((s) => s.propose(tools, needs));
  const refined = await judge.refine(tools, needs, proposed);
  return validateGraph(tools, refined);
}

async function main() {
  if (!CATALOG_PATH) {
    throw new Error("pass the toolkit catalog path as a CLI argument");
  }

  const rawData = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));
  const graph = await generateDependencyGraph(rawData);

  writeFileSync(OUT_PATH, JSON.stringify(graph, null, 2), "utf-8");
  writeVisualization(graph, VIZ_PATH);

  console.error(
    `wrote ${graph.nodes.length} nodes, ${graph.edges.length} edges to ${OUT_PATH} (and ${VIZ_PATH})`,
  );
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
