// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 5: matching lines, and the file model of section 3.
// ---------------------------------------------------------------------------

/** A file's text as lines: its line break, whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function readState(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function writeState(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

function leadWs(s: string): string {
  let e = 0;
  while (e < s.length && (s[e] === ' ' || s[e] === '\t')) e += 1;
  return s.slice(0, e);
}

function trimEndWs(s: string): string {
  let e = s.length;
  while (e > 0 && (s[e - 1] === ' ' || s[e - 1] === '\t')) e -= 1;
  return s.slice(0, e);
}

function trimWs(s: string): string {
  let b = 0;
  while (b < s.length && (s[b] === ' ' || s[b] === '\t')) b += 1;
  let e = s.length;
  while (e > b && (s[e - 1] === ' ' || s[e - 1] === '\t')) e -= 1;
  return s.slice(b, e);
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Positions at or after `from` where `o` matches, at one tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `o` occurs at or after `from`, with its positions, or null. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of the replacement: a context line (the file's own line at its O index) or a new line. */
interface NEntry {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** A new line of N at tier 2: re-indented from the patch's indent P to the file's indent F. */
function reindent(text: string, f: string, p: string): string {
  if (text === '' || /^[ \t]*$/.test(text)) return text;
  if (text.startsWith(p)) return f + text.slice(p.length);
  return text;
}

/** Replace the matched span at `pos` by N: context lines come from the file, the rest are new. */
function applyMatch(lines: string[], pos: number, o: string[], n: NEntry[], tier: number): string[] {
  const out = lines.slice(0, pos);
  const f = tier === 2 ? leadWs(lines[pos]!) : '';
  const p = tier === 2 ? leadWs(o[0]!) : '';
  for (const e of n) {
    if (e.ctx) out.push(lines[pos + e.oIdx]!);
    else if (tier === 2) out.push(reindent(e.text, f, p));
    else out.push(e.text);
  }
  out.push(...lines.slice(pos + o.length));
  return out;
}

// ---------------------------------------------------------------------------
// Body lines shared by unified hunks and V4A chunks.
// ---------------------------------------------------------------------------

type BodyKind = 'ctx' | 'old' | 'new' | 'backslash';

interface BodyLine {
  kind: BodyKind;
  text: string;
  raw: string;
}

/** Split a hunk/chunk body into O (context + old lines) and N (context + new lines). */
function buildON(body: BodyLine[]): { o: string[]; n: NEntry[] } {
  const o: string[] = [];
  const n: NEntry[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, ctx: true, oIdx: o.length - 1 });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the body's last context or `+` line. */
function backslashAfterLast(body: BodyLine[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k += 1) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') last = k;
  }
  return last >= 0 && last + 1 < body.length && body[last + 1]!.kind === 'backslash';
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: BodyLine[];
  o: string[];
  n: NEntry[];
  backslashAfter: boolean;
}

interface UnifiedSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renOld: string | null | undefined;
  renNew: string | null | undefined;
  difOld: string | null | undefined;
  difNew: string | null | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The text after `--- ` or `+++ `, up to the first tab, with surrounding spaces removed. */
function headerPath(line: string): string {
  const t = line.slice(4);
  const tab = t.indexOf('\t');
  return (tab < 0 ? t : t.slice(0, tab)).trim();
}

/** A path as a header names it: `/dev/null` means no file, a leading `a/` or `b/` is removed. */
function namedPath(raw: string): string | null {
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function effOld(s: UnifiedSection): string | null {
  if (s.pairOld !== undefined) return s.pairOld;
  if (s.renOld !== undefined) return s.renOld;
  if (s.difOld !== undefined) return s.difOld;
  return null;
}

function effNew(s: UnifiedSection): string | null {
  if (s.pairNew !== undefined) return s.pairNew;
  if (s.renNew !== undefined) return s.renNew;
  if (s.difNew !== undefined) return s.difNew;
  return null;
}

/** The body after a hunk header: lines starting with ` `, `-`, `+`, `\`, or empty. */
function parseUnifiedBody(lines: string[], start: number): { body: BodyLine[]; next: number } {
  const body: BodyLine[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line === '') {
      body.push({ kind: 'ctx', text: '', raw: '' });
      i += 1;
      continue;
    }
    const c = line[0]!;
    if (c === ' ' || c === '-' || c === '+' || c === '\\') {
      body.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'old' : c === '+' ? 'new' : 'backslash', text: line.slice(1), raw: line });
      i += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
  return { body, next: i };
}

function unifiedEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let header = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const parsed = parseUnifiedBody(lines, i + 1);
      const built = buildON(parsed.body);
      cur.hunks.push({ a: Number(m[1]), body: parsed.body, o: built.o, n: built.n, backslashAfter: backslashAfterLast(parsed.body) });
      header = false;
      i = parsed.next;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        pairOld: undefined,
        pairNew: undefined,
        renOld: undefined,
        renNew: undefined,
        difOld: m[1] === '/dev/null' ? null : m[1]!,
        difNew: m[2] === '/dev/null' ? null : m[2]!,
        newFile: false,
        deletedFile: false,
        hunks: [],
      };
      sections.push(cur);
      header = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && header) {
        cur.pairOld = namedPath(headerPath(line));
        cur.pairNew = namedPath(headerPath(lines[i + 1]!));
      } else {
        cur = {
          pairOld: namedPath(headerPath(line)),
          pairNew: namedPath(headerPath(lines[i + 1]!)),
          renOld: undefined,
          renNew: undefined,
          difOld: undefined,
          difNew: undefined,
          newFile: false,
          deletedFile: false,
          hunks: [],
        };
        sections.push(cur);
        header = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && header) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.pairNew = namedPath(headerPath(line));
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renOld = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renNew = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.deletedFile = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedEdit(sec, strict, moves));
}

function applyHunk(st: FileState, h: Hunk, strict: boolean, d: number, path: string): FileState {
  if (h.o.length === 0) {
    const at = Math.min(h.a + d, st.lines.length);
    const ins = h.n.map((e) => e.text);
    const out = [...st.lines.slice(0, at), ...ins, ...st.lines.slice(at)];
    let final = st.final;
    if (at === st.lines.length) final = !h.backslashAfter;
    return { lines: out, br: st.br, final };
  }
  const found = findTier(st.lines, h.o, strict, 0);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.pos[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.pos) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const out = applyMatch(st.lines, best, h.o, h.n, found.tier);
  let final = st.final;
  if (best + h.o.length === st.lines.length) final = !h.backslashAfter;
  return { lines: out, br: st.br, final };
}

function applyHunks(st: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let d = 0;
  let cur = st;
  for (const h of hunks) {
    cur = applyHunk(cur, h, strict, d, path);
    d += h.n.length - h.o.length;
  }
  return cur;
}

function unifiedEdit(sec: UnifiedSection, strict: boolean, moves: [string, string][]): Edit {
  const oldP = effOld(sec);
  const newP = effNew(sec);
  const isCreate = oldP === null || sec.newFile;
  const isDelete = !isCreate && (newP === null || sec.deletedFile);
  return (tree) => {
    if (isCreate) {
      if (newP === null) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastPlusBackslash = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k += 1) {
          if (h.body[k]!.kind === 'new') {
            plus.push(h.body[k]!.text);
            lastPlusBackslash = k + 1 < h.body.length && h.body[k + 1]!.kind === 'backslash';
          }
        }
      }
      tree.now.set(newP, writeState({ lines: plus, br: '\n', final: !lastPlusBackslash }));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== newP) {
      const o = oldP!;
      const nw = newP!;
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(nw)) throw new Fail('unsafe', nw);
      const cur = tree.get(o);
      if (cur === null) throw new Fail('missing', o);
      if (tree.get(nw) !== null) throw new Fail('exists', nw);
      const st = applyHunks(readState(cur), sec.hunks, strict, o);
      tree.now.set(o, null);
      tree.now.set(nw, writeState(st));
      moves.push([o, nw]);
      return;
    }
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const st = applyHunks(readState(cur), sec.hunks, strict, p);
    tree.now.set(p, writeState(st));
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SrBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : `${b.newLines.join('\n')}\n`);
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const st = readState(cur);
    const found = findTier(st.lines, b.oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
    const n: NEntry[] = b.newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const out = applyMatch(st.lines, found.pos[0]!, b.oldLines, n, found.tier);
    tree.now.set(b.path, writeState({ lines: out, br: st.br, final: st.final }));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  o: string[];
  n: NEntry[];
  eof: boolean;
}

