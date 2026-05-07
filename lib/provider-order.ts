export type FoundationId = "sam3" | "anthropic" | "vllm";

export function parseProviderList(raw: string | undefined): FoundationId[] {
  if (!raw?.trim()) return [];
  const allowed = new Set<FoundationId>(["sam3", "anthropic", "vllm"]);
  const out: FoundationId[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase() as FoundationId;
    if (allowed.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Текстовый анализ: сохранить порядок из DEMO_FOUNDATION_PROVIDERS, отфильтровав sam3.
 * Если указан только sam3, массив пустой — вызывающий код перейдёт к эвристике.
 */
export function textAnalysisProviderOrder(orderFromEnv: FoundationId[]): FoundationId[] {
  return orderFromEnv.filter((p) => p === "anthropic" || p === "vllm");
}
