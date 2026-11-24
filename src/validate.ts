import {
  DependencyGraph,
  DependencyGraphSchema,
  GraphEdge,
  GraphNode,
  ScoredEdge,
  Tool,
} from "./types.js";

/**
 * Builder Pattern: GraphBuilder enforces graph invariants:
 * - Only catalog slugs allowed as nodes/endpoints
 * - Every edge label must be a real input parameter of the consumer tool
 * - No self-loops or duplicate (from, to, label) edges
 * - Cycle detection & breaking (breaks weakest confidence edge in any cycle)
 * - Deterministic sorting of nodes and edges
 */
export class GraphBuilder {
  private toolBySlug = new Map<string, Tool>();
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, ScoredEdge>();

  constructor(tools: Tool[]) {
    for (const tool of tools) {
      this.toolBySlug.set(tool.slug, tool);
      this.nodes.set(tool.slug, {
        id: tool.slug,
        service: tool.service || "general",
      });
    }
  }

  addEdge(edge: ScoredEdge): this {
    // 1. Both endpoints must exist in the catalog
    const producer = this.toolBySlug.get(edge.from);
    const consumer = this.toolBySlug.get(edge.to);
    if (!producer || !consumer) return this;

    // 2. No self-loops
    if (edge.from === edge.to) return this;

    // 3. Label must be a real input parameter of the consumer
    const hasParam = consumer.inputs.some((p) => p.name === edge.label);
    if (!hasParam) return this;

    // 4. Deduplicate keeping highest confidence
    const key = `${edge.from}:::${edge.to}:::${edge.label}`;
    const existing = this.edges.get(key);
    if (!existing || edge.confidence > existing.confidence) {
      this.edges.set(key, edge);
    }

    return this;
  }

  addAll(edges: ScoredEdge[]): this {
    for (const edge of edges) {
      this.addEdge(edge);
    }
    return this;
  }

  /**
   * Break cycles by adding edges in descending order of confidence and rejecting
   * any edge that creates a directed path from `to` back to `from`.
   */
  private breakCycles(scoredEdges: ScoredEdge[]): GraphEdge[] {
    const sorted = [...scoredEdges].sort(
      (a, b) =>
        b.confidence - a.confidence ||
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to) ||
        a.label.localeCompare(b.label),
    );

    const adj = new Map<string, Set<string>>();
    const accepted: GraphEdge[] = [];

    function canReach(start: string, target: string): boolean {
      if (start === target) return true;
      const visited = new Set<string>([start]);
      const queue = [start];
      while (queue.length > 0) {
        const curr = queue.shift()!;
        const neighbors = adj.get(curr);
        if (!neighbors) continue;
        for (const nxt of neighbors) {
          if (nxt === target) return true;
          if (!visited.has(nxt)) {
            visited.add(nxt);
            queue.push(nxt);
          }
        }
      }
      return false;
    }

    for (const edge of sorted) {
      // If `edge.to` can already reach `edge.from`, adding `edge.from -> edge.to` creates a cycle
      if (canReach(edge.to, edge.from)) {
        continue;
      }
      let set = adj.get(edge.from);
      if (!set) {
        set = new Set();
        adj.set(edge.from, set);
      }
      set.add(edge.to);
      accepted.push({
        from: edge.from,
        to: edge.to,
        label: edge.label,
      });
    }

    return accepted;
  }

  build(): DependencyGraph {
    const cleanEdges = this.breakCycles([...this.edges.values()]);

    const sortedNodes = [...this.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
    const sortedEdges = cleanEdges.sort(
      (a, b) =>
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to) ||
        a.label.localeCompare(b.label),
    );

    return DependencyGraphSchema.parse({
      nodes: sortedNodes,
      edges: sortedEdges,
    });
  }
}

export function validateGraph(tools: Tool[], rawEdges: ScoredEdge[]): DependencyGraph {
  return new GraphBuilder(tools).addAll(rawEdges).build();
}
