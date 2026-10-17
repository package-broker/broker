export const MAX_ATTRIBUTE_RULES = 1000;
export const MAX_PATTERN_LENGTH = 1024;
export const MAX_PATTERN_WILDCARDS = 32;
export const MAX_MATCH_STEPS = 50_000_000;

export class AttributesLimitError extends Error {
  override readonly name = 'AttributesLimitError';

  constructor(readonly limit: 'rules' | 'pattern_length' | 'wildcards' | 'match_steps') {
    super(`gitattributes exceed the ${limit} limit`);
  }
}

type ClassItem = readonly [number, number] | ((c: number) => boolean);

type Token =
  | { readonly kind: 'lit'; readonly c: number }
  | { readonly kind: 'one' }
  | { readonly kind: 'cls'; readonly negated: boolean; readonly items: readonly ClassItem[] }
  | { readonly kind: 'star' }
  | { readonly kind: 'all' }
  | { readonly kind: 'dirs' };

interface Rule {
  readonly tokens: readonly Token[] | null;
  readonly basename: boolean;
  readonly dirOnly: boolean;
  readonly ignore: boolean;
}

interface AttributesFile {
  readonly dir: string;
  readonly rules: readonly Rule[];
}

const SLASH = 0x2f;

const POSIX: Readonly<Record<string, (c: number) => boolean>> = {
  alnum: (c) => /^[\p{L}\p{N}]$/u.test(String.fromCodePoint(c)),
  alpha: (c) => /^\p{L}$/u.test(String.fromCodePoint(c)),
  blank: (c) => c === 0x20 || c === 0x09,
  cntrl: (c) => c < 0x20 || c === 0x7f,
  digit: (c) => c >= 0x30 && c <= 0x39,
  graph: (c) => c > 0x20 && c !== 0x7f,
  lower: (c) => /^\p{Ll}$/u.test(String.fromCodePoint(c)),
  print: (c) => c >= 0x20 && c !== 0x7f,
  punct: (c) => /^[!-/:-@[-`{-~]$/.test(String.fromCodePoint(c)),
  space: (c) => c === 0x20 || (c >= 0x09 && c <= 0x0d),
  upper: (c) => /^\p{Lu}$/u.test(String.fromCodePoint(c)),
  xdigit: (c) => /^[0-9a-fA-F]$/.test(String.fromCodePoint(c)),
};

function parseClass(chars: readonly number[], start: number): { token: Token; end: number } | null {
  let i = start + 1;
  const negated = chars[i] === 0x21 || chars[i] === 0x5e;
  if (negated) i++;
  const items: ClassItem[] = [];
  let first = true;
  for (; i < chars.length; i++) {
    let c = chars[i] as number;
    if (c === 0x5d && !first) return { token: { kind: 'cls', negated, items }, end: i };
    first = false;
    if (c === 0x5b && chars[i + 1] === 0x3a) {
      const close = chars.indexOf(0x3a, i + 2);
      if (close > 0 && chars[close + 1] === 0x5d) {
        const name = String.fromCodePoint(...chars.slice(i + 2, close));
        const test = POSIX[name];
        if (test === undefined) return null;
        items.push(test);
        i = close + 1;
        continue;
      }
    }
    if (c === 0x5c) {
      i++;
      if (i >= chars.length) return null;
      c = chars[i] as number;
    }
    if (chars[i + 1] === 0x2d && chars[i + 2] !== undefined && chars[i + 2] !== 0x5d) {
      let hi = chars[i + 2] as number;
      i += 2;
      if (hi === 0x5c) {
        i++;
        if (i >= chars.length) return null;
        hi = chars[i] as number;
      }
      items.push([c, hi]);
    } else {
      items.push([c, c]);
    }
  }
  return null;
}

/** Null when the pattern can never match (an unterminated bracket, as in git's wildmatch). */
function compile(pattern: string): Token[] | null {
  const chars = Array.from(pattern, (ch) => ch.codePointAt(0) as number);
  const tokens: Token[] = [];
  let wildcards = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as number;
    if (c === 0x2a) {
      wildcards++;
      let j = i;
      while (chars[j + 1] === 0x2a) j++;
      const double = j > i;
      const atStart = i === 0 || chars[i - 1] === SLASH;
      if (double && atStart && chars[j + 1] === SLASH) {
        tokens.push({ kind: 'dirs' });
        j++;
      } else if (double && atStart && j + 1 === chars.length) {
        tokens.push({ kind: 'all' });
      } else {
        tokens.push({ kind: 'star' });
      }
      i = j;
    } else if (c === 0x3f) {
      wildcards++;
      tokens.push({ kind: 'one' });
    } else if (c === 0x5b) {
      wildcards++;
      const cls = parseClass(chars, i);
      if (cls === null) return null;
      tokens.push(cls.token);
      i = cls.end;
    } else if (c === 0x5c && i + 1 < chars.length) {
      tokens.push({ kind: 'lit', c: chars[++i] as number });
    } else {
      tokens.push({ kind: 'lit', c });
    }
    if (wildcards > MAX_PATTERN_WILDCARDS) throw new AttributesLimitError('wildcards');
  }
  return tokens;
}

function classMatches(token: Extract<Token, { kind: 'cls' }>, c: number): boolean {
  const hit = token.items.some((item) =>
    typeof item === 'function' ? item(c) : c >= item[0] && c <= item[1],
  );
  return hit !== token.negated;
}

const isEpsilon = (t: Token | undefined): boolean =>
  t !== undefined && (t.kind === 'star' || t.kind === 'all' || t.kind === 'dirs');

/**
 * Thompson-style simulation of git's wildmatch with WM_PATHNAME: the set of live pattern
 * positions advances one code point at a time, so time is O(pattern x subject) without
 * backtracking. A `dirs` position (`**` + `/`) has an inner state that may only leave after `/`.
 */
class Matcher {
  private steps = 0;

  match(tokens: readonly Token[], subject: string): boolean {
    const n = tokens.length;
    const stamp = new Int32Array(2 * (n + 1));
    let gen = 1;
    let cur: number[] = [];
    const add = (list: number[], state: number, inner: boolean): void => {
      let s = state;
      let key = s * 2 + (inner ? 1 : 0);
      for (;;) {
        if (stamp[key] === gen) return;
        stamp[key] = gen;
        list.push(key);
        if (inner || !isEpsilon(tokens[s])) return;
        s++;
        key = s * 2;
      }
    };
    add(cur, 0, false);
    for (const ch of subject) {
      const c = ch.codePointAt(0) as number;
      gen++;
      const next: number[] = [];
      for (const key of cur) {
        if (++this.steps > MAX_MATCH_STEPS) throw new AttributesLimitError('match_steps');
        const s = key >> 1;
        const token = tokens[s];
        if (token === undefined) continue;
        if (key & 1 || token.kind === 'dirs') {
          add(next, s, c !== SLASH);
          continue;
        }
        switch (token.kind) {
          case 'lit':
            if (c === token.c) add(next, s + 1, false);
            break;
          case 'one':
            if (c !== SLASH) add(next, s + 1, false);
            break;
          case 'cls':
            if (c !== SLASH && classMatches(token, c)) add(next, s + 1, false);
            break;
          case 'star':
            if (c !== SLASH) add(next, s, false);
            break;
          case 'all':
            add(next, s, false);
            break;
        }
      }
      if (next.length === 0) return false;
      cur = next;
    }
    return stamp[n * 2] === gen;
  }
}

const UNQUOTE: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 0x22,
  '\\': 0x5c,
};

function splitQuoted(line: string): { pattern: string; rest: string } | null {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 1; i < line.length; i++) {
    const ch = line[i] as string;
    if (ch === '"') {
      return { pattern: new TextDecoder().decode(new Uint8Array(bytes)), rest: line.slice(i + 1) };
    }
    if (ch !== '\\') {
      const cp = line.codePointAt(i) as number;
      if (cp > 0xffff) i++;
      bytes.push(...encoder.encode(String.fromCodePoint(cp)));
      continue;
    }
    const esc = line[++i];
    if (esc === undefined) return null;
    const octal = /^[0-3][0-7]{2}/.exec(line.slice(i, i + 3));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 2;
    } else if (UNQUOTE[esc] !== undefined) {
      bytes.push(UNQUOTE[esc]);
    } else {
      return null;
    }
  }
  return null;
}

function parseRule(raw: string): Rule | null {
  const line = raw.replace(/^[ \t]+/, '').replace(/\r$/, '');
  let pattern: string;
  let rest: string;
  if (line.startsWith('"')) {
    const quoted = splitQuoted(line);
    if (quoted === null) return null;
    ({ pattern, rest } = quoted);
  } else {
    const end = line.search(/[ \t]/);
    pattern = end < 0 ? line : line.slice(0, end);
    rest = end < 0 ? '' : line.slice(end);
  }
  if (pattern === '' || pattern.startsWith('#') || pattern.startsWith('!')) return null;
  if (pattern.startsWith('[attr]')) return null;
  let ignore: boolean | undefined;
  for (const attr of rest.split(/[ \t]+/)) {
    if (attr === 'export-ignore') ignore = true;
    else if (
      attr === '-export-ignore' ||
      attr === '!export-ignore' ||
      attr.startsWith('export-ignore=')
    ) {
      ignore = false;
    }
  }
  if (ignore === undefined) return null;
  if (pattern.length > MAX_PATTERN_LENGTH) throw new AttributesLimitError('pattern_length');
  let p = pattern;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const basename = !p.includes('/');
  if (p.startsWith('/')) p = p.slice(1);
  if (p === '') return null;
  return { tokens: compile(p), basename, dirOnly, ignore };
}

/**
 * export-ignore as `git archive` evaluates it from the tree's `.gitattributes` files: deeper files
 * take precedence, the last matching line in a file wins, and an ignored directory drops
 * everything below it. Files must be added in order of increasing depth. Macros (`[attr]`) are
 * not expanded.
 */
export class ExportIgnore {
  private readonly files: AttributesFile[] = [];
  private readonly dirs = new Map<string, boolean>();
  private readonly matcher = new Matcher();
  private ruleCount = 0;

  /** `dir` is the directory holding the file, without a trailing slash; '' for the root. */
  add(dir: string, text: string): void {
    const rules: Rule[] = [];
    for (const line of text.split('\n')) {
      const rule = parseRule(line);
      if (rule === null) continue;
      if (++this.ruleCount > MAX_ATTRIBUTE_RULES) throw new AttributesLimitError('rules');
      rules.push(rule);
    }
    if (rules.length > 0) this.files.push({ dir, rules });
  }

  ignored(path: string): boolean {
    const slash = path.lastIndexOf('/');
    return (slash > 0 && this.dirIgnored(path.slice(0, slash))) || this.attribute(path, false);
  }

  dirIgnored(dir: string): boolean {
    let cached = this.dirs.get(dir);
    if (cached === undefined) {
      const slash = dir.lastIndexOf('/');
      cached = (slash > 0 && this.dirIgnored(dir.slice(0, slash))) || this.attribute(dir, true);
      this.dirs.set(dir, cached);
    }
    return cached;
  }

  private attribute(path: string, isDir: boolean): boolean {
    for (let f = this.files.length - 1; f >= 0; f--) {
      const { dir, rules } = this.files[f] as AttributesFile;
      if (dir !== '' && !path.startsWith(`${dir}/`)) continue;
      const rel = dir === '' ? path : path.slice(dir.length + 1);
      const base = rel.slice(rel.lastIndexOf('/') + 1);
      for (let i = rules.length - 1; i >= 0; i--) {
        const rule = rules[i] as Rule;
        if (rule.tokens === null || (rule.dirOnly && !isDir)) continue;
        if (this.matcher.match(rule.tokens, rule.basename ? base : rel)) return rule.ignore;
      }
    }
    return false;
  }
}

export function exportIgnoreMatcher(gitattributes: string): (path: string) => boolean {
  const matcher = new ExportIgnore();
  matcher.add('', gitattributes);
  return (path) => matcher.ignored(path);
}
