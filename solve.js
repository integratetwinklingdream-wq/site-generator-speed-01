// Fast drop-in replacement for the reference static site generator.
// Written for this entry: a single-pass Markdown renderer, a cached slug
// table, word counting without token allocation, and template rendering
// into a shared chunk buffer. The observable behaviour (front matter
// rules, slug rule, Markdown subset, template dialect, link resolution,
// collections, tags, report) follows the competition's published spec.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

// ---------- text helpers ----------

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(text) {
  // Fast path: most strings carry no character that needs escaping.
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      return text.replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);
    }
  }
  return text;
}

function escChar(ch) {
  const r = ESC_MAP[ch];
  return r === undefined ? ch : r;
}

// Slug table, rebuilt for every case (nothing is kept between cases).
let slugCache = new Map();

function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let result;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (ascii) {
    let out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep < 0) { gap = out.length > 0; continue; }
      if (gap) { out += '-'; gap = false; }
      out += String.fromCharCode(keep);
    }
    if (out.length > 64) out = out.slice(0, 64);
    while (out.endsWith('-')) out = out.slice(0, -1);
    result = out === '' ? 'untitled' : out;
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    if (out.length > 64) out = out.slice(0, 64);
    while (out.endsWith('-')) out = out.slice(0, -1);
    result = out === '' ? 'untitled' : out;
  }
  slugCache.set(text, result);
  return result;
}

function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = 2;
  let out = slug + '-2';
  while (taken.has(out)) { n++; out = slug + '-' + n; }
  taken.add(out);
  return out;
}

function longDate(date) {
  const first = date.indexOf('-');
  const second = date.indexOf('-', first + 1);
  const day = Number(date.slice(second + 1));
  const month = Number(date.slice(first + 1, second));
  return day + ' ' + MONTHS[month - 1] + ' ' + date.slice(0, first);
}

function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

function countWords(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isSpaceCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

const byCU = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
};

