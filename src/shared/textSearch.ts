import { pageContent } from './pageContent';
import type { PageRecord } from './db/index';
import { foldAsciiLetters, textIndexMayContain, textIndexNeedles } from './db/textIndex';

export type TextMatch = { field: 'title' | 'url' | 'text'; start: number; end: number };

const COMMON_WORDS = new Set('a an and are as at be been being but by can could did do does for from had has have how i if in into is it its me my no not of on or our should so some than that the their them then there these they this those to was we were what when where which who why will with without would you your'.split(' '));
const WEIGHT = { title: 4, url: 3, text: 2 };

function literalPattern(value: string): RegExp {
  return new RegExp(value.trim().split(/\s+/u).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'iu');
}

export function findStoredTextRange(text: string, value: string, from = 0): { start: number; end: number } | undefined {
  if (!value.trim()) return undefined;
  const pattern = new RegExp(literalPattern(value).source, 'gu');
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : undefined;
}

function bestPassage(text: string, patterns: RegExp[]): TextMatch | undefined {
  const combined = new RegExp(patterns.map(pattern => `(${pattern.source})`).join('|'), 'giu');
  const counts = new Map<number, number>();
  const recent: Array<{ term: number; start: number; end: number }> = [];
  let best: TextMatch | undefined, coverage = 0;
  for (const found of text.matchAll(combined)) {
    const term = found.slice(1).findIndex(Boolean), end = found.index + found[0].length;
    recent.push({ term, start: found.index, end }); counts.set(term, (counts.get(term) || 0) + 1);
    while (recent.length > 1 && (recent[0]!.start < end - 240 || counts.get(recent[0]!.term)! > 1)) {
      const removed = recent.shift()!;
      const remaining = counts.get(removed.term)! - 1;
      if (remaining) counts.set(removed.term, remaining); else counts.delete(removed.term);
    }
    const start = recent[0]?.start;
    if (start !== undefined && (counts.size > coverage || counts.size === coverage && best && end - start < best.end - best.start)) { coverage = counts.size; best = { field: 'text', start, end }; }
  }
  return best;
}

function parseQuery(query: string) {
  const parts = [...query.matchAll(/"([^"]+)"|“([^”]+)”|(\S+)/gu)];
  const values = parts.map(part => (part[1] || part[2] || part[3] || '').trim()).filter(Boolean);
  const meaningful = values.filter(value => !COMMON_WORDS.has(value.toLowerCase()));
  return { terms: [...new Set(meaningful.length ? meaningful : values)], phrases: parts.flatMap(part => part[1] || part[2] ? [part[1] || part[2]!] : []), exact: values.join(' ') };
}

function prepareTerm(value: string) {
  const literal = literalPattern(value);
  const startsWord = /^[\p{L}\p{N}_]/u.test(value), endsWord = /[\p{L}\p{N}_]$/u.test(value);
  const word = new RegExp((startsWord ? '(?<![\\p{L}\\p{N}_])' : '') + literal.source + (endsWord ? '(?![\\p{L}\\p{N}_])' : ''), 'iu');
  return { literal, word, startsWord, endsWord };
}

function locateTerm(term: ReturnType<typeof prepareTerm>, text: string): { range: RegExpExecArray; weight: number } | null {
  const found = term.literal.exec(text);
  if (!found) return null;
  const complete = (!term.startsWord || !/[\p{L}\p{N}_]$/u.test(text.slice(Math.max(0, found.index - 2), found.index))) &&
    (!term.endsWord || !/^[\p{L}\p{N}_]/u.test(text.slice(found.index + found[0].length, found.index + found[0].length + 2)));
  const word = complete ? found : term.word.exec(text);
  return { range: word || found, weight: word ? 1 : 0.1 };
}

export function createTextBound(query: string) {
  const parsed = parseQuery(query);
  const prepare = (value: string) => {
    const folded = foldAsciiLetters(value);
    const token = /^[a-z0-9_]+$/u.test(folded) ? folded : null;
    return { ...prepareTerm(value), needles: textIndexNeedles(value), anchors: folded.match(/[a-z0-9_]{3,}/gu) || [],
      token, wholeToken: token === null ? '' : ' ' + token + ' ' };
  };
  const terms = parsed.terms.map(prepare), phrases = parsed.phrases.map(prepare), exact = prepare(parsed.exact);
  return (title: string, url: string, signature: Uint8Array, words?: string) => {
    const bodyMayContain = (value: ReturnType<typeof prepare>): boolean =>
      textIndexMayContain(signature, value.needles) && (words === undefined || value.anchors.every(anchor => words.includes(anchor)));
    const possible = (value: ReturnType<typeof prepare>) => value.literal.test(title) || value.literal.test(url) || bodyMayContain(value);
    if (phrases.some(phrase => !possible(phrase))) return null;
    let score = 0;
    for (const term of terms) {
      score += WEIGHT.title * (locateTerm(term, title)?.weight ?? 0);
      score += WEIGHT.url * (locateTerm(term, url)?.weight ?? 0);
      if (words !== undefined && term.token !== null) {
        if (!textIndexMayContain(signature, term.needles)) continue;
        if (words.includes(term.wholeToken)) score += WEIGHT.text;
        else if (words.includes(term.token)) score += WEIGHT.text * 0.1;
      } else if (bodyMayContain(term)) score += WEIGHT.text;
    }
    return score ? { score, containsExact: possible(exact) } : null;
  };
}

export function createTextMatcher(query: string, options: { passage?: boolean } = {}): (page: PageRecord) => { score: number; snippet: string; containsExact: boolean; match: TextMatch } | null {
  const parsed = parseQuery(query);
  const terms = parsed.terms.map(prepareTerm);
  const phrases = parsed.phrases.map(literalPattern);
  const exact = parsed.exact ? literalPattern(parsed.exact) : null;
  return page => {
    if (!terms.length || !exact) return null;
    const content = pageContent(page);
    const fields = [{ field: 'title' as const, value: page.title || '', weight: WEIGHT.title }, { field: 'url' as const, value: page.url, weight: WEIGHT.url }, { field: 'text' as const, value: content, weight: WEIGHT.text }];
    if (phrases.some(phrase => !fields.some(field => phrase.test(field.value)))) return null;
    let score = 0, match: TextMatch | undefined, matchWeight = 0;
    for (const term of terms) {
      for (const field of fields) {
        const hit = locateTerm(term, field.value);
        if (!hit) continue;
        const { range: located, weight } = hit;
        score += field.weight * weight;
        if (!match || field.field === 'text' && (match.field !== 'text' || weight > matchWeight)) { match = { field: field.field, start: located.index, end: located.index + located[0].length }; matchWeight = weight; }
      }
    }
    if (!score || !match) return null;
    const phrase = exact.exec(content);
    if (phrase) match = { field: 'text', start: phrase.index, end: phrase.index + phrase[0].length };
    else if (options.passage !== false && terms.length > 1) {
      const heading = /^#{1,6}\s+[^\n]+\n+/u.exec(content), offset = heading?.[0].length || 0;
      const passage = bestPassage(content.slice(offset), terms.map(term => term.word));
      if (passage) match = { ...passage, start: passage.start + offset, end: passage.end + offset };
    }
    const offset = match.field === 'text' ? match.start : 0;
    const end = match.field === 'text' ? match.end : 120;
    return { score, containsExact: Boolean(phrase) || exact.test(page.title || '') || exact.test(page.url), match, snippet: content.slice(Math.max(0, offset - 80), end + 120) || page.title || page.url };
  };
}
