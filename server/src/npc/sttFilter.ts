/** Results this short are the ones Azure invents from room noise ("You know.", "Dislocation."). */
export const SHORT_RESULT_WORDS = 4;
export const DEFAULT_MIN_CONFIDENCE = 0.6;
export const MULTI_WORD_MIN_CONFIDENCE = 0.34;

const CONFIRMATION_PHRASE_RE =
  /\b(?:ok|okay|sure|yes|yeah|yep|no|nope|wait|hold on|stop|hello|hey|confirm|confirmed|agree|agreed|problem solved|sounds good|go ahead|let's do|let's go|approve|approved|thank you|thanks|good idea|makes sense|do both|works for me)\b/i;

const HESITATION_FILLER_RE = /^(?:uh+|um+|umm+|er+|erm+|ah+|hmm+)[,.!?\s]*$/i;

/**
 * Whether a recognised piece of speech should be kept. Azure turns clicks, fans and distant voices into short,
 * plausible words; those come back with low confidence. A long sentence is kept whatever its score, and so is a
 * result with no score at all (nothing to judge it by). Multi-word phrases (3–4 words) or explicit confirmations
 * use a slightly lower floor (0.40) so natural 4-word replies ("I confirm, I confirm", "So problem solved, right?")
 * are not dropped while 1–2 word room noises still require the strict 0.60 bar.
 */
export function keepRecognised(text: string, confidence: number | undefined, minConfidence = DEFAULT_MIN_CONFIDENCE): boolean {
  if (HESITATION_FILLER_RE.test(text.trim())) return false;
  if (confidence === undefined) return true;
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0).length;
  if (words > SHORT_RESULT_WORDS) return true;
  if ((words >= 3 || CONFIRMATION_PHRASE_RE.test(text)) && confidence >= Math.min(minConfidence, MULTI_WORD_MIN_CONFIDENCE)) {
    return true;
  }
  return confidence >= minConfidence;
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
