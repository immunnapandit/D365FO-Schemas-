import { MASK } from './secrets.js';

/**
 * Secret values inside an imported file (Postman collection or OpenAPI, JSON or YAML) are hidden when the
 * file is shown in the browser, the same way module secrets are. When the edited file comes back with the
 * hidden marker, the stored values are put back, so a secret never has to be typed twice.
 *
 * Works on the text itself, so the file keeps its own layout. Covered forms:
 *   "client_secret": "abc"        client_secret: abc          (JSON and YAML key: value)
 *   { "key": "clientSecret", "value": "abc" }                  (Postman variables and auth entries)
 *   client_secret=abc&...                                      (url-encoded bodies, in raw strings)
 */

const NAMES = [
  'client_?secret',
  'password',
  'passwd',
  'api_?key',
  'subscription_?key',
  'access_?token',
  'refresh_?token',
  'ocp-apim-subscription-key',
].join('|');

const PATTERNS = [
  // Postman: { "key": "clientSecret", "value": "abc" } (type or other fields may sit in between)
  new RegExp(`"key"\\s*:\\s*"(${NAMES})"\\s*,(?:\\s*"(?:type|description|disabled)"\\s*:\\s*(?:"[^"]*"|true|false)\\s*,)*\\s*"value"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'gi'),
  // JSON: "client_secret": "abc"
  new RegExp(`"(${NAMES})"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'gi'),
  // YAML: client_secret: abc   (optionally quoted; not a { type: string } schema or a block / anchor)
  new RegExp(`^[ \\t-]*['"]?(${NAMES})['"]?[ \\t]*:[ \\t]*['"]?([^'"\\s#{[|>&*][^'"\\n#]*?)['"]?[ \\t]*$`, 'gim'),
  // url-encoded: client_secret=abc
  new RegExp(`(?<![\\w-])(${NAMES})=([^&\\s"'\\\\]+)`, 'gi'),
];

const isPlaceholder = (v) => /^\s*(\{\{[^}]*\}\}\s*)+$/.test(v) || /^<[^>]*>$/.test(v.trim());

/** Every secret value in the text: where it is, which name it belongs to, and the raw value. */
export function findSecrets(text) {
  const found = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const value = m[2];
      const start = m.index + m[0].lastIndexOf(value);
      const end = start + value.length;
      if (!value || found.some((f) => start < f.end && end > f.start)) continue; // first pattern wins
      found.push({ name: m[1].toLowerCase().replace(/[_-]/g, ''), value, start, end });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

function replaceSpans(text, spans) {
  let out = text;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + s.to + out.slice(s.end);
  return out;
}

/** The file as shown in the browser: literal secret values replaced by the hidden marker. */
export function maskSpecContent(text) {
  if (typeof text !== 'string') return text;
  const spans = findSecrets(text)
    .filter((s) => s.value !== MASK && !isPlaceholder(s.value))
    .map((s) => ({ ...s, to: MASK }));
  return replaceSpans(text, spans);
}

/**
 * Puts the stored values back where the edited file still has the hidden marker.
 * The n-th hidden "client_secret" gets the n-th stored "client_secret" value.
 * Returns { content, missing } where missing lists names that could not be restored.
 */
export function restoreSpecContent(text, storedText) {
  if (typeof text !== 'string' || !text.includes(MASK)) return { content: text, missing: [] };
  const stored = typeof storedText === 'string' ? findSecrets(storedText).filter((s) => s.value !== MASK && !isPlaceholder(s.value)) : [];
  const used = {};
  const missing = [];
  const spans = [];
  for (const s of findSecrets(text)) {
    if (s.value !== MASK) continue;
    const n = used[s.name] ?? 0;
    used[s.name] = n + 1;
    const match = stored.filter((x) => x.name === s.name)[n];
    if (match) spans.push({ ...s, to: match.value });
    else missing.push(s.name);
  }
  const content = replaceSpans(text, spans);
  // a marker that sits somewhere this file does not recognise as a secret is also missing
  if (content.includes(MASK) && !missing.length) missing.push('a hidden value');
  return { content, missing };
}
