/** Results this short are the ones Azure invents from room noise ("You know.", "Dislocation."). */
export const SHORT_RESULT_WORDS = 4;
export const DEFAULT_MIN_CONFIDENCE = 0.6;

/**
 * Whether a recognised piece of speech should be kept. Azure turns clicks, fans and distant voices into short,
 * plausible words; those come back with low confidence. A long sentence is kept whatever its score, and so is a
 * result with no score at all (nothing to judge it by).
 */
export function keepRecognised(text: string, confidence: number | undefined, minConfidence = DEFAULT_MIN_CONFIDENCE): boolean {
  if (confidence === undefined) return true;
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0).length;
  return words > SHORT_RESULT_WORDS || confidence >= minConfidence;
}

/** The best guess's confidence from Azure's detailed JSON result, if it has one. */
export function confidenceFrom(json: string | undefined): number | undefined {
  if (json === undefined || json.length === 0) return undefined;
  try {
    const value = (JSON.parse(json) as { NBest?: Array<{ Confidence?: unknown }> }).NBest?.[0]?.Confidence;
    return typeof value === 'number' ? value : undefined;
  } catch {
    return undefined;
  }
}
