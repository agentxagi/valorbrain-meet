/**
 * @fileoverview Near-duplicate items of a meeting record.
 *
 * The live summarizer reads the meeting excerpt by excerpt, so the same
 * decision, task or question is registered again. Two items are the same when
 * their normalized texts are equal (case, accents, punctuation), or when both
 * have at least 4 words and share at least 80% of them (word-set Jaccard) —
 * but never when the words that differ include a negation, never when they
 * carry different numbers or dates ("21x de 500" / "21x de 520"), and only
 * when, articles apart, they say the same words in the same order.
 *
 * That last guard is deliberate: one changed word is enough to say the
 * opposite ("aceita" / "recusa", "anual" / "mensal", another person, sender
 * and recipient swapped), and close spellings are not safe either
 * ("possível" / "impossível", "Paulo" / "Paula"). Rewordings are left to the
 * end-of-meeting review, where the model decides and the extension checks.
 * Words come from Intl.Segmenter, so Chinese, Japanese and Thai, written
 * without spaces, have words too.
 *
 * Used by the live merge (meetingSummary.ts) and by the end-of-meeting review
 * (meetingConsolidation.ts, which re-exports isNearDuplicate). It lives in a
 * module of its own so those two never import each other.
 *
 * Pure module: no Chrome APIs, unit-tested in node.
 */

import type { ActionItem, Decision, KeyInsight, Topic } from "./types";

/** Share of words two items must have in common to be the same item. */
const NEAR_DUPLICATE_JACCARD = 0.8;
/** Below this many distinct words only an identical text is a duplicate. */
const NEAR_DUPLICATE_MIN_WORDS = 4;

/**
 * Lower case, accents and other combining marks removed, anything but letters
 * and digits turned into one space: "Perfilar o Gustavo!" → "perfilar o gustavo".
 */
