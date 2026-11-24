import { singularize, tokenizeIdentifier } from "./catalog.js";
import { CandidateProducer, ConsumerNeed, EdgeStrategy, Param, ScoredEdge, Tool } from "./types.js";

/**
 * Parameters that are typically user-supplied payloads, configuration flags, or top-level context
 * rather than precursor identifiers fetched from another tool.
 * Note: What about `owner`, `repo`, `org`, `username`? In standard REST / tool dependency graphs
 * (and as noted in the specification: "Separate them from things the user supplies directly (title, body, owner, repo)"),
 * `owner`, `repo`, `org`, `username`, `title`, `body`, `name`, `state`, `message`, `content`, `query`, `q`
 * are user-supplied inputs!
 */
const USER_SUPPLIED_PARAMS = new Set([
  "owner",
  "repo",
  "org",
  "username",
  "title",
  "body",
  "name",
  "new_name",
  "state",
  "visibility",
  "message",
  "content",
  "text",
  "markdown_content",
  "summary",
  "description",
  "q",
  "query",
  "path",
  "dir",
  "devcontainer_path",
  "action",
  "event",
  "event_type",
  "limit",
  "type",
  "data_type",
  "value_type",
  "value",
  "encrypted_value",
  "amount",
  "color",
  "layout",
  "language",
  "license",
  "model",
  "input",
  "messages",
  "pattern",
  "object",
  "code",
  "url",
  "url_template",
  "config__url",
  "account_urls",
  "emails",
  "permissions",
  "enforcement",
  "access_level",
  "enabled",
  "is_enabled",
  "use_default",
  "use_lfs",
  "scanned",
  "enabled_repositories",
  "properties",
  "files",
  "asset",
  "content_type",
  "sarif",
  "client_id",
  "access_token",
  "oidc_token",
  "clientMutationId",
  "include_claim_keys",
  "key_prefix",
  "position",
  "comment",
  "package_type",
  "contexts",
  "labels",
  "users",
  "teams",
  "apps",
  "reviewers",
  "selected_usernames",
  "assignee",
  "target_user",
  "new_owner",
  "template_owner",
  "template_repo",
  "role",
  "names",
  "repository_names",
]);

/**
 * Pattern matching reference-like parameters across any toolkit:
 * e.g., *_id, *_ids, *_number, *_sha, *_slug, *_name (when entity-prefixed like codespace_name, tag_name, secret_name, environment_name, package_name, branch_name),
 * or standalone reference nouns like branch, head, base, ref, sha, tree, id, ids, key.
 */
const REF_PARAM_REGEX =
  /(_id|_ids|Id|Ids|_number|_sha|^sha$|^ref$|^branch$|^head$|^base$|^tree$|_slug|_name|_key|^key$)$/;

const ID_SUFFIXES = new Set([
  "ID",
  "IDS",
  "NUMBER",
  "SHA",
  "SLUG",
  "NAME",
  "KEY",
]);

/**
 * Determine whether a required parameter represents a precursor reference that another tool can supply.
 */
export function isReferenceParam(param: Param): boolean {
  if (!param.required) return false;
  if (param.isEnum) return false;
  if (param.type === "boolean") return false;
  if (USER_SUPPLIED_PARAMS.has(param.name)) return false;

  if (REF_PARAM_REGEX.test(param.name)) return true;

  // Also check if description explicitly indicates an identifier obtained from another call
  const desc = param.description.toLowerCase();
  if (
    desc.includes("unique identifier") ||
    desc.includes("unique numeric") ||
    desc.includes("unique number") ||
    desc.includes("node id") ||
    desc.includes("obtained from") ||
    desc.includes("returned when") ||
    desc.includes("get this id by")
  ) {
    return true;
  }

  return false;
}

/**
 * Extract entity tokens and the identifier field suffix from a parameter name.
 * Examples:
 *   issue_number      -> entityTokens: ["ISSUE"], idSuffix: "number"
 *   pull_number       -> entityTokens: ["PULL"], idSuffix: "number"
 *   comment_id        -> entityTokens: ["COMMENT"], idSuffix: "id"
 *   package_version_id -> entityTokens: ["PACKAGE", "VERSION"], idSuffix: "id"
 *   branch / head / base -> entityTokens: ["BRANCH"], idSuffix: "name"
 *   sha / commit_sha / head_sha -> entityTokens: ["COMMIT"], idSuffix: "sha"
 *   tree / tree_sha   -> entityTokens: ["TREE"], idSuffix: "sha"
 *   ref               -> entityTokens: ["REFERENCE", "REF", "BRANCH", "TAG"], idSuffix: "ref"
 */
