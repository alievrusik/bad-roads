import { z } from "zod";

export const AnalyzeRequestSchema = z.object({
  text: z.string().min(1, "Укажите текст жалоб."),
  maxComments: z.number().int().min(1).max(200).optional(),
});

export type AnalyzeRequest = z.infer<typeof AnalyzeRequestSchema>;

export type MapPointItem = {
  id: string;
  locationRaw: string;
  normalizedAddress: string;
  lat: number | null;
  lon: number | null;
  severity: number;
  summary: string;
  frequency: number;
  confidence: number;
  explanation?: string;
  processingMode?: string;
  outputKind?: string;
  geocodeWarning?: string;
};
