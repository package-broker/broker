/*
 * The ISC License
 *
 * Copyright (c) Isaac Z. Schlueter and Contributors
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
 * IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
import { PublishValidationError } from './tarball-walk.js';

export const PACKLIST_VERSION = '10.0.4';
const fail = (detail: string): never => {
  throw new PublishValidationError('invalid_packlist', 400, { detail });
};
const defaults = [
  '.npmignore',
  '.gitignore',
  '**/.git',
  '**/.svn',
  '**/.hg',
  '**/CVS',
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',
  '**/CVS/**',
  '/.lock-wscript',
  '/.wafpickle-*',
  '/build/config.gypi',
  'npm-debug.log',
  '**/.npmrc',
  '.*.swp',
  '.DS_Store',
  '**/.DS_Store/**',
  '._*',
  '**/._*/**',
  '*.orig',
  '/archived-packages/**',
];
const strict = [
  '!/package.json',
  '!/readme{,.*[^~$]}',
  '!/copying{,.*[^~$]}',
  '!/license{,.*[^~$]}',
  '!/licence{,.*[^~$]}',
  '/.git',
  '/node_modules',
  '.npmrc',
  '/package-lock.json',
  '/yarn.lock',
  '/pnpm-lock.yaml',
  '/bun.lockb',
];

// RegExp's non-Unicode ignore-case fold preserves UTF-16 units.
const fold = (value: string): string =>
  /^[\x20-\x7e]*$/.test(value)
    ? value.toUpperCase()
    : value.replace(/[a-z]|[^\x20-\x7e]/g, (unit) => {
        const upper = unit.toUpperCase();
        return upper.length === 1 && (unit.charCodeAt(0) < 128 || upper.charCodeAt(0) >= 128)
          ? upper
          : unit;
      });

const unsupported = (): never => {
  throw new PublishValidationError('candidate_skipped', 400, {
    detail: 'unsupported_files_pattern',
  });
};

function expand(pattern: string, reserve: (length: number) => void): string[] {
  const chunks: string[][] = [];
  let literal = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\' && i + 1 < pattern.length) {
      literal += c + pattern[++i]!;
    } else if (c === '{') {
      const opening = i;
      const parts = [''];
      let closed = false;
      for (++i; i < pattern.length; i++) {
        const c = pattern[i]!;
        if (c === '\\' && i + 1 < pattern.length) parts[parts.length - 1] += c + pattern[++i]!;
        else if (c === '{') unsupported();
        else if (c === '}') {
          closed = true;
          break;
        } else if (c === ',') parts.push('');
        else parts[parts.length - 1] += c;
      }
      if (!closed || parts.length < 2) {
        if (closed && /^(?:-?\d+\.\.-?\d+|[a-zA-Z]\.\.[a-zA-Z])(?:\.\.-?\d+)?$/.test(parts[0]!))
          unsupported();
        literal += pattern.slice(opening, closed ? i + 1 : pattern.length);
      } else {
        chunks.push([literal], parts);
        literal = '';
      }
    } else literal += c;
  }
  chunks.push([literal]);
  let count = 1,
    length = 0;
  for (const chunk of chunks) {
    length = length * chunk.length + chunk.reduce((n, p) => n + p.length, 0) * count;
    count *= chunk.length;
    if (count > 16) unsupported();
  }
  reserve(length);
  let result = [''];
  for (const chunk of chunks)
    result = result.flatMap((prefix) => chunk.map((part) => prefix + part));
  return result;
}

type Token =
  | { kind: 'literal'; value: string }
  | { kind: '*' }
  | { kind: '?' }
  | { kind: 'class'; regex: RegExp }
  | { kind: 'never' };
