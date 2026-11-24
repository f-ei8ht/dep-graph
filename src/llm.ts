import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import OpenAI from "openai";
import { ConsumerNeed, EdgeJudge, ScoredEdge, Tool } from "./types.js";

/**
 * Heuristic Judge (Fallback / Baseline in Chain of Responsibility).
 * Keeps top-scoring candidate producers per (consumer, param) pair with high precision.
 */
export class HeuristicJudge implements EdgeJudge {
  readonly name = "heuristic-judge";

  async refine(
    _tools: Tool[],
    _needs: ConsumerNeed[],
    proposed: ScoredEdge[],
  ): Promise<ScoredEdge[]> {
    // Deduplicate by (from, to, label) keeping highest confidence
    const bestByKey = new Map<string, ScoredEdge>();
    for (const edge of proposed) {
      const key = `${edge.from}:::${edge.to}:::${edge.label}`;
      const prev = bestByKey.get(key);
      if (!prev || edge.confidence > prev.confidence) {
        bestByKey.set(key, edge);
      }
    }

    // Group by (to, label) so we keep the top 3 producers per parameter
    const byConsumerParam = new Map<string, ScoredEdge[]>();
    for (const edge of bestByKey.values()) {
      const key = `${edge.to}:::${edge.label}`;
      const list = byConsumerParam.get(key) ?? [];
      list.push(edge);
      byConsumerParam.set(key, list);
    }

    const result: ScoredEdge[] = [];
    for (const list of byConsumerParam.values()) {
      list.sort((a, b) => b.confidence - a.confidence || a.from.localeCompare(b.from));
      const topConf = list[0]?.confidence ?? 0;
      const kept = list
        .filter((e) => e.confidence >= Math.max(0.5, topConf - 0.25))
        .slice(0, 3);
      result.push(...kept);
    }

    return result;
  }
}

/**
 * OpenAI LLM Judge: batches consumer needs and asks the LLM to select valid producer edges.
 */
export class OpenAiJudge implements EdgeJudge {
  readonly name = "openai-llm-judge";
  private client: OpenAI;
  private model: string;

  constructor(baseURL: string, apiKey: string, model = "openai/gpt-4o-mini") {
    this.client = new OpenAI({
      baseURL,
      apiKey,
      timeout: 20000,
      maxRetries: 1,
    });
    this.model = model;
  }

  async refine(
    tools: Tool[],
    needs: ConsumerNeed[],
    proposed: ScoredEdge[],
  ): Promise<ScoredEdge[]> {
    const heuristicFallback = await new HeuristicJudge().refine(tools, needs, proposed);

    // Focus LLM verification on ambiguous needs (where multiple candidates compete closely)
    const ambiguousNeeds = needs
      .filter((n) => n.candidates.length >= 2)
      .slice(0, 45);

    if (ambiguousNeeds.length === 0) {
      return heuristicFallback;
    }

    const batchSize = 15;
    const confirmedKeys = new Set<string>();
    const rejectedKeys = new Set<string>();

    for (let i = 0; i < ambiguousNeeds.length; i += batchSize) {
      const batch = ambiguousNeeds.slice(i, i + batchSize);
      const payload = batch.map((n) => ({
        consumer: n.consumer.slug,
        consumer_desc: n.consumer.description.slice(0, 120),
        param: n.param.name,
        param_desc: n.param.description.slice(0, 120),
        candidates: n.candidates.map((c) => ({
          slug: c.tool.slug,
          desc: c.tool.description.slice(0, 100),
        })),
      }));

      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are an API dependency analyzer. Given consumer tools, a required parameter, and candidate producer tools, return JSON: {\"edges\": [{\"from\": \"<CANDIDATE_SLUG>\", \"to\": \"<CONSUMER_SLUG>\", \"label\": \"<PARAM>\"}]}. Only select candidates that genuinely produce or list the identifier needed by the consumer parameter. Multiple valid producers per parameter are allowed.",
          },
          {
            role: "user",
            content: JSON.stringify(payload),
          },
        ],
      });

      const content = response.choices[0]?.message?.content;
      if (!content) continue;
      const parsed = JSON.parse(content);
      const llmEdges: Array<{ from?: string; to?: string; label?: string }> = Array.isArray(
        parsed?.edges,
      )
        ? parsed.edges
        : [];

      const validSelected = new Set<string>();
      for (const e of llmEdges) {
        if (e.from && e.to && e.label) {
          const k = `${e.from}:::${e.to}:::${e.label}`;
          validSelected.add(k);
          confirmedKeys.add(k);
        }
      }

      for (const n of batch) {
        const anyConfirmedForNeed = n.candidates.some((c) =>
          validSelected.has(`${c.tool.slug}:::${n.consumer.slug}:::${n.param.name}`),
        );
        if (anyConfirmedForNeed) {
          for (const c of n.candidates) {
            const k = `${c.tool.slug}:::${n.consumer.slug}:::${n.param.name}`;
            if (!validSelected.has(k)) {
              rejectedKeys.add(k);
            }
          }
        }
      }
    }

    return heuristicFallback.filter((edge) => {
      const k = `${edge.from}:::${edge.to}:::${edge.label}`;
      if (confirmedKeys.has(k)) return true;
      if (rejectedKeys.has(k)) return false;
      return true;
    });
  }
}