export function parseParamEntity(param: Param): { entityTokens: string[]; idSuffix: string } {
  const rawName = param.name;
  if (rawName === "branch" || rawName === "head" || rawName === "base" || rawName === "branch_name") {
    return { entityTokens: ["BRANCH"], idSuffix: "name" };
  }
  if (rawName === "sha" || rawName === "commit_sha" || rawName === "head_sha") {
    return { entityTokens: ["COMMIT"], idSuffix: "sha" };
  }
  if (rawName === "tree" || rawName === "tree_sha") {
    return { entityTokens: ["TREE"], idSuffix: "sha" };
  }
  if (rawName === "ref") {
    return { entityTokens: ["REFERENCE", "BRANCH", "TAG"], idSuffix: "ref" };
  }
  if (rawName === "key") {
    return { entityTokens: ["CACHE"], idSuffix: "key" };
  }
  if (rawName === "selected_repository_ids") {
    return { entityTokens: ["REPOSITORY"], idSuffix: "id" };
  }

  const tokens = tokenizeIdentifier(rawName).map(singularize);
  if (tokens.length === 0) {
    return { entityTokens: [], idSuffix: "id" };
  }

  const last = tokens[tokens.length - 1];
  if (ID_SUFFIXES.has(last) && tokens.length > 1) {
    const entityTokens = tokens.slice(0, -1);
    const suffix = last === "IDS" ? "id" : last.toLowerCase();
    return { entityTokens, idSuffix: suffix };
  }

  return { entityTokens: tokens, idSuffix: "id" };
}

/**
 * Build synonyms/expansions derived from the catalog vocabulary and parameter description.
 * For example, `pull_number` has token `PULL` -> also matches `PULL_REQUEST`;
 * `hook_id` has description mentioning "webhook" -> also matches `WEBHOOK`;
 * `run_id` has description mentioning "workflow run" -> matches `RUN`, `WORKFLOW`;
 * `ghsa_id` has description mentioning "advisory" -> matches `ADVISORY`.
 */
function expandEntityTokens(
  entityTokens: string[],
  param: Param,
  consumer: Tool,
  catalogVocab: Set<string>,
): { primaryTokens: string[]; contextTokens: string[] } {
  const primary = new Set<string>(entityTokens);
  const context = new Set<string>();

  // Extract capitalized or key noun tokens from parameter description that exist in the catalog's slug vocabulary
  const descWords = tokenizeIdentifier(param.description).map(singularize);
  for (const w of descWords) {
    if (w.length >= 4 && catalogVocab.has(w)) {
      if (
        (primary.has("HOOK") && w === "WEBHOOK") ||
        (primary.has("GHSA") && w === "ADVISORY") ||
        (primary.has("PAT") && w === "TOKEN") ||
        (primary.has("THREAD") && w === "NOTIFICATION")
      ) {
        primary.add(w);
      } else {
        context.add(w);
      }
    }
  }

  // Also include consumer's domain tokens as context (e.g., if consumer is GITHUB_DELETE_A_RELEASE_REACTION and param is reaction_id, consumer has RELEASE)
  for (const t of consumer.tokens) {
    if (!primary.has(t) && t !== consumer.verb) {
      context.add(t);
    }
  }

  return {
    primaryTokens: [...primary],
    contextTokens: [...context],
  };
}

/**
 * Score a candidate producer tool for a given consumer need.
 */