function tokens(pattern: string): Token[] {
  const result: Token[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if ('@+*?!'.includes(char) && pattern[i + 1] === '(')
      throw new PublishValidationError('candidate_skipped', 400, {
        detail: 'unsupported_files_pattern',
      });
    if (char === '\\' && i + 1 < pattern.length) {
      result.push({ kind: 'literal', value: fold(pattern[++i]!) });
      continue;
    }
    if (char === '*' || char === '?') {
      result.push({ kind: char });
      continue;
    }
    if (char === '[') {
      let end = i + 1;
      if (pattern[end] === '!' || pattern[end] === '^') end++;
      const start = end;
      for (; end < pattern.length; end++) {
        if (pattern[end] === '\\' && end + 1 < pattern.length) {
          end++;
          continue;
        }
        if (pattern[end] === ']' && end > start) break;
      }
      const source = pattern.slice(i + 1, end);
      if (end < pattern.length) {
        for (let at = 0; at < source.length; at++) if (source.charCodeAt(at) > 127) unsupported();
        const posix = [
          'alnum',
          'alpha',
          'ascii',
          'blank',
          'cntrl',
          'digit',
          'graph',
          'lower',
          'print',
          'punct',
          'space',
          'upper',
          'word',
          'xdigit',
        ];
        const ranges: { start: string; end?: string }[] = [];
        const escape = (value: string) => '\\x' + value.charCodeAt(0).toString(16).padStart(2, '0');
        let at = 0;
        let negate = source[0] === '!' || source[0] === '^';
        if (negate) at++;
        let rangeStart = '';
        while (at < source.length) {
          const position = i + 1 + at;
          let c = source[at++]!;
          const escaped = c === '\\';
          if (escaped && at < source.length) c = source[at++]!;
          if (
            !escaped &&
            c === '[' &&
            posix.some((name) => pattern.startsWith('[:' + name + ':]', position))
          )
            unsupported();
          if (rangeStart) {
            if (c > rangeStart) ranges.push({ start: rangeStart, end: c });
            else if (c === rangeStart) ranges.push({ start: c });
            rangeStart = '';
          } else if (source[at] === '-' && at + 1 < source.length) {
            rangeStart = c;
            at++;
          } else ranges.push({ start: c });
        }
        if (!ranges.length) {
          result.push({ kind: 'never' });
          return result;
        }
        // parseClass simplifies one literal before interpreting a leading caret
        // as regex negation, including an escaped caret or caret range start.
        const first = ranges[0]!;
        if (!negate && first.start === '^' && (ranges.length > 1 || first.end)) {
          negate = true;
          ranges.shift();
          if (first.end) ranges.unshift({ start: '-' }, { start: first.end });
        }
        const body = ranges
          .map((r) => escape(r.start) + (r.end ? '-' + escape(r.end) : ''))
          .join('');
        result.push({
          kind: 'class',
          regex: new RegExp('^[' + (negate ? '^' : '') + body + ']$', 'i'),
        });
        i = end;
        continue;
      }
    }
    result.push({ kind: 'literal', value: fold(char) });
  }
  return result;
}
function matchSegment(sequence: Token[], name: string, spend: (amount: number) => void): boolean {
  spend(sequence.length * name.length * 256);
  if (!name && sequence.length) return false;
  const characters = name;
  let previous = new Uint8Array(characters.length + 1);
  previous[0] = 1;
  let next = new Uint8Array(characters.length + 1);
  for (const token of sequence) {
    next.fill(0);
    if (token.kind === '*') next[0] = previous[0]!;
    for (let j = 1; j <= characters.length; j++) {
      const char = characters[j - 1]!;
      next[j] =
        token.kind === '*'
          ? previous[j]! | next[j - 1]!
          : previous[j - 1]! &&
              (token.kind === '?' ||
                (token.kind === 'class'
                  ? token.regex.test(char)
                  : token.kind === 'literal' && token.value === char))
            ? 1
            : 0;
    }
    const row = previous;
    previous = next;
    next = row;
  }
  return previous[characters.length] === 1;
}
interface Rule {
  include: boolean;
  relative: boolean;
  basename: boolean;
  requiredText: string;
  match(path: string, partial?: boolean): boolean;
}
function rule(
  raw: string,
  spend: (amount: number) => void,
  reserve: (length: number) => void,
): Rule[] {
  let include = false;
  while (raw.startsWith('!') && raw[1] !== '(') {
    include = !include;
    raw = raw.slice(1);
  }
  if (raw.length > 4096) fail('packlist_budget');
  const alternatives = expand(raw, reserve);
  const globParts = alternatives.map((expanded) => {
    const normalized: string[] = [];
    for (const part of expanded.split(/\/+/)) {
      const previous = normalized.at(-1);
      if (part === '**' && previous === '**') continue;
      if (part === '..' && previous && !['..', '.', '**'].includes(previous)) normalized.pop();
      else normalized.push(part);
    }
    return normalized;
  });
  const relative = globParts.some((parts) => parts.length <= (parts.at(-1) ? 1 : 2));
  return alternatives
    .map((expanded, alternative) => {
      const normalized = globParts[alternative]!;
      const segments = normalized.map((part) => {
        if (part === '**') return '**' as const;
        const sequence = tokens(part);
        const literal = sequence.every((token) => token.kind === 'literal')
          ? sequence.map((token) => token.value).join('')
          : undefined;
        return {
          length: part.length,
          weight: Math.max(1, sequence.filter((token) => token.kind === '*').length - 1),
          match: (name: string) =>
            literal === undefined ? matchSegment(sequence, name, spend) : literal === name,
        };
      });
      spend(expanded.length);
      const basename = segments.length === 1;
      const wildcardWeight = Math.max(
        1,
        ...segments.map((part) => (part === '**' ? 1 : part.weight)),
      );
      const basenameCache = new Map<string, boolean>();
      const last = segments.at(-1);
      const literalTokens = normalized.flatMap((part) =>
        part === '**' ? [{ kind: '*' as const }] : [...tokens(part), { kind: '*' as const }],
      );
      const requiredText =
        literalTokens
          .map((t) => (t.kind === 'literal' ? t.value : '\0'))
          .join('')
          .split('\0')
          .sort((a, b) => b.length - a.length)[0] ?? '';
      return {
        include,
        relative,
        basename,
        requiredText,
        match(path: string, allowPartial = false) {
          spend(path.length);
          const trimmed = basename ? path.replace(/\/+$/, '') : path;
          const value = basename ? trimmed.slice(trimmed.lastIndexOf('/') + 1) : path;
          if (basename && last !== '**') {
            const cached = basenameCache.get(value);
            if (cached !== undefined) return cached;
            spend(expanded.length + value.length);
            const result = (!requiredText || value.includes(requiredText)) && last!.match(value);
            if (basenameCache.size >= 256) basenameCache.clear();
            basenameCache.set(value, result);
            return result;
          }
          let nameCount = 1;
          for (let at = 0; at < value.length; at++) if (value.charCodeAt(at) === 47) nameCount++;
          spend(segments.length * nameCount);
          if (!allowPartial && requiredText && !value.includes(requiredText)) {
            spend((expanded.length + value.length) * wildcardWeight);
            return false;
          }
          const names = value.split('/');
          if (names.at(-1) === '' && allowPartial) names.pop();
          const cells = segments.length * names.length;

          // Each path cell and each segment wildcard cell is charged before execution.
          spend(cells * 256);
          for (let i = 0; i < segments.length; i++) {
            const part = segments[i]!;
            if (part === '**') continue;
            for (const name of names) spend(part.length * name.length);
          }
          let previous = new Uint8Array(names.length + 1);
          previous[0] = 1;
          let next = new Uint8Array(names.length + 1);
          for (let index = 0; index < segments.length; index++) {
            const part = segments[index]!;
            next.fill(0);
            if (part === '**' && index < segments.length - 1) next[0] = previous[0]!;
            for (let j = 1; j <= names.length; j++) {
              next[j] =
                part === '**'
                  ? (index < segments.length - 1 ? previous[j]! : 0) |
                    previous[j - 1]! |
                    (names[j - 1] ? next[j - 1]! : 0)
                  : previous[j - 1]! && part.match(names[j - 1]!)
                    ? 1
                    : 0;
            }
            const row = previous;
            previous = next;
            next = row;
            if (allowPartial && previous[names.length]) return true;
          }
          return previous[names.length] === 1;
        },
      };
    })
    .map((r) => {
      if (r.basename) return r;
      const match = r.match;
      const cache = new Map<string, boolean>();
      r.match = (path: string, partial = false) => {
        spend(path.length + r.requiredText.length);
        if (!partial && r.requiredText && !path.includes(r.requiredText)) return false;
        const key = partial + ':' + path;
        const cached = cache.get(key);
        if (cached !== undefined) return cached;
        const result = match(path, partial);
        if (cache.size >= 256) cache.clear();
        cache.set(key, result);
        return result;
      };
      return r;
    });
}
const stringList = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
    return fail('manifest_files');
  return value as string[];
};
function parsePackManifest(body: string): Record<string, unknown> {
  try {
    const result: unknown = JSON.parse(body);
    if (!result || typeof result !== 'object' || Array.isArray(result)) return fail('manifest');
    return result as Record<string, unknown>;
  } catch {
    return fail('manifest');
  }
}
interface RuleGroup {
  rules: Rule[];
  basename: boolean;
  cache: Map<string, number>;
  requiredText: string;
  paths: Map<string, boolean>;
  excludePrefixes?: string;
}
interface Directory {
  path: string;
  parent: Directory | undefined;
  base: string;
  exact: boolean;
  rules: Rule[];
  groups: RuleGroup[];
  required: string[];
  cacheKey?: string;
  cacheResult?: boolean;
  reachable?: boolean;
  partialCache: Map<string, Set<Rule>>;
}