/**
 * Decorator Pattern: File-backed caching wrapper around any EdgeJudge.
 */
export class CachingJudge implements EdgeJudge {
  readonly name: string;
  constructor(
    private inner: EdgeJudge,
    private cachePath = ".cache/edge_judge_cache.json",
  ) {
    this.name = `caching(${inner.name})`;
  }

  async refine(
    tools: Tool[],
    needs: ConsumerNeed[],
    proposed: ScoredEdge[],
  ): Promise<ScoredEdge[]> {
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          slugs: tools.map((t) => t.slug),
          proposedCount: proposed.length,
        }),
      )
      .digest("hex")
      .slice(0, 16);

    try {
      if (existsSync(this.cachePath)) {
        const cache = JSON.parse(readFileSync(this.cachePath, "utf-8"));
        if (cache[hash]) {
          return cache[hash];
        }
      }
    } catch {
      // Ignore cache read errors
    }

    const result = await this.inner.refine(tools, needs, proposed);

    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      const existing = existsSync(this.cachePath)
        ? JSON.parse(readFileSync(this.cachePath, "utf-8"))
        : {};
      existing[hash] = result;
      writeFileSync(this.cachePath, JSON.stringify(existing, null, 2), "utf-8");
    } catch {
      // Ignore cache write errors
    }

    return result;
  }
}

/**
 * Chain of Responsibility / Fallback Decorator: tries primary judge, falls back to secondary judge on error.
 */
export class FallbackJudge implements EdgeJudge {
  readonly name: string;
  constructor(
    private primary: EdgeJudge,
    private fallback: EdgeJudge,
  ) {
    this.name = `fallback(${primary.name}->${fallback.name})`;
  }

  async refine(
    tools: Tool[],
    needs: ConsumerNeed[],
    proposed: ScoredEdge[],
  ): Promise<ScoredEdge[]> {
    try {
      return await this.primary.refine(tools, needs, proposed);
    } catch (err) {
      console.error(
        `[judge] ${this.primary.name} failed (${(err as Error).message}); falling back to ${this.fallback.name}`,
      );
      return await this.fallback.refine(tools, needs, proposed);
    }
  }
}

/**
 * Factory Pattern: Creates the best available EdgeJudge based on environment credentials.
 */
export function createEdgeJudge(): EdgeJudge {
  const heuristic = new HeuristicJudge();
  const apiKey =
    process.env.LITMUS_ASSESSMENT_TOKEN ||
    process.env.OPENAI_API_KEY ||
    process.env.OPENROUTER_API_KEY;
  const litmusUrl = process.env.LITMUS_API_URL
    ? `${process.env.LITMUS_API_URL.replace(/\/$/, "")}/proxy/openai/v1`
    : undefined;
  const baseURL = process.env.OPENAI_BASE_URL || litmusUrl || "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL || "openai/gpt-4o-mini";

  if (apiKey) {
    const llmJudge = new CachingJudge(new OpenAiJudge(baseURL, apiKey, model));
    return new FallbackJudge(llmJudge, heuristic);
  }

  return heuristic;
}
