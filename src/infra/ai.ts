import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { EstimateFigures } from "../domain/estimation.js";

/**
 * AI Estimation Engine. Providers turn task context into an effort estimate with
 * assumptions, rationale and confidence. The engine runs asynchronously; a
 * provider failure only fails that AI request and never blocks human estimation.
 */
export interface EstimationInput {
  proposal: { title: string; description: string };
  requirements: { title: string; description: string; priority: string }[];
  milestone: { title: string; description: string };
  task: { title: string; description: string; scope: string; deliveryType: string; dependsOn: string[] };
}

export type ProviderEstimate = EstimateFigures & { provider: string; model: string };

export interface EstimationProvider {
  readonly name: string;
  estimate(input: EstimationInput): Promise<ProviderEstimate>;
}

export class EstimationProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Deterministic, offline estimator used in development and tests. It sizes work
 * from the amount of described scope and complexity keywords.
 */
export class HeuristicEstimationProvider implements EstimationProvider {
  readonly name = "heuristic";

  async estimate(input: EstimationInput): Promise<ProviderEstimate> {
    const text = `${input.task.title} ${input.task.description} ${input.task.scope}`.toLowerCase();
    const words = text.split(/\s+/).filter(Boolean).length;
    const keywords = ["integration", "migration", "security", "api", "report", "workflow", "sync", "payment", "authentication", "performance"];
    const hits = keywords.filter((k) => text.includes(k));
    const expected = Math.max(4, Math.round(4 + words * 0.6 + hits.length * 8 + input.task.dependsOn.length * 2));
    const confidence = Math.max(0.3, Math.min(0.8, 0.8 - hits.length * 0.08 - (input.task.scope ? 0 : 0.2)));
    return {
      provider: this.name,
      model: "scope-heuristic-v1",
      effortMin: Math.round(expected * 0.7),
      effortExpected: expected,
      effortMax: Math.round(expected * 1.6),
      unit: "HOURS",
      assumptions: [
        "Estimate covers implementation, developer testing and review.",
        ...(hits.length ? [`Complexity drivers detected: ${hits.join(", ")}.`] : []),
        ...(input.task.scope ? [] : ["Task scope is not described; uncertainty is high."]),
      ],
      rationale: `Sized from ${words} words of task description, ${hits.length} complexity keyword(s) and ${input.task.dependsOn.length} dependency(ies).`,
      confidence: Math.round(confidence * 100) / 100,
    };
  }
}

const EstimateSchema = z.object({
  effortMin: z.number().describe("Optimistic effort in hours"),
  effortExpected: z.number().describe("Most likely effort in hours"),
  effortMax: z.number().describe("Pessimistic effort in hours"),
  assumptions: z.array(z.string()),
  rationale: z.string(),
  confidence: z.number().describe("Confidence in the expected value, 0 to 1"),
});

/** Claude-backed estimator (enabled when ANTHROPIC_API_KEY or another Anthropic credential is configured). */
export class ClaudeEstimationProvider implements EstimationProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(
    private readonly model = "claude-opus-5-5",
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic();
  }

  async estimate(input: EstimationInput): Promise<ProviderEstimate> {
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: betaZodOutputFormat(EstimateSchema) },
        system:
          "You are a senior delivery estimator at a software consultancy. Estimate the effort for one task of a customer proposal. " +
          "Give hours for an experienced developer, including developer testing and code review but excluding project management. " +
          "State the assumptions your estimate depends on, explain your reasoning briefly, and give an honest confidence between 0 and 1.",
        messages: [{ role: "user", content: JSON.stringify(input, null, 2) }],
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) throw new EstimationProviderError("AI_RATE_LIMITED", "The AI estimation service is rate limited. Try again shortly.");
      if (err instanceof Anthropic.AuthenticationError) throw new EstimationProviderError("AI_NOT_CONFIGURED", "The AI estimation service credentials are invalid.");
      if (err instanceof Anthropic.APIConnectionError) throw new EstimationProviderError("AI_UNAVAILABLE", "The AI estimation service could not be reached.");
      if (err instanceof Anthropic.APIError) throw new EstimationProviderError("AI_PROVIDER_ERROR", `The AI estimation service returned an error (${err.status ?? "unknown"}).`);
      throw err;
    }
    if (response.stop_reason === "refusal") throw new EstimationProviderError("AI_REFUSED", "The AI declined to estimate this task.");
    const out = response.parsed_output;
    if (!out) throw new EstimationProviderError("AI_INVALID_OUTPUT", "The AI response could not be parsed as an estimate.");
    const [min, exp, max] = [out.effortMin, out.effortExpected, out.effortMax].map((n) => Math.max(0, Math.round(n * 10) / 10));
    return {
      provider: this.name,
      model: response.model,
      effortMin: Math.min(min, exp),
      effortExpected: exp,
      effortMax: Math.max(max, exp),
      unit: "HOURS",
      assumptions: out.assumptions,
      rationale: out.rationale,
      confidence: Math.max(0, Math.min(1, out.confidence)),
    };
  }
}