export function packlist(
  paths: ReadonlySet<string>,
  metadata: ReadonlyMap<string, string | (() => string)>,
  maxRuleBytes = 4 * 1024 * 1024,
  diagnostics?: { work: number },
): string[] {
  const selection = selectPacklist(paths, new Set(metadata.keys()), maxRuleBytes, diagnostics);
  let step = selection.next();
  while (!step.done) {
    const captured = metadata.get(step.value);
    step = selection.next(typeof captured === 'function' ? captured() : captured);
  }
  return step.value;
}

export function* selectPacklist(
  paths: ReadonlySet<string>,
  metadata: ReadonlySet<string>,
  maxRuleBytes = 4 * 1024 * 1024,
  diagnostics?: { work: number },
  spendWork?: (amount: number) => void,
): Generator<string, string[], string | undefined> {
  let work = 0;
  if (diagnostics) diagnostics.work = 0;
  let compiledBytes = 0;
  const reserve = (length: number) => {
    compiledBytes += length * 2;
    if (compiledBytes > 4 * 1024 * 1024) fail('compiled_rule_cap');
  };
  const spend = (amount = 1) => {
    spendWork?.(amount);
    if (amount > 2_000_000_000 - work) fail('packlist_budget');
    work += amount;
    if (diagnostics) diagnostics.work = work;
  };
  let lines = 0,
    bytes = 0;
  const read = new Map<string, string>();
  function* readMetadata(path: string): Generator<string, string | undefined, string | undefined> {
    const cached = read.get(path);
    if (cached !== undefined) return cached;
    if (!metadata.has(path)) return undefined;
    const body = yield path;
    if (body === undefined) return undefined;
    const size = new TextEncoder().encode(body).length;
    const manifest = path.endsWith('package.json');
    if (manifest && size > 262144) fail('manifest_cap');
    if (!manifest && size >= 4 * 1024 * 1024) fail('packlist_budget');
    bytes += size;
    if (bytes > maxRuleBytes) fail('rule_cap');
    if (!manifest) {
      const count = body.split('\n').length;
      lines += count;
      if (count > 2000 || lines > 10000) fail('packlist_budget');
    }
    read.set(path, body);
    return body;
  }
  const compiled = new Map<string, Rule[]>();
  const rules = (input: readonly string[]) =>
    input.flatMap((line) => {
      const raw = line.trim();
      if (!raw || raw.startsWith('#')) return [];
      let result = compiled.get(raw);
      if (!result) {
        result = rule(raw, spend, reserve);
        compiled.set(raw, result);
      }
      return result;
    });
  const rootBody = yield* readMetadata('package.json');
  const rootManifest = parsePackManifest(rootBody ?? '');
  const output = new Set<string>();
  const seenBundles = new Set<string>();
  const subtrees = new Map<string, string[]>();
  const directoryPaths = new Set<string>();
  const parentPaths = new Map<string, { parent: string; base: string }>();
  for (const path of paths) {
    spend(path.length);
    if (path.split('/').length > 64) fail('path_too_deep');
    const prefixes = [''];
    const packagePath = /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+(?=\/)/g;
    for (const match of path.matchAll(packagePath))
      prefixes.push(path.slice(0, match.index + match[0].length + 1));
    for (const prefix of prefixes) {
      let subtree = subtrees.get(prefix);
      if (!subtree) subtrees.set(prefix, (subtree = []));
      subtree.push(path);
    }
    let at = path.indexOf('/');
    let parent = '';
    let start = 0;
    while (at >= 0) {
      const directory = path.slice(0, at);
      directoryPaths.add(directory);
      parentPaths.set(directory, { parent, base: path.slice(start, at) });
      parent = directory;
      start = at + 1;
      at = path.indexOf('/', at + 1);
    }
  }
  const defaultRules = rules(defaults);
  const isDirectory = (path: string) => directoryPaths.has(path);
  function* gather(
    prefix: string,
    manifest: Record<string, unknown>,
    bundled: boolean,
  ): Generator<string, void, string | undefined> {
    const subtree = subtrees.get(prefix) ?? [];
    const required: string[] = [];
    const includes: string[] = [];
    const rootStrict = [...strict];
    if (manifest.files !== undefined) {
      const selectors = stringList(manifest.files);
      lines += selectors.length;
      if (lines > 10000) fail('packlist_budget');
      for (let file of selectors) {
        if (file.startsWith('./')) file = file.slice(1);
        if (file.endsWith('/*')) file += '*';
        const local = normalizeBin(file.replace(/^!+/, ''));
        if (paths.has(prefix + local)) {
          rootStrict.unshift('!' + file);
          required.push(file.replace(/^\//, ''));
        } else if (!local || isDirectory(prefix + local))
          includes.push('!' + file, '!' + file + '/**');
        else includes.push('!' + file);
      }
    }
    if (typeof manifest.browser === 'string') rootStrict.push('!/' + manifest.browser);
    if (typeof manifest.main === 'string') rootStrict.push('!/' + manifest.main);
    const bin =
      typeof manifest.bin === 'string'
        ? [manifest.bin]
        : manifest.bin && typeof manifest.bin === 'object'
          ? Object.values(manifest.bin)
          : [];
    for (const value of bin)
      if (typeof value === 'string') rootStrict.push('!/' + normalizeBin(value));
    const binDirectory = object(manifest.directories).bin;
    if (!manifest.bin && typeof binDirectory === 'string') {
      const from = normalizeBin(binDirectory) + '/';
      for (const full of subtree) {
        spend();
        const local = full.slice(prefix.length);
        if (
          full.startsWith(prefix + from) &&
          !local
            .slice(from.length)
            .split('/')
            .some((part) => part.startsWith('.'))
        )
          rootStrict.push('!/' + local);
      }
    }
    const directories = new Map<string, Directory>();
    const ruleSets = new Map<
      string,
      { rules: Rule[]; groups: RuleGroup[]; partialCache: Map<string, Set<Rule>> }
    >();
    function* directory(path: string): Generator<string, Directory, string | undefined> {
      const cached = directories.get(path);
      if (cached) return cached;
      const parts = path ? parentPaths.get(prefix + path)! : { parent: '', base: '' };
      const parent = path ? yield* directory(parts.parent.slice(prefix.length)) : undefined;
      const base = parts.base;
      const exact = parent ? filter(parent, base) || filter(parent, base + '/') : false;
      let localRules: string[] = [];
      if (path === '' && manifest.files !== undefined) localRules = ['*', ...includes];
      else if (
        (!bundled || path !== '') &&
        !path.split('/').includes('node_modules') &&
        (!parent || (canReach(parent) && filter(parent, base, true)))
      ) {
        const ignore =
          (yield* readMetadata(prefix + (path ? path + '/' : '') + '.npmignore')) ??
          (yield* readMetadata(prefix + (path ? path + '/' : '') + '.gitignore'));
        if (ignore !== undefined) localRules = ignore.split(/\r?\n/);
      }
      const handedDown = parent
        ? parent.required
            .filter((p) => {
              const parts = normalizeBin(p).split('/');
              return parts.length === 2 && parts[0] === base;
            })
            .map((p) => normalizeBin(p).split('/').slice(1).join('/'))
        : required;
      const strictRules = path === '' ? rootStrict : ['/.git', ...handedDown.map((p) => '!' + p)];
      const ruleKey = JSON.stringify([bundled && !path, localRules, strictRules]);
      let ruleSet = ruleSets.get(ruleKey);
      if (!ruleSet) {
        ruleSet = {
          rules: [
            ...(bundled && !path ? [] : defaultRules),
            ...rules([...localRules, ...strictRules]),
          ],
          groups: [],
          partialCache: new Map(),
        };
        for (const r of ruleSet.rules) {
          let group = ruleSet.groups.at(-1);
          if (!group || group.basename !== r.basename) {
            group = {
              rules: [],
              basename: r.basename,
              cache: new Map(),
              requiredText: r.requiredText,
              paths: new Map(),
            };
            ruleSet.groups.push(group);
          }
          let length = 0;
          while (
            length < group.requiredText.length &&
            group.requiredText[length] === r.requiredText[length]
          )
            length++;
          group.requiredText = group.requiredText.slice(0, length);
          group.rules.push(r);
        }
        for (const group of ruleSet.groups) {
          const excludes = group.rules.filter((r) => !r.include);
          if (excludes.every((r) => r.requiredText))
            group.excludePrefixes = [...new Set(excludes.map((r) => r.requiredText[0]!))].join('');
        }
        ruleSets.set(ruleKey, ruleSet);
      }
      const node: Directory = {
        path,
        parent,
        base,
        exact,
        required: handedDown,
        ...ruleSet,
      };
      directories.set(path, node);
      return node;
    }
    function filter(
      node: Directory,
      entry: string,
      partial = false,
      entryBasename?: string,
    ): boolean {
      const key = `${entry.length}:${entry}:${partial}:${entryBasename ?? ''}`;
      if (node.cacheKey === key) return node.cacheResult!;
      spend();
      entry = fold(entry);
      if (entryBasename !== undefined) entryBasename = fold(entryBasename);
      let included = true;
      if (node.parent) {
        included = filter(node.parent, node.base + '/' + entry, partial, entryBasename ?? entry);
        if (!included && !node.exact) {
          node.cacheKey = key;
          node.cacheResult = false;
          return false;
        }
      }
      const trimmed = entry.replace(/\/+$/, '');
      const basename = trimmed.slice(trimmed.lastIndexOf('/') + 1);
      const anchored = '/' + entry;
      const trailing = entry + '/';
      const both = anchored + '/';
      const baseAnchored = '/' + entryBasename;
      const baseTrailing = entryBasename + '/';
      const baseBoth = baseAnchored + '/';
      let baseMatches: Set<Rule> | undefined;
      if (partial && entryBasename !== undefined) {
        baseMatches = node.partialCache.get(entryBasename);
        if (!baseMatches) {
          baseMatches = new Set();
          spend(node.rules.length * 256);
          for (const r of node.rules) {
            if (r.basename || !r.relative) continue;
            spend();
            const matched =
              r.match(baseBoth) ||
              r.match(baseTrailing) ||
              (r.include && (r.match(baseAnchored, true) || r.match(entryBasename, true)));
            if (matched) baseMatches.add(r);
          }
          if (node.partialCache.size >= 256) node.partialCache.clear();
          node.partialCache.set(entryBasename, baseMatches);
        }
      }
      for (const group of node.groups) {
        if (group.basename) {
          const match = (name: string): number => {
            const cache = group.cache;
            const cached = cache.get(name);
            if (cached !== undefined) return cached;
            spend(name.length + group.requiredText.length);
            if (group.requiredText && !name.includes(group.requiredText)) return -1;
            let last = -1;
            for (let i = 0; i < group.rules.length; i++) {
              const r = group.rules[i]!;
              spend(64);
              if (r.match(name)) last = i;
            }
            if (cache.size >= 256) cache.clear();
            cache.set(name, last);
            return last;
          };
          let last = match(basename);
          if (partial && entryBasename !== undefined) {
            const trimmed = entryBasename.replace(/\/+$/, '');
            last = Math.max(last, match(trimmed.slice(trimmed.lastIndexOf('/') + 1)));
          }
          if (last >= 0) included = group.rules[last]!.include;
          continue;
        }
        if (included && group.excludePrefixes !== undefined) {
          const possible = (value: string) => {
            spend(value.length);
            for (let i = 0; i < value.length; i++)
              if (group.excludePrefixes!.includes(value[i]!)) return true;
            return false;
          };
          if (
            !possible(entry) &&
            !(partial && entryBasename !== undefined && possible(entryBasename))
          )
            continue;
        }
        const pathKey = included + ':' + key;
        const old = group.paths.get(pathKey);
        if (old !== undefined) {
          included = old;
          continue;
        }
        if (partial) spend(group.rules.length * 256);
        for (const r of group.rules) {
          if (r.include === included) continue;
          spend();
          const matched =
            r.match(anchored) ||
            r.match(entry) ||
            (partial &&
              (r.match(both) ||
                r.match(trailing) ||
                (r.include && (r.match(anchored, true) || r.match(entry, true))) ||
                baseMatches?.has(r)));
          if (matched) included = r.include;
        }
        if (group.paths.size >= 256) group.paths.clear();
        group.paths.set(pathKey, included);
      }
      node.cacheKey = key;
      node.cacheResult = included;
      return included;
    }
    function canReach(node: Directory): boolean {
      if (!node.path) return true;
      if (node.reachable !== undefined) return node.reachable;
      return (node.reachable = canReach(node.parent!) && filter(node.parent!, node.base, true));
    }
    for (const full of subtree) {
      spend();
      const path = full.slice(prefix.length);
      if (path.split('/').some((part) => part.includes('*'))) continue;
      const index = path.lastIndexOf('/');
      if (directories.size >= 4096) directories.clear();
      const node = yield* directory(index < 0 ? '' : path.slice(0, index));
      if (canReach(node) && filter(node, path.slice(index + 1))) output.add(full);
    }
  }
  const pending = [{ prefix: '', manifest: rootManifest, root: true }];
  const bundledPackages: { prefix: string; manifest: Record<string, unknown> }[] = [];
  while (pending.length) {
    const { prefix, manifest, root } = pending.pop()!;
    const dependencies = {
      ...object(manifest.dependencies),
      ...object(manifest.optionalDependencies),
    };
    const declared = manifest.bundleDependencies ?? manifest.bundledDependencies;
    const names = root
      ? declared === true
        ? Object.keys(object(manifest.dependencies))
        : Array.isArray(declared)
          ? stringList(declared)
          : declared && typeof declared === 'object'
            ? Object.keys(declared)
            : []
      : Object.keys(dependencies);
    for (const name of names) {
      if (
        !Object.hasOwn(dependencies, name) ||
        (root && Object.hasOwn(object(manifest.devDependencies), name))
      )
        continue;
      let from = prefix,
        candidate: string | undefined;
      for (;;) {
        const next = from + 'node_modules/' + name + '/';
        if (metadata.has(next + 'package.json')) {
          candidate = next;
          break;
        }
        if (!from) break;
        const at = from.slice(0, -1).lastIndexOf('/node_modules/');
        from = at < 0 ? '' : from.slice(0, at + 1);
      }
      if (!candidate || seenBundles.has(candidate)) continue;
      if (seenBundles.size >= 500) fail('packlist_budget');
      seenBundles.add(candidate);
      const dependency = parsePackManifest((yield* readMetadata(candidate + 'package.json'))!);
      bundledPackages.push({ prefix: candidate, manifest: dependency });
      pending.push({ prefix: candidate, manifest: dependency, root: false });
    }
  }
  yield* gather('', rootManifest, false);
  for (const { prefix, manifest } of bundledPackages) yield* gather(prefix, manifest, true);
  return [...output].sort();
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeBin(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}
