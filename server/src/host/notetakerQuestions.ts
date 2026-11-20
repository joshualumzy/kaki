import type { Question } from '@kaki/shared';
import { FILLER_WORDS, QUESTION_WORDS, keywords, normalize, words, type TranscriptLine } from './notetakerText';

export interface AnswerCandidate {
  id: string;
  question: Question;
  source: TranscriptLine;
}
const QUESTION_OVERLAP = 0.6;

function questionKeywords(text: string): Set<string> {
  return keywords(text, new Set([...FILLER_WORDS, ...QUESTION_WORDS]));
}

// The wh-word a question starts with. Two questions on the same topic but asking different unknowns ("who runs cash?"
// versus "how is the float balanced?") must not be treated as repeats just because they share topic words.
function questionHead(text: string): string | undefined {
  return normalize(text).match(/^(?:[a-z]+\s+){0,2}(who|what|when|where|why|how)\b/)?.[1];
}

// A line that reports missing data, doubts the answer, or leaves the point open does not answer the question.
const UNCERTAIN_ANSWER =
  /\b(?:(?:i|we|they|he|she)\s+)?(?:don'?t|do not|doesn'?t|does not|didn'?t|did not)\s+know\b|\bno idea\b|\bnot sure\b|\bunsure\b|\bnot certain\b|\bcan'?t\s+(?:say|remember|confirm|tell)\b|\bcannot\s+(?:say|remember|confirm|tell)\b|\b(?:haven'?t|hasn'?t|hadn'?t|not|never)\s+(?:looked|checked|seen)\b|\bstill open\b|\b(?:not|haven'?t|hasn'?t)\s+settled\b|\bnot decided\b|\bunresolved\b|\bkeeps?\s+(?:[a-z'-]+\s+){0,3}open\b|\bdon'?t quote me\b|\bnot yet\b|\bto be confirmed\b|\b(?:won'?t|doesn'?t|does not|can'?t|cannot)\s+tell\s+(?:us|me|you)\b/i;

// A line that only offers or promises to look something up still has not stated the fact. "We can confirm <fact>"
// does state it, so plain "can confirm" is deliberately absent here.
const DEFERRED_ANSWER =
  /\b(?:(?:i|we|they|he|she)\s+)?(?:would|could|might|may|need to|needs to|have to|has to|will|shall)\s+(?:have to\s+)?(?:check|look|find out|verify|confirm|test|try|ask|pull|show|count|measure|investigate)\b|\b(?:i|we)\s+can\s+(?:check|look|find out|verify|test|try|ask|pull|show|count|measure|investigate)\b|\blet me\s+(?:check|look|find out|verify|confirm|test|try|ask|pull|show|count|measure|investigate)\b/i;

// An instruction or plan for what to do next ("put it on the list", "let's not decide blind") is not an answer.
const DIRECTIVE_ANSWER =
  /^\W*(?:(?:okay|ok|right|so|well|alright|fine|now)\s*[,.]?\s*)*(?:let'?s|put|keep|leave|hold|move on|defer|park|come back to)\b/i;

/** True when a transcript line states the answer itself, rather than repeating the topic, hedging, or promising to look. */
export function isAffirmativeAnswer(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.endsWith('?')) return false;
  return !UNCERTAIN_ANSWER.test(trimmed) && !DEFERRED_ANSWER.test(trimmed) && !DIRECTIVE_ANSWER.test(trimmed);
}

// Conservative topic check: a true quote about a different subject is not evidence for this question.
// Short contextual replies without a topic word remain open rather than being closed on guesswork.
const ANSWER_NON_TOPICS = new Set(
  'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty hundred thousand more less'.split(' '),
);

// Verbs and generic nouns that say nothing about which unknown a question asks. "We change the menu every week" must
// not look like an answer to "How is change counted and balanced at close?" just because both contain "change".
const GENERIC_TOPIC_WORDS = new Set(
  (
    'change changes changed need needs needed make makes made get gets got take takes took use uses used work works ' +
    'show shows showed give gives gave put puts run runs ran say says said think thinks know knows want wants like ' +
    'likes help helps find finds look looks looking go goes going come comes keep keeps see sees tell tells'
  ).split(' '),
);

