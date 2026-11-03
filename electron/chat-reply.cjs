// Split streamed replies at confirmed sentence boundaries, never at a character limit.
'use strict';

// llama.cpp GBNF constrains the message format, not sentence length or meaning.
// A character ceiling can force a grammatical-looking but unfinished thought.
// Periods inside numbers, versions, domains and common abbreviations remain valid;
// URLs keep their query punctuation. The ordinary token limit still reports truncation.
const SHORT_REPLY_GRAMMAR = String.raw`
root ::= line ("\n" line){0,2}
line ::= first unit* ending
first ::= plain-start | abbreviation | url
unit ::= plain | dot-pair | abbreviation | url
plain-start ::= [^\x00-\x20。！？.!?]
plain ::= [^\x00-\x1F。！？.!?]
dot-pair ::= "." [A-Za-z0-9]
abbreviation ::= "Dr." | "Mr." | "Mrs." | "Ms." | "Prof." | "Sr." | "Jr." | "St." | "vs." | "etc." | "e.g." | "i.e." | "U.S." | "U.K."
url ::= ("https://" | "http://" | "www.") [A-Za-z0-9._~:/?#@!$&'()*+,;=%+-]+
ending ::= [。！？.!?]
`.trim();

const END = /[。！？.!?]/u;
const CLOSING = /[”’»」』】）\])}]/u;
const CONTENT = /[^\s\p{P}\p{S}\p{M}\u200d\ud800-\udfff]/u;
const DECORATION = /[\p{Emoji_Presentation}\p{Emoji_Modifier}\ufe0e\ufe0f\u200d♪♫♬♡♥❤✨~～]/u;
const ABBREVIATION = /(?:\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|approx|dept|fig|no|vol|inc|ltd|co)\.|\b[A-Za-z]\.|\b(?:[A-Za-z]\.){2,})$/i;

function closingQuote(text, index, start) {
  const char = text[index];
  if (CLOSING.test(char)) return true;
  if (char !== '"' && char !== "'") return false;
  let count = 0;
  for (let cursor = start; cursor < index; cursor++) {
    if (text[cursor] !== char || text[cursor - 1] === '\\') continue;
    // Apostrophes inside words are not quotation marks.
    if (char === "'" && /\w/.test(text[cursor - 1] || '') && /\w/.test(text[cursor + 1] || '')) continue;
    count++;
  }
  return count % 2 === 1;
}

function sentenceEnd(text, index, start) {
  const char = text[index], next = text[index + 1] || '';
  // URL query/path punctuation belongs to the URL until whitespace or a closing quote.
  const token = text.slice(start, index + 1).match(/[^\s“”"'<>]+$/u)?.[0] || '';
  if (/[.!?]/.test(char) && /(?:[A-Za-z][A-Za-z\d+.-]*:\/\/|www\.)/i.test(token)
    && next && !/\s/u.test(next) && !closingQuote(text, index + 1, start)) return false;
  if (char !== '.') return true;
  if (/\d/.test(text[index - 1] || '') && /\d/.test(next)) return false;
  // Domains, email addresses, versions and abbreviations can span SSE chunks.
  if (/[A-Za-z\d_]/.test(next)) return false;
  return !ABBREVIATION.test(text.slice(start, index + 1));
}

function suffixLength(text, index, start) {
  const char = String.fromCodePoint(text.codePointAt(index));
  return END.test(char) || char === '…' || DECORATION.test(char) || closingQuote(text, index, start) ? char.length : 0;
}

/**
 * The final element remains provisional while streaming. A boundary is only
 * emitted once the following message contains content, so closing quotes and
 * repeated punctuation stay with their sentence and cannot form empty bubbles.
 * Previously emitted boundaries do not depend on later chunks. Whitespace at
 * message edges is trimmed; generated words and punctuation are never discarded.
 */
function splitReply(text) {
  if (typeof text !== 'string') throw new TypeError('Reply text must be a string.');
  const replies = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const newline = text[index] === '\n' || text[index] === '\r';
    if (!newline && (!END.test(text[index]) || !sentenceEnd(text, index, start))) continue;
    let end = index + 1;
    // A period followed by punctuation/quotes is one ending, even across chunks.
    let suffix;
    while (end < text.length && (suffix = suffixLength(text, end, start))) end += suffix;
    let next = end;
    while (next < text.length && /\s/u.test(text[next])) next++;
    // Never create a punctuation-only bubble after an explicit line break.
    while (next < text.length && (suffix = suffixLength(text, next, start))) {
      next += suffix; end = next;
      while (next < text.length && /\s/u.test(text[next])) next++;
    }
    const before = text.slice(start, end).trim();
    if (!CONTENT.test(before) || !CONTENT.test(text.slice(next))) continue;
    replies.push(before);
    start = next;
    index = next - 1;
  }
  const tail = text.slice(start).trim();
  if (tail) replies.push(tail);
  return replies;
}

module.exports = { splitReply, SHORT_REPLY_GRAMMAR };