function scoreCandidateProducer(
  candidate: Tool,
  consumer: Tool,
  param: Param,
  primaryTokens: string[],
  contextTokens: string[],
  idSuffix: string,
): CandidateProducer | null {
  if (candidate.slug === consumer.slug) return null;

  // Only LIST, GET, SEARCH, FIND, CREATE tools (or action tools that return the exact param) can be producers
  const isProducerVerb =
    candidate.verb === "LIST" ||
    candidate.verb === "GET" ||
    candidate.verb === "SEARCH" ||
    candidate.verb === "FIND" ||
    candidate.verb === "CREATE";

  if (!isProducerVerb && !candidate.outputFields.has(param.name)) {
    return null;
  }

  // Avoid circular prerequisite: if the candidate ITSELF requires the exact same parameter (e.g. GET_AN_ISSUE requires issue_number),
  // then GET_AN_ISSUE cannot be the initial producer of issue_number!
  // Exception: if param is generic `id` or `name`, check entity overlap.
  if (candidate.requiredParams.includes(param.name)) {
    return null;
  }

  const candTokenSet = new Set(candidate.tokens);
  const reasons: string[] = [];
  let score = 0;

  // 1. Check entity token match in candidate's slug
  const matchedPrimary = primaryTokens.filter((t) => candTokenSet.has(t));
  if (matchedPrimary.length > 0) {
    const ratio = matchedPrimary.length / primaryTokens.length;
    score += 35 * ratio;
    reasons.push(`slug_entity(${matchedPrimary.join("+")})`);

    // Find the main target noun of the candidate (the token before "FOR"/"IN"/"BY"/"OF"/"FROM"/"WITH" or the last token)
    const prepositions = new Set(["FOR", "IN", "BY", "OF", "FROM", "WITH", "TO", "ON"]);
    const rawParts = tokenizeIdentifier(candidate.slug);
    let targetIdx = rawParts.length - 1;
    for (let i = 2; i < rawParts.length; i++) {
      if (prepositions.has(rawParts[i])) {
        targetIdx = i - 1;
        break;
      }
    }
    const targetNoun = singularize(rawParts[targetIdx] ?? "");
    const lastCandToken = candidate.tokens[candidate.tokens.length - 1];
    if (primaryTokens.includes(targetNoun) || primaryTokens.includes(lastCandToken)) {
      score += 20;
      reasons.push(`target_noun(${targetNoun})`);
    }
  }

  // 2. Check output schema match
  let hasOutputMatch = false;
  if (candidate.outputFields.has(param.name)) {
    score += 30;
    hasOutputMatch = true;
    reasons.push(`output_exact(${param.name})`);
  } else {
    // Check if output objects or paths contain the entity + idSuffix (e.g. issues.number, pull_requests.number, branches.name)
    for (const path of candidate.outputPaths) {
      const pathTokens = tokenizeIdentifier(path).map(singularize);
      const lastPathToken = pathTokens[pathTokens.length - 1]?.toLowerCase();
      if (
        (lastPathToken === idSuffix || lastPathToken === "id" || lastPathToken === "number") &&
        primaryTokens.some((pt) => pathTokens.includes(pt))
      ) {
        score += 25;
        hasOutputMatch = true;
        reasons.push(`output_path(${path})`);
        break;
      }
    }

    if (!hasOutputMatch && candidate.outputFields.has(idSuffix)) {
      for (const objName of candidate.outputObjects) {
        const objTokens = tokenizeIdentifier(objName).map(singularize);
        if (primaryTokens.some((pt) => objTokens.includes(pt))) {
          score += 22;
          hasOutputMatch = true;
          reasons.push(`output_obj(${objName}.${idSuffix})`);
          break;
        }
      }
    }
  }

  // Require at least an entity match in slug or an explicit output match
  if (matchedPrimary.length === 0 && !hasOutputMatch) {
    return null;
  }

  // If only a partial or weak match, filter out noise
  if (score < 30) {
    return null;
  }

  // 3. Verb preference: LIST / SEARCH / FIND are the best producers of IDs/numbers because they don't know the ID upfront;
  // CREATE is also a valid producer; GET is only a producer if it doesn't require the ID (e.g. GET_PUBLIC_KEY -> key_id, or lookup by name).
  if (candidate.verb === "LIST") {
    score += 20;
    reasons.push("verb(LIST)");
  } else if (candidate.verb === "SEARCH" || candidate.verb === "FIND") {
    score += 15;
    reasons.push(`verb(${candidate.verb})`);
  } else if (candidate.verb === "CREATE") {
    score += 12;
    reasons.push("verb(CREATE)");
  } else if (candidate.verb === "GET") {
    score += 10;
    reasons.push("verb(GET)");
  }

  // 4. Context alignment: prefer producers in the same service or sharing context nouns (e.g. ORG vs REPO, ISSUE vs PULL_REQUEST vs COMMIT)
  if (candidate.service === consumer.service) {
    score += 12;
    reasons.push(`same_service(${candidate.service})`);
  }

  const matchedContext = contextTokens.filter((t) => candTokenSet.has(t));
  if (matchedContext.length > 0) {
    score += Math.min(18, matchedContext.length * 6);
    reasons.push(`context(${matchedContext.slice(0, 3).join("+")})`);
  }

  // Penalize domain modifiers present in the candidate that conflict with the consumer/param context
  // (e.g. if we need a workflow `run_id` and candidate has `CHECK`, or we need a commit `comment_id` and candidate has `ISSUE`/`GIST`)
  const DOMAIN_MODIFIERS = ["CHECK", "WORKFLOW", "GIST", "COMMIT", "ISSUE", "PULL", "DISCUSSION", "RELEASE", "ENVIRONMENT", "DEPENDABOT", "CODESPACE"];
  const consumerAndContext = new Set([...primaryTokens, ...contextTokens, ...consumer.tokens]);
  for (const mod of DOMAIN_MODIFIERS) {
    if (candTokenSet.has(mod) && !consumerAndContext.has(mod)) {
      score -= 16;
    }
  }

  // 5. Prerequisite compatibility: a producer that requires FEWER extra parameters (or parameters already known by the consumer) is much easier to execute!
  const consumerReqSet = new Set(consumer.requiredParams);
  const extraReqs = candidate.requiredParams.filter(
    (r) => !consumerReqSet.has(r) && !USER_SUPPLIED_PARAMS.has(r),
  );
  if (extraReqs.length === 0) {
    score += 15;
    reasons.push("compatible_inputs");
  } else {
    score -= Math.min(15, extraReqs.length * 5);
  }

  // Penalize sub-resource mismatches (e.g., if we need `issue_number`, don't use `LIST_ISSUE_COMMENTS` when `LIST_REPOSITORY_ISSUES` exists)
  const lastCandToken = candidate.tokens[candidate.tokens.length - 1];
  if (
    lastCandToken &&
    !primaryTokens.includes(lastCandToken) &&
    candidate.verb === "LIST" &&
    !candidate.outputFields.has(param.name)
  ) {
    score -= 18;
  }

  if (score < 42) return null;

  return {
    tool: candidate,
    score,
    reasons,
  };
}