type VSection =
  | { kind: 'add'; path: string; fileLines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: VChunk[]; updateLine: number };

function isV4aSectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

function isV4aBodyLine(t: string): boolean {
  return t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+';
}

function v4aBodyLine(t: string): BodyLine {
  if (t === '' || t[0] === ' ') return { kind: 'ctx', text: t === '' ? '' : t.slice(1), raw: t };
  if (t[0] === '-') return { kind: 'old', text: t.slice(1), raw: t };
  return { kind: 'new', text: t.slice(1), raw: t };
}

function v4aEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const start = i + 1;
    let j = start;
    while (j < last && !isV4aSectionStart(lines[j]!)) j += 1;
    const secLines: { text: string; num: number }[] = [];
    for (let k = start; k < j; k += 1) secLines.push({ text: lines[k]!, num: k + 1 });
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const s of secLines) {
        if (s.text.startsWith('+')) fileLines.push(s.text.slice(1));
        else if (s.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${s.num}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      if (secLines.length > 0) throw new Exit2(`error: parse ${secLines[0]!.num}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      edits.push(v4aUpdateEdit(path, secLines, i + 1, strict, moves));
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, secLines: { text: string; num: number }[], updateLine: number, strict: boolean, moves: [string, string][]): Edit {
  let idx = 0;
  let moveTo: string | null = null;
  if (secLines.length > 0 && secLines[0]!.text.startsWith('*** Move to: ')) {
    moveTo = secLines[0]!.text.slice(13).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  while (idx < secLines.length) {
    const cur = secLines[idx]!;
    let anchor: string | null = null;
    if (cur.text.startsWith('@@')) {
      const t = cur.text.slice(2).trim();
      anchor = t === '' ? null : t;
      idx += 1;
    } else if (chunks.length === 0 && isV4aBodyLine(cur.text)) {
      anchor = null;
    } else {
      throw new Exit2(`error: parse ${cur.num}`);
    }
    const body: BodyLine[] = [];
    let eof = false;
    while (idx < secLines.length) {
      const l = secLines[idx]!;
      if (l.text === '*** End of File') {
        eof = true;
        idx += 1;
        break;
      }
      if (l.text.startsWith('@@')) break;
      if (!isV4aBodyLine(l.text)) throw new Exit2(`error: parse ${l.num}`);
      body.push(v4aBodyLine(l.text));
      idx += 1;
    }
    const built = buildON(body);
    chunks.push({ anchor, o: built.o, n: built.n, eof });
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    let st = readState(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(st.lines, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? st.lines.length : cursor;
        const ins = ch.n.map((e) => e.text);
        st = { lines: [...st.lines.slice(0, at), ...ins, ...st.lines.slice(at)], br: st.br, final: st.final };
        cursor = at + ins.length;
      } else {
        const found = findTier(st.lines, ch.o, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let pos: number | null = null;
        for (const p of found.pos) {
          if (!ch.eof || p + ch.o.length === st.lines.length) {
            pos = p;
            break;
          }
        }
        if (pos === null) throw new Fail('no-match', path);
        const out = applyMatch(st.lines, pos, ch.o, ch.n, found.tier);
        st = { lines: out, br: st.br, final: st.final };
        cursor = pos + ch.n.length;
      }
    }
    const out = writeState(st);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: [string, string][] = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, moves)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rByNew = new Map<string, string>();
  for (const [o, nw] of moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(nw) === null && tree.get(nw) !== null) rByNew.set(nw, o);
  }
  const oldOfR = new Set<string>([...rByNew.values()]);
  const rows: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rByNew.has(p)) {
      rows.push({ key: p, text: `R ${rByNew.get(p)} -> ${p}` });
      continue;
    }
    if (oldOfR.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