// Two shared topic words are the minimum: one is a coincidence ("delivery" in a question and in "the delivery van broke
// down"). They must also cover half the question's topics, so a line that only names the subject ("solo diners get a
// discount") does not answer a different unknown about it ("how many solo diners need a table..."). A paraphrase or a
// terse answer that shares less stays open: this is a conservative filter, not a proof that the answer is correct.
const MIN_SHARED_ANSWER_WORDS = 2;
const MIN_ANSWER_COVERAGE = 0.5;

// A "who" answer can be short: "The floor managers will enforce it" names the actor and repeats the question's action
// even though it shares few of its topic words. Keep this exception narrow: the reply must repeat the action AND put an
// actor before it, so "The rule is enforced every morning" (no actor) and "Enforce it" (no actor) still stay open.
const ACTOR_PRONOUNS = new Set('i we they he she you me us them him her'.split(' '));
const NON_ACTOR_WORDS = new Set('it this that there here'.split(' '));

function stemTopicWord(word: string): string {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

function whoQuestionAction(question: string): string | undefined {
  if (questionHead(question) !== 'who') return undefined;
  for (const word of words(question).slice(1)) {
    if (
      QUESTION_WORDS.has(word) ||
      FILLER_WORDS.has(word) ||
      ANSWER_NON_TOPICS.has(word) ||
      NON_ACTOR_WORDS.has(word) ||
      GENERIC_TOPIC_WORDS.has(word) ||
      /^\d+$/.test(word)
    ) {
      continue;
    }
    return stemTopicWord(word);
  }
  return undefined;
}

function answerNamesWho(question: string, answer: string): boolean {
  const action = whoQuestionAction(question);
  if (action === undefined) return false;
  const answerWords = words(answer);
  const at = answerWords.findIndex((word) => stemTopicWord(word) === action);
  if (at < 0) return false;
  return answerWords.slice(0, at).some(
    (word) =>
      ACTOR_PRONOUNS.has(word) ||
      (!QUESTION_WORDS.has(word) &&
        !FILLER_WORDS.has(word) &&
        !ANSWER_NON_TOPICS.has(word) &&
        !NON_ACTOR_WORDS.has(word) &&
        !/^\d+$/.test(word)),
  );
}

/** True when an answer line shares enough of the question's topic words to identify what it is about. */
export function answerMatchesQuestion(question: string, answer: string): boolean {
  const topicWords = [...questionKeywords(question)].filter(
    (word) =>
      word.length > 2 &&
      !/^\d+$/.test(word) &&
      !ANSWER_NON_TOPICS.has(word) &&
      !GENERIC_TOPIC_WORDS.has(word),
  );
  const answerWords = questionKeywords(answer);
  const shared = topicWords.filter((word) => answerWords.has(word));
  if (shared.length >= MIN_SHARED_ANSWER_WORDS && shared.length / topicWords.length >= MIN_ANSWER_COVERAGE) {
    return true;
  }
  return answerNamesWho(question, answer);
}

/** True when a question is just the host opening a topic ("What's happening there?") or a colleague handing the decision to the room ("How do we help tourists...?"). */
export function isRhetoricalTopicHandoff(text: string): boolean {
  const trimmed = text.trim();
  if (
    /^\W*(?:[a-z][a-z\s]{0,20},\s*)?(?:what(?:'s| is) happening(?: there| with [a-z\s]+)?|what(?:'s| is) going on(?: there| with [a-z\s]+)?|can you walk us through|what do you think|what(?:'s| is) your call|what should we do)\s*\?*$/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  return /^\W*(?:[a-z][a-z\s]{0,20},\s*)?(?:how (?:do|should|can|could|would|shall) we\b|(?:can|could|should|shall|would) we\b|what (?:do|should|can|could|would|shall) we\b)/i.test(
    trimmed,
  );
}

/** True when a question asks (nearly) the same thing as one already open. */
export function isLikelyDuplicateQuestion(text: string, openTexts: string[]): boolean {
  const mine = questionKeywords(text);
  if (mine.size === 0) return false;
  const head = questionHead(text);
  return openTexts.some((other) => {
    if (normalize(other) === normalize(text)) return true;
    const otherHead = questionHead(other);
    if (head !== undefined && otherHead !== undefined && head !== otherHead) return false;
    const theirs = questionKeywords(other);
    if (theirs.size === 0) return false;
    const shared = [...mine].filter((word) => theirs.has(word)).length;
    return shared / Math.min(mine.size, theirs.size) >= QUESTION_OVERLAP;
  });
}