/**
 * Find all consumer needs and ranked candidate producers across the catalog.
 */
export function findCandidates(tools: Tool[], maxCandidatesPerNeed = 5): ConsumerNeed[] {
  const catalogVocab = new Set<string>();
  for (const t of tools) {
    for (const tok of t.tokens) catalogVocab.add(tok);
  }

  const needs: ConsumerNeed[] = [];

  for (const consumer of tools) {
    for (const param of consumer.inputs) {
      if (!isReferenceParam(param)) continue;

      const { entityTokens, idSuffix } = parseParamEntity(param);
      if (entityTokens.length === 0) continue;

      const { primaryTokens, contextTokens } = expandEntityTokens(
        entityTokens,
        param,
        consumer,
        catalogVocab,
      );

      const candidates: CandidateProducer[] = [];
      for (const candidate of tools) {
        const scored = scoreCandidateProducer(
          candidate,
          consumer,
          param,
          primaryTokens,
          contextTokens,
          idSuffix,
        );
        if (scored) {
          candidates.push(scored);
        }
      }

      candidates.sort((a, b) => b.score - a.score || a.tool.slug.localeCompare(b.tool.slug));

      // Keep top candidates that are within a reasonable range of the best candidate
      if (candidates.length > 0) {
        const topScore = candidates[0].score;
        const filtered = candidates
          .filter((c) => c.score >= Math.max(45, topScore - 26))
          .slice(0, maxCandidatesPerNeed);

        if (filtered.length > 0) {
          needs.push({
            consumer,
            param,
            entityTokens: primaryTokens,
            idSuffix,
            candidates: filtered,
          });
        }
      }
    }
  }

  return needs;
}

/**
 * Strategy 1: OutputSchemaStrategy — proposes edges where the producer's output schema explicitly confirms the entity/field.
 */
export class OutputSchemaStrategy implements EdgeStrategy {
  readonly name = "output-schema";

  propose(_tools: Tool[], needs: ConsumerNeed[]): ScoredEdge[] {
    const edges: ScoredEdge[] = [];
    for (const need of needs) {
      for (const cand of need.candidates) {
        const hasSchemaEvidence = cand.reasons.some((r) => r.startsWith("output_"));
        if (hasSchemaEvidence) {
          edges.push({
            from: cand.tool.slug,
            to: need.consumer.slug,
            label: need.param.name,
            confidence: Math.min(0.99, cand.score / 100),
            strategy: this.name,
          });
        }
      }
    }
    return edges;
  }
}

/**
 * Strategy 2: NameAndEntityMatchStrategy — proposes edges based on producer verb (LIST/GET/SEARCH/CREATE) and entity noun alignment.
 */
export class NameMatchStrategy implements EdgeStrategy {
  readonly name = "name-entity-match";

  propose(_tools: Tool[], needs: ConsumerNeed[]): ScoredEdge[] {
    const edges: ScoredEdge[] = [];
    for (const need of needs) {
      for (const cand of need.candidates) {
        const hasSlugEvidence = cand.reasons.some(
          (r) => r.startsWith("slug_entity") || r.startsWith("target_noun"),
        );
        if (hasSlugEvidence && cand.score >= 52) {
          edges.push({
            from: cand.tool.slug,
            to: need.consumer.slug,
            label: need.param.name,
            confidence: Math.min(0.95, cand.score / 105),
            strategy: this.name,
          });
        }
      }
    }
    return edges;
  }
}
