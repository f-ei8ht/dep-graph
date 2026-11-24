import { z } from "zod";

/**
 * Zod schemas for tolerant parsing of any toolkit's tool catalog.
 */
export const RawParamSchema = z
  .object({
    type: z.any().optional(),
    description: z.string().optional(),
    title: z.string().optional(),
    examples: z.array(z.any()).optional(),
    enum: z.array(z.any()).optional(),
  })
  .passthrough();

export const RawInputParametersSchema = z
  .object({
    type: z.string().optional(),
    properties: z.record(z.string(), RawParamSchema).optional(),
    required: z.array(z.string()).optional(),
  })
  .passthrough();

export const RawToolSchema = z
  .object({
    slug: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    inputParameters: RawInputParametersSchema.optional(),
    parameters: RawInputParametersSchema.optional(),
    input_schema: RawInputParametersSchema.optional(),
    outputParameters: z.record(z.string(), z.any()).optional(),
    output_schema: z.record(z.string(), z.any()).optional(),
    tags: z.array(z.string()).optional(),
    function: z
      .object({
        name: z.string().optional(),
        description: z.string().optional(),
        parameters: RawInputParametersSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const GraphNodeSchema = z.object({
  id: z.string().min(1),
  service: z.string().optional(),
});

export const GraphEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().min(1),
});

export const DependencyGraphSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
});

export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
export type DependencyGraph = z.infer<typeof DependencyGraphSchema>;

/**
 * Normalized internal domain types (Pure Functional Core).
 */
export interface Param {
  name: string;
  required: boolean;
  type: string;
  description: string;
  isEnum: boolean;
}

export interface Tool {
  slug: string;
  name: string;
  description: string;
  service: string;
  verb: "LIST" | "GET" | "SEARCH" | "FIND" | "CREATE" | "UPDATE" | "DELETE" | "ACTION";
  tokens: string[];
  inputs: Param[];
  requiredParams: string[];
  outputFields: Set<string>;
  outputPaths: Set<string>;
  outputObjects: Set<string>;
  tags: string[];
}

export interface CandidateProducer {
  tool: Tool;
  score: number;
  reasons: string[];
}

export interface ConsumerNeed {
  consumer: Tool;
  param: Param;
  entityTokens: string[];
  idSuffix: string;
  candidates: CandidateProducer[];
}

export interface ScoredEdge extends GraphEdge {
  confidence: number;
  strategy: string;
}

/**
 * Strategy Pattern: interchangeable edge-finding strategies.
 */
export interface EdgeStrategy {
  readonly name: string;
  propose(tools: Tool[], needs: ConsumerNeed[]): ScoredEdge[];
}

/**
 * Dependency Inversion: Judge interface for refining or scoring proposed edges.
 */
export interface EdgeJudge {
  readonly name: string;
  refine(tools: Tool[], needs: ConsumerNeed[], proposed: ScoredEdge[]): Promise<ScoredEdge[]>;
}