export function normalizeItemText(value: unknown): string {
  return (typeof value === "string" ? value : "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A set of normalized words from space-separated lists. */
function wordSet(lists: string[]): Set<string> {
  return new Set(
    lists
      .flatMap((list) => list.split(" "))
      .map(normalizeItemText)
      .filter(Boolean),
  );
}

/**
 * Words that turn a statement into its opposite: Portuguese, English, Spanish,
 * French, German and Italian, plus the most common ones of other languages.
 * "t" is what is left of "can't" or "don't" once punctuation is gone, "n" of
 * the French "n'a"; なか, なく, せん, ず and ぬ are Japanese negative endings,
 * 안 and 못 Korean, ไม่ Thai (Intl.Segmenter splits them off as words).
 */
const NEGATION_WORDS = wordSet([
  "não nao nunca nem sem nenhum nenhuma ninguém nada jamais tampouco", // pt
  "not no never without nor none nobody nothing neither cannot t cant dont doesnt didnt", // en
  "wont isnt arent wasnt werent havent hasnt shouldnt wouldnt couldnt", // en
  "sin ni jamás ningún ninguno ninguna nadie tampoco", // es
  "ne n pas sans aucun aucune rien personne non guère", // fr
  "nicht kein keine keinen keinem keiner keines nie niemals ohne weder nichts niemand nein", // de
  "mai senza né nessuno nessuna niente nulla neanche nemmeno neppure mica", // it
  "niet geen nooit zonder inte ikke ej aldrig utan uten uden bez nigdy", // nl, sv, no, da, pl
  "не нет ни без никогда ничего никто değil yok hayır tidak bukan tanpa belum", // ru, tr, id
  "لا لم لن ليس بدون غير לא אין בלי नहीं बिना", // ar, he, hi
  "なか なく せん ず ぬ 안 못 ไม่", // ja, ko, th
]);

/**
 * Negation inside a word: Chinese and Japanese 不 没 无 未 非…, Japanese
 * しない or できません, Korean 않는다, 없다, 아니다.
 */
const NEGATION_INSIDE = /[不没沒无無未非别別勿莫否]|ない|なかっ|ません|않|없|아니/u;

/**
 * Number words and calendar names (pt, en, es, fr, de, it): "cinco parcelas"
 * and "seis parcelas", "até sexta" and "até segunda" are different items.
 * Words that are also common words elsewhere are left out ("um", "dos", "due",
 * "sei", "once", "may", "meta", "meio").
 */
const NUMBER_WORDS = wordSet([
  // pt
  "zero dois duas três quatro cinco seis sete oito nove dez onze doze quinze vinte trinta",
  "quarenta cinquenta cem cento mil milhão milhões bilhão metade dobro hoje amanhã ontem",
  "segunda terça quarta quinta sexta sábado domingo janeiro fevereiro março abril maio junho",
  "julho agosto setembro outubro novembro dezembro",
  // en
  "one two three four five six seven eight nine ten eleven twelve fifteen twenty thirty forty",
  "fifty hundred thousand million billion half twice today tomorrow yesterday monday tuesday",
  "wednesday thursday friday saturday sunday january february march april june july august",
  "september october november december",
  // es
  "cuatro siete ocho nueve diez doce quince veinte treinta cien ciento millón millones mitad",
  "hoy mañana ayer lunes martes miércoles jueves viernes enero febrero marzo mayo junio julio",
  "septiembre setiembre octubre noviembre diciembre",
  // fr
  "deux trois quatre cinq sept huit neuf dix douze vingt trente cent mille moitié aujourd",
  "demain hier lundi mardi mercredi jeudi vendredi samedi dimanche janvier février mars avril",
  "juin juillet août septembre octobre novembre décembre",
  // de
  "zwei drei vier fünf sechs sieben acht neun zehn elf zwölf zwanzig dreißig dreissig hundert",
  "tausend millionen hälfte heute morgen gestern montag dienstag mittwoch donnerstag freitag",
  "samstag sonntag januar februar märz juni juli oktober dezember",
  // it
  "tre quattro cinque sette otto dieci undici dodici venti cento milione milioni oggi domani",
  "ieri lunedì martedì mercoledì giovedì venerdì sabato domenica gennaio febbraio aprile",
  "maggio giugno luglio settembre ottobre dicembre",
]);

/**
 * Articles (pt, en, es, fr, de, it): the only words two items may differ by.
 * Prepositions are not here: "para o Gustavo" and "do Gustavo" are not the
 * same task.
 */
const ARTICLES = wordSet([
  "o a os as um uma uns umas the an el la los las unos unas le les l un une",
  "der die das den dem des ein eine einen einem einer eines il lo i gli uno",
]);

/** Chinese and Japanese numerals inside a word (三个月, 两周); 一 is left out, it is also "a". */
const HAN_NUMERAL = /[〇二三四五六七八九十百千万萬亿億两兩]/u;

/** Labels the pipeline uses when it does not know who spoke: never a real name. */
const PLACEHOLDER_NAMES = new Set(["participante", "you", "voce", "audio"]);

/** True for "Participante", "You", "Você" and "Audio" (in any case, with or without accents). */
export function isPlaceholderName(value: unknown): boolean {
  return PLACEHOLDER_NAMES.has(normalizeItemText(value));
}

let wordSegmenter: Intl.Segmenter | null | undefined;

/** Words as written, by Intl.Segmenter; split on spaces where it is missing. */
function segmentWords(text: string): string[] {
  if (wordSegmenter === undefined) {
    const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
    wordSegmenter = Segmenter ? new Segmenter(undefined, { granularity: "word" }) : null;
  }
  if (!wordSegmenter) return text.split(/\s+/);
  const words: string[] = [];
  for (const part of wordSegmenter.segment(text)) if (part.isWordLike) words.push(part.segment);
  return words;
}

/** "05" → "5" (a lone "0" stays). */
const withoutLeadingZeros = (digits: string) => digits.replace(/^0+(?=.)/u, "");

/**
 * Normalized words in any script: "can't" gives "can" and "t", "22.990" gives
 * "22" and "990", "05" gives "5".
 */
function itemWords(text: string): string[] {
  return segmentWords(text)
    .flatMap((word) => normalizeItemText(word).split(" "))
    .filter(Boolean)
    .map((word) => (/^\p{N}+$/u.test(word) ? withoutLeadingZeros(word) : word));
}

/** Digits, number words and calendar names among the words. */
function numbersIn(words: Iterable<string>): Set<string> {
  const numbers = new Set<string>();
  for (const word of words) {
    for (const match of word.matchAll(/\p{N}+/gu)) numbers.add(withoutLeadingZeros(match[0]));
    if (NUMBER_WORDS.has(word) || HAN_NUMERAL.test(word)) numbers.add(word);
  }
  return numbers;
}

function isNegation(word: string): boolean {
  return NEGATION_WORDS.has(word) || NEGATION_INSIDE.test(word);
}

interface ItemKey {
  text: string;
  words: Set<string>;
  numbers: Set<string>;
  /** The words in order, articles left out. */
  sequence: string[];
}

function itemKey(value: unknown): ItemKey {
  const text = typeof value === "string" ? value : "";
  const sequence = itemWords(text);
  const words = new Set(sequence);
  return {
    text: normalizeItemText(text),
    words,
    numbers: numbersIn(words),
    sequence: sequence.filter((word) => !ARTICLES.has(word)),
  };
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function sameItem(a: ItemKey, b: ItemKey): boolean {
  if (!a.text || !b.text) return false;
  if (a.text === b.text) return true;
  if (a.words.size < NEAR_DUPLICATE_MIN_WORDS || b.words.size < NEAR_DUPLICATE_MIN_WORDS) {
    return false;
  }
  if (!sameSet(a.numbers, b.numbers)) return false;
  let shared = 0;
  for (const word of a.words) if (b.words.has(word)) shared += 1;
  if (shared / (a.words.size + b.words.size - shared) < NEAR_DUPLICATE_JACCARD) return false;
  for (const word of a.words) if (!b.words.has(word) && isNegation(word)) return false;
  for (const word of b.words) if (!a.words.has(word) && isNegation(word)) return false;
  // Articles apart, the same words in the same order: no other word swapped
  // ("aceita" / "recusa"), moved (who sends to whom) or added.
  return (
    a.sequence.length === b.sequence.length && a.sequence.every((word, i) => word === b.sequence[i])
  );
}

/**
 * True when two item texts say the same thing: equal once normalized, or at
 * least 4 words each with 80% of the words in common, no negation among the
 * words that differ, the same numbers and dates, and, articles apart, the same
 * words in the same order.
 */
export function isNearDuplicate(a: string, b: string): boolean {
  return sameItem(itemKey(a), itemKey(b));
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/** How one kind of record item is compared and merged. */
export interface MergeRule<T> {
  text: (item: T) => string;
  /** Two items that read alike but must stay apart (another person's task). */
  conflict?: (a: T, b: T) => boolean;
  /** The item kept, completed with what its repeat adds (never changes its inputs). */
  absorb?: (kept: T, repeat: T) => T;
}

/**
 * Adds `incoming` to `existing` without near-duplicates: an item that repeats
 * one already in the list (an earlier one, or one added just before) is not
 * added, and the item kept absorbs what the repeat adds. The earliest item
 * keeps its text and its source. Returns a new array of at most `max` items.
 */
export function appendDistinct<T>(
  existing: T[],
  incoming: T[],
  rule: MergeRule<T>,
  max = 500,
): T[] {
  if (incoming.length === 0) return existing;
  const out = [...existing];
  const keys = out.map((item) => itemKey(rule.text(item)));
  for (const item of incoming) {
    const key = itemKey(rule.text(item));
    const index = keys.findIndex(
      (other, i) => sameItem(other, key) && !rule.conflict?.(out[i], item),
    );
    if (index === -1) {
      out.push(item);
      keys.push(key);
    } else if (rule.absorb) {
      out[index] = rule.absorb(out[index], item);
    }
  }
  return out.length > max ? out.slice(-max) : out;
}

const CONFIDENCE_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };

/** The higher of two confidences (undefined only when both are). */
export function higherConfidence(
  a: ActionItem["confidence"],
  b: ActionItem["confidence"],
): ActionItem["confidence"] {
  return (CONFIDENCE_RANK[b ?? ""] ?? 0) > (CONFIDENCE_RANK[a ?? ""] ?? 0) ? b : a;
}

/** A name the repeat can give: the kept one is missing or a placeholder, the repeat's is real. */
function betterName(kept: string | undefined, repeat: string | undefined): boolean {
  return (!kept || isPlaceholderName(kept)) && !!repeat && !isPlaceholderName(repeat);
}

/** Fills the decision's missing (or "Participante") author from its repeat. */
export function absorbDecision(kept: Decision, repeat: Decision): Decision {
  return betterName(kept.by, repeat.by) ? { ...kept, by: repeat.by } : kept;
}

/**
 * Fills the task's missing (or "Participante") owner and its missing deadline
 * from its repeat, keeps the higher confidence, and stays an idea only if the
 * repeat is one too.
 */
export function absorbAction(kept: ActionItem, repeat: ActionItem): ActionItem {
  const merged: ActionItem = { ...kept };
  if (betterName(merged.owner, repeat.owner)) merged.owner = repeat.owner;
  if (!merged.deadline && repeat.deadline) merged.deadline = repeat.deadline;
  const confidence = higherConfidence(kept.confidence, repeat.confidence);
  if (confidence) merged.confidence = confidence;
  if (merged.isSpeculative && !repeat.isSpeculative) merged.isSpeculative = false;
  return merged;
}

/** Two different named people (one name not part of the other). */
function ownersConflict(a: string | undefined, b: string | undefined): boolean {
  const x = normalizeItemText(a);
  const y = normalizeItemText(b);
  if (!x || !y || PLACEHOLDER_NAMES.has(x) || PLACEHOLDER_NAMES.has(y)) return false;
  return !` ${x} `.includes(` ${y} `) && !` ${y} `.includes(` ${x} `);
}

/** Two deadlines with different days or numbers ("sexta" / "segunda", "05/10" / "12/10"). */
function deadlinesConflict(a: string | undefined, b: string | undefined): boolean {
  if (!normalizeItemText(a) || !normalizeItemText(b)) return false;
  return !sameSet(numbersIn(itemWords(a ?? "")), numbersIn(itemWords(b ?? "")));
}

const TOPIC_STATUSES = new Set(["active", "completed", "unresolved"]);

/** A decision said again carries its latest classification ("tentative" that became "finalized"). */
export const decisionRule: MergeRule<Decision> = {
  text: (decision) => decision.text,
  absorb: (kept, repeat) => {
    const merged = absorbDecision(kept, repeat);
    return repeat.classification && repeat.classification !== merged.classification
      ? { ...merged, classification: repeat.classification }
      : merged;
  },
};

/** The same words for two people, or for two dates, are two commitments. */
export const actionRule: MergeRule<ActionItem> = {
  text: (action) => action.task,
  conflict: (a, b) => ownersConflict(a.owner, b.owner) || deadlinesConflict(a.deadline, b.deadline),
  absorb: absorbAction,
};

/** A topic said again carries its latest status. */
export const topicRule: MergeRule<Topic> = {
  text: (topic) => topic.name,
  absorb: (kept, repeat) =>
    TOPIC_STATUSES.has(repeat.status) && repeat.status !== kept.status
      ? { ...kept, status: repeat.status }
      : kept,
};

export const insightRule: MergeRule<KeyInsight> = { text: (insight) => insight.text };

export const textRule: MergeRule<string> = { text: (value) => value };
