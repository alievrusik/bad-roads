export type PrototypeResult = {
  status: "ok" | "warning" | "critical";
  summary: string;
  details?: string[];
};

export function notImplementedResult(): PrototypeResult {
  return {
    status: "warning",
    summary: "Foundation flow is not implemented yet.",
    details: ["Builder should replace this scaffold with project-specific logic."],
  };
}
