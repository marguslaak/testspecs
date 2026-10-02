import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ClaudeEstimationProvider, type EstimationInput, EstimationProviderError, HeuristicEstimationProvider } from "../src/infra/ai.js";

const input: EstimationInput = {
  proposal: { title: "Portal", description: "Customer portal" },
  requirements: [{ title: "Invoices", description: "", priority: "MUST" }],
  milestone: { title: "MVP", description: "" },
  task: { title: "Invoice API", description: "", scope: "REST API with PDF download", deliveryType: "INTERNAL", dependsOn: [] },
};

/** Stands in for the SDK client; records the request and returns a canned response. */
function stubClient(response: unknown | (() => never)) {
  const calls: any[] = [];
  const client = {
    beta: {
      messages: {
        parse: async (params: unknown) => {
          calls.push(params);
          if (typeof response === "function") (response as () => never)();
          return response;
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

describe("ClaudeEstimationProvider", () => {
  it("requests a structured estimate and maps it to the domain shape", async () => {
    const { client, calls } = stubClient({
      stop_reason: "end_turn",
      model: "claude-opus-5-5",
      parsed_output: { effortMin: 12.34, effortExpected: 20, effortMax: 35, assumptions: ["PDF service exists"], rationale: "Typical CRUD API", confidence: 1.4 },
    });
    const result = await new ClaudeEstimationProvider("claude-opus-5-5", client).estimate(input);
    expect(result).toEqual({
      provider: "anthropic",
      model: "claude-opus-5-5",
      effortMin: 12.3,
      effortExpected: 20,
      effortMax: 35,
      unit: "HOURS",
      assumptions: ["PDF service exists"],
      rationale: "Typical CRUD API",
      confidence: 1,
    });
    expect(calls[0]).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    expect(calls[0].output_config.format).toBeDefined();
    expect(JSON.parse(calls[0].messages[0].content).task.title).toBe("Invoice API");
  });

  it("turns refusals and unparseable output into provider errors", async () => {
    const refused = stubClient({ stop_reason: "refusal", model: "m", parsed_output: null });
    await expect(new ClaudeEstimationProvider("m", refused.client).estimate(input)).rejects.toMatchObject({ code: "AI_REFUSED" });
    const garbage = stubClient({ stop_reason: "end_turn", model: "m", parsed_output: null });
    await expect(new ClaudeEstimationProvider("m", garbage.client).estimate(input)).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
  });

  it("maps SDK errors to stable codes", async () => {
    const down = stubClient(() => {
      throw new Anthropic.APIConnectionError({ message: "connect ECONNREFUSED" });
    });
    const err = await new ClaudeEstimationProvider("m", down.client).estimate(input).catch((e) => e);
    expect(err).toBeInstanceOf(EstimationProviderError);
    expect(err.code).toBe("AI_UNAVAILABLE");
  });
});

describe("HeuristicEstimationProvider", () => {
  it("is deterministic", async () => {
    const p = new HeuristicEstimationProvider();
    expect(await p.estimate(input)).toEqual(await p.estimate(input));
  });
});
