// Text normalisation for issue clustering. Deterministic, dependency-free.
// Output is a bag of stemmed terms; the issue body itself is never returned or stored.

const STOP = new Set(
  `a about above after again against all also am an and any are aren as at be because been before being below
  between both but by can cannot could did didn do does doesn doing don down during each else even ever every
  few for from further get gets getting got had has hasn have haven having he her here hers him his how however
  i if in into is isn it its itself just let like made make makes many may me might more most much must my
  need needs no nor not now of off on once one only or other our ours out over own per please same she should
  shouldn since so some still such than that the their theirs them then there these they this those though
  through to too under until up upon us use used uses using very via was wasn way we well were weren what when
  where whether which while who whom why will with within without won would wouldn yes yet you your yours
  thank thanks hi hello hey anyone someone something anything everything thing things want wanted trying try
  tried able seem seems seemed work works worked working instead already actually really currently also
  new old current issue issues bug bugs problem problems question questions feature request requests
  expect expected expecting behavior behaviour actual result results steps reproduce reproduction repro
  describe description additional context environment version versions info information example examples
  happen happens happened case cases see seen look looking following follow below above same different
  provide provided minimal link links code file files line lines run running ran return returns returned
  set sets call calls called time times first last way able doc docs readme
  feat fix chore wip proposal suggestion help question idea discussion bump`.split(/\s+/),
);

// JavaScript keywords that leak in from inline code. "type(s)", "async", "class" and
// "module" are deliberately kept: in this corpus they name real problem areas.
const CODE_STOP = new Set('import export require console log const var function true false null undefined'.split(' '));

// Words that are fine as cluster features but never useful as the first word of a label.
export const WEAK_LABEL_TERMS = new Set(['support', 'add', 'allow', 'option', 'error', 'fail', 'work', 'handl']);

export function cleanMarkdown(text = '') {
  return String(text)
    .replace(/<!--[\s\S]*?-->/g, ' ') // issue-template comments
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ') // raw HTML tags (<img width height alt> in doc issues)
    .replace(/```[\s\S]*?```/g, ' ') // fenced code and logs
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/^\s{4,}\S.*$/gm, ' ') // indented code
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*at .+\(.+:\d+:\d+\)\s*$/gm, ' ') // stack frames
    .replace(/[`*_>#|~-]/g, ' ');
}

export function stem(word) {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (w.length > 4 && w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed') && !w.endsWith('eed')) w = w.slice(0, -2);
  if (w.length > 5 && w.endsWith('ation')) w = w.slice(0, -5) + 'at';
  return w;
}

/**
 * Tokenise into {word: count} of unstemmed words. Stemming happens at clustering time,
 * so labels can be rendered with the most common real word ("middleware"), not a stem.
 */
export function tokenize(text) {
  // Null prototype: issue text contains words like "constructor" and "__proto__".
  const counts = Object.create(null);
  // Split on punctuation (`res.json`, `content-type`), then split long camelCase identifiers
  // (createSecureServer -> create secure server) while keeping two-part names whole
  // (TypeScript, WebSocket, GraphQL), which are product names, not phrases.
  const words = cleanMarkdown(text)
    .split(/[^A-Za-z0-9]+/)
    .flatMap((w) => {
      const parts = w.split(/(?<=[a-z0-9])(?=[A-Z])/);
      return parts.length >= 3 ? parts : [w];
    })
    .map((w) => w.toLowerCase());
  for (const raw of words) {
    if (raw.length < 3 || raw.length > 24) continue;
    if (/^\d/.test(raw)) continue;
    if (STOP.has(raw) || CODE_STOP.has(raw)) continue;
    const s = stem(raw);
    if (s.length < 3 || STOP.has(s)) continue;
    counts[raw] = (counts[raw] ?? 0) + 1;
  }
  return counts;
}

/**
 * Weighted bag of words for one issue. Title words count 3x because titles are short,
 * human-written summaries; body words are capped at 5 so one long log can't dominate.
 */
export function issueTerms(title, body) {
  const t = tokenize(title);
  const b = tokenize(String(body ?? '').slice(0, 4000));
  const out = Object.create(null);
  for (const [k, v] of Object.entries(t)) out[k] = (out[k] ?? 0) + v * 3;
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + Math.min(v, 5);
  return out;
}

/** Titles are user-authored; keep at most 15 words and always pair with the source link. */
export function truncateTitle(title, maxWords = 15) {
  const words = String(title).trim().split(/\s+/);
  return words.length <= maxWords ? words.join(' ') : words.slice(0, maxWords).join(' ') + ' …';
}