// ---------- front matter ----------

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringValue(raw) {
  if (raw.charCodeAt(0) === 34) { // opening quote
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function keyValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringValue(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) {
        for (const i of [0, 1, 2, 3, 5, 6, 8, 9]) {
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      const y = Number(raw.slice(0, 4));
      const mo = Number(raw.slice(5, 7));
      const d = Number(raw.slice(8, 10));
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) {
          return { error: 'key "layout": not a template name' };
        }
      }
      return { value: raw };
    }
    case 'slug': {
      // a-z0-9 runs joined by single hyphens, at most 64 chars
      let ok = raw.length >= 1 && raw.length <= 64;
      if (ok) {
        let prevHyphen = true; // also rejects a leading hyphen
        for (let i = 0; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          if (c === 45) {
            if (prevHyphen) { ok = false; break; }
            prevHyphen = true;
          } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevHyphen = false;
          else { ok = false; break; }
        }
        if (prevHyphen) ok = false; // trailing hyphen
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

// Parses the header without splitting the whole document: the closing
// line is located first (its absence outranks any line error), then the
// lines between the markers are checked one by one.
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let lineStart = 4;
  let closeStart = -1;
  let bodyStart = -1;
  if (text === '---') return { error: 'the front matter is not closed' };
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    if (lineEnd - lineStart === 3 && text.startsWith('---', lineStart)) {
      closeStart = lineStart;
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 2; // the opening marker is line 1
  let pos = 4;
  while (pos < closeStart) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? closeStart : Math.min(nl, closeStart);
    const line = text.slice(pos, lineEnd);
    // blank (spaces/tabs only) or comment
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (!blank && !line.startsWith('#')) {
      // key: value, key from a-z and _, colon, then nothing or one space + value
      const colon = line.indexOf(':');
      let shapeOk = colon > 0;
      if (shapeOk) {
        for (let i = 0; i < colon; i++) {
          const c = line.charCodeAt(i);
          if (!((c >= 97 && c <= 122) || c === 95)) { shapeOk = false; break; }
        }
      }
      let rawPart = null;
      if (shapeOk) {
        if (colon === line.length - 1) rawPart = '';
        else if (line[colon + 1] === ' ') rawPart = line.slice(colon + 2);
        else shapeOk = false;
      }
      if (!shapeOk) return { error: 'line ' + lineNo + ' is not "key: value"' };
      const key = line.slice(0, colon);
      let raw = rawPart;
      let end = raw.length;
      while (end > 0 && (raw.charCodeAt(end - 1) === 32 || raw.charCodeAt(end - 1) === 9)) end--;
      if (end !== raw.length) raw = raw.slice(0, end);
      if (!FM_KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
      if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
      if (raw === '') return { error: 'key "' + key + '" has no value' };
      const v = keyValue(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1 || nl >= closeStart) break;
    pos = nl + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------- templates ----------

class TplError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

// Node kinds: 0 text, 1 escaped var, 2 raw var, 3 for, 4 if, 5 include.
function pathOf(name, text) {
  if (!PATH_RE.test(text)) {
    throw new TplError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  }
  return text.split('.');
}

function onlyBlank(s, from, to) {
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  let text = '';
  let i = 0;
  const flushText = () => {
    if (text !== '') { body.push({ t: 0, text }); text = ''; }
  };
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const closer = raw ? '}}}' : '}}';
      const close = src.indexOf(closer, open + (raw ? 3 : 2));
      if (close === -1) {
        throw new TplError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      }
      flushText();
      body.push({ t: raw ? 2 : 1, path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + closer.length;
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TplError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlyBlank(src, lineStart, open) && onlyBlank(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    flushText();
    const tag = src.slice(open + 2, close).trim();
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { t: 3, kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { t: 4, kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], els: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.els !== null) {
        throw new TplError('template "' + name + '": an else outside an if');
      }
      top.els = [];
      body = top.els;
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== want) {
        throw new TplError('template "' + name + '": an ' + tag + ' with no open ' + want);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.els ?? parent.then;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ t: 5, name: m[1] });
    } else {
      throw new TplError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  flushText();
  if (stack.length > 1) {
    throw new TplError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  }
  return root.body;
}

function lookup(scope, path) {
  const first = path[0];
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth, out) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx];
    switch (n.t) {
      case 0:
        out.push(n.text);
        break;
      case 1:
        out.push(esc(textOf(lookup(scope, n.path))));
        break;
      case 2:
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 4: {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.els;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 3: {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = {};
          vars[n.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === len - 1, length: len };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 5: {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------- Markdown ----------

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function findUnescaped(s, what, from) {
  const last = s.length - what.length;
  for (let j = from; j <= last; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

const MD_SPECIAL = /[\\`*[]/;
const HTML_SPECIAL = /[&<>"']/;

function inline(s, link) {
  // Fast paths: no Markdown metacharacter at all.
  if (!MD_SPECIAL.test(s)) {
    return HTML_SPECIAL.test(s) ? esc(s) : s;
  }
  let out = '';
  let plainStart = 0;
  let i = 0;
  const flush = (upto) => {
    if (upto > plainStart) out += esc(s.slice(plainStart, upto));
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
      flush(i);
      out += escChar(s[i + 1]);
      i += 2;
      plainStart = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush(i);
        out += '<code>' + esc(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
        plainStart = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          flush(i);
          out += '<strong>' + inline(s.slice(i + 2, j), link) + '</strong>';
          i = j + 2;
          plainStart = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        flush(i);
        out += '<em>' + inline(s.slice(i + 1, j), link) + '</em>';
        i = j + 1;
        plainStart = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        flush(i);
        out += '<a href="' + esc(link(target)) + '">' + inline(s.slice(i + 1, k), link) + '</a>';
        i = m + 1;
        plainStart = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flush(s.length);
  return out;
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Fence opener: ``` + optional language + blanks. Returns lang or null.
function fenceLang(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  let lang = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) {
      lang += line[i];
      i++;
    } else break;
  }
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Heading: 1-6 '#', at least one blank, then non-empty text (trailing
// blanks dropped). Returns {depth, text} or null.
function headingOf(line) {
  let depth = 0;
  while (depth < line.length && line[depth] === '#') depth++;
  if (depth === 0 || depth > 6) return null;
  if (depth >= line.length) return null;
  const c = line.charCodeAt(depth);
  if (c !== 32 && c !== 9) return null;
  let start = depth;
  while (start < line.length && (line.charCodeAt(start) === 32 || line.charCodeAt(start) === 9)) start++;
  let end = line.length;
  while (end > start && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === start) return null;
  return { depth, text: line.slice(start, end) };
}

function isHr(line) {
  let body = line;
  if (body.startsWith('---')) body = body.slice(3);
  else if (body.startsWith('***')) body = body.slice(3);
  else return false;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  let start = 0;
  let end = line.length;
  while (start < end && (line.charCodeAt(start) === 32 || line.charCodeAt(start) === 9)) start++;
  while (end > start && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  return start === 0 && end === line.length ? line : line.slice(start, end);
}

function bulletOf(line) {
  if (line.length >= 2 && (line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
  return null;
}

function orderedOf(line) {
  let i = 0;
  while (i < line.length && i < 10) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === 0 || i > 9) return null;
  if (line[i] !== '.' || line[i + 1] !== ' ') return null;
  return { num: Number(line.slice(0, i)), rest: line.slice(i + 2) };
}

function isContinued(line) {
  if (line.length < 3) return false;
  if (line[0] !== ' ' || line[1] !== ' ') return false;
  // two or more spaces, then a non-space (any \S)
  for (let i = 2; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) continue;
    return !isSpaceCode(c) && c !== 9;
  }
  return false;
}

function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const ids = new Set();
  const chunks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      const bodyStart = i;
      while (i < lines.length && !isFenceClose(lines[i])) i++;
      let inner = '';
      for (let k = bodyStart; k < i; k++) inner += esc(lines[k]) + '\n';
      i++; // the closing line, or one past the end
      chunks.push('<pre><code' + (lang === '' ? '' : ' class="language-' + esc(lang) + '"') + '>' + inner + '</code></pre>\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, link);
      chunks.push('<h' + heading.depth + ' id="' + id + '">' + html + '</h' + heading.depth + '>\n');
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { chunks.push('<hr>\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) { // '>'
      const kept = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        let rest = lines[i].slice(1);
        if (rest.startsWith(' ')) rest = rest.slice(1);
        const t = trimLine(rest);
        if (t !== '') kept.push(t);
        i++;
      }
      chunks.push(kept.length === 0
        ? '<blockquote>\n</blockquote>\n'
        : '<blockquote>\n<p>' + inline(kept.join('\n'), link) + '</p>\n</blockquote>\n');
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < lines.length) {
        const cur = lines[i];
        const b = isOrdered ? null : bulletOf(cur);
        const o = isOrdered ? orderedOf(cur) : null;
        if (b !== null || o !== null) {
          items.push([trimLine(isOrdered ? o.rest : b)]);
          i++;
        } else if (isContinued(cur)) {
          items[items.length - 1].push(trimLine(cur));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.num !== 1 ? '<ol start="' + ordered.num + '">' : '<' + tag + '>';
      let block = open + '\n';
      for (const parts of items) block += '<li>' + inline(parts.join('\n'), link) + '</li>\n';
      block += '</' + tag + '>\n';
      chunks.push(block);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) { body.push(trimLine(lines[i])); i++; }
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    chunks.push('<p>' + html + '</p>\n');
  }
  return { html: chunks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------- the build ----------

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function run(input) {
  slugCache = new Map();
  const report = [];
  const templates = new Map();
  const names = Object.keys(input.templates).sort(byCU);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TplError)) throw err;
      report.push(err.message);
    }
  }
  const baseRaw = input.site.base_url;
  let baseEnd = baseRaw.length;
  while (baseEnd > 0 && baseRaw[baseEnd - 1] === '/') baseEnd--;
  const base = baseEnd === baseRaw.length ? baseRaw : baseRaw.slice(0, baseEnd);

  // sources and statics, in path order
  const files = input.files.slice().sort((x, y) => byCU(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      sources.push({ path: f.path, text });
    } else statics.push(f);
  }

  // front matter and the refusal chain, in spec order
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push('refused ' + s.path + ': ' + fm.error); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) { report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own'); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) { report.push('draft ' + s.path); continue; }
    kept.push(s);
  }
  sources = kept;

  // permalinks
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // markdown, with per-source link resolution
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) return page.url + frag;
        if (staticPaths.has(path)) return base + '/' + path + frag;
      }
      broken.add('broken-link ' + srcPath + ' -> ' + target);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // collections
  const posts = [];
  for (const s of sources) if (s.post) posts.push(s);
  posts.sort((x, y) => byCU(y.data.date, x.data.date) || byCU(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tagList = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCU(x.slug, y.slug));

  // cards, links and pages (each built once per source)
  const getCard = (s) => {
    if (s.card !== undefined) return s.card;
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s.card = card;
    return card;
  };
  const linkOf = (s) => {
    if (s === null) return null;
    const c = getCard(s);
    return { title: c.title, url: c.url, date: c.date, date_long: c.date_long };
  };
  const pageOf = (s) => {
    const page = Object.assign({}, getCard(s));
    page.slug = s.slug;
    page.content = s.html;
    page.toc = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
    page.newer = linkOf(s.newer ?? null);
    page.older = linkOf(s.older ?? null);
    page.is_post = s.post;
    return page;
  };

  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map(getCard);
  const ctx = { templates };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of sources) output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map(getCard),
      pager: {
        number: k,
        total: pageCount,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pageCount ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tagList) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map(getCard) },
    });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // report
  const lines = [...report, ...broken].sort(byCU);
  let pageTotal = 0;
  for (const s of sources) if (!s.post) pageTotal++;
  lines.push('built ' + pageTotal + ' pages, ' + posts.length + ' posts, ' + tagList.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
