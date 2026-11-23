// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A,
// JSON edits), finds the lines each edit names at the first of three matching tiers,
// and writes every change or none, printing what it changed or why it failed.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are, and write the CLI.

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

/** A file split into lines: its own line break, and whether it ends with one. */
interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    lines.pop();
    final = true;
  }
  return { lines, br, final };
}

function writeDoc(d: Doc): string {
  return d.lines.length === 0 ? '' : d.lines.join(d.br) + (d.final ? d.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const normLine = (s: string, tier: number): string => (tier === 0 ? s : tier === 1 ? trimEndWs(s) : trimBothWs(s));

/** Positions where O occurs in lines at one tier (occurrences may overlap). */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  occ: number[];
}

/** First tier (0, 1, 2; strict: 0 only) at which O occurs at least once at or after `from`. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0, onlyEndingAtEnd = false): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t).filter((p) => p >= from && (!onlyEndingAtEnd || p + o.length === lines.length));
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (index into O) or a fresh line (ctx -1). */
interface NLine {
  text: string;
  ctx: number;
}

/**
 * The replacement lines for a match at pos: context lines are the file's own matched
 * lines; at tier 2 every other line is re-indented from O's first line to the file's.
 */
function buildNew(fileLines: string[], o: string[], n: NLine[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const f = pos < fileLines.length ? leadWs(fileLines[pos]!) : '';
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  for (const e of n) {
    if (e.ctx >= 0) {
      out.push(fileLines[pos + e.ctx]!);
    } else {
      const t = e.text;
      if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    }
  }
  return out;
}

type Edit = (tree: Tree) => void;

/** Moves recorded by edits that succeeded, for the exit-0 `R` lines. */
const moves: { old: string; next: string }[] = [];

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

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

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
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

interface UHunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  // `---`/`+++` pair paths (null: /dev/null), rename paths, `diff --git` paths.
  minus: string | null;
  hasMinus: boolean;
  plus: string | null;
  hasPlus: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UHunk[];
}

/** The path a `---`/`+++` line names (null: /dev/null). */
function parseUnifiedPath(line: string): string | null {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const raw = (tab < 0 ? rest : rest.slice(0, tab)).trim();
  if (raw === '/dev/null') return null;
  return raw.replace(/^[ab]\//, '');
}

function parseUnified(lines: string[]): Edit[] {
  const sections: USection[] = [];
  let i = 0;
  const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  while (i < lines.length) {
    const line = lines[i]!;
    let sec: USection | null = null;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { minus: null, hasMinus: false, plus: null, hasPlus: false, renameFrom: null, renameTo: null, diffOld: m[1]!, diffNew: m[2]!, isCreate: false, isDelete: false, hunks: [] };
      i += 1;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { minus: null, hasMinus: false, plus: null, hasPlus: false, renameFrom: null, renameTo: null, diffOld: null, diffNew: null, isCreate: false, isDelete: false, hunks: [] };
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
      continue;
    }
    // Section header: before its first hunk.
    while (i < lines.length) {
      const h = lines[i]!;
      if (h.startsWith('@@')) break;
      if (h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          sec.minus = parseUnifiedPath(h);
          sec.plus = parseUnifiedPath(lines[i + 1]!);
          sec.hasMinus = true;
          sec.hasPlus = true;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (h.startsWith('rename from ')) {
        sec.renameFrom = h.slice('rename from '.length).trim();
      } else if (h.startsWith('rename to ')) {
        sec.renameTo = h.slice('rename to '.length).trim();
      } else if (h.startsWith('new file mode')) {
        sec.isCreate = true;
      } else if (h.startsWith('deleted file mode')) {
        sec.isDelete = true;
      }
      i += 1;
    }
    // Hunks.
    while (i < lines.length && lines[i]!.startsWith('@@')) {
      const m = hunkHeader.exec(lines[i]!);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UHunk = { a: parseInt(m[1]!, 10), body: [] };
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith('@@')) break;
        if (b === '') hunk.body.push({ kind: 'ctx', text: '' });
        else if (b[0] === ' ') hunk.body.push({ kind: 'ctx', text: b.slice(1) });
        else if (b[0] === '-') hunk.body.push({ kind: 'old', text: b.slice(1) });
        else if (b[0] === '+') hunk.body.push({ kind: 'new', text: b.slice(1) });
        else if (b[0] === '\\') hunk.body.push({ kind: 'bs', text: b });
        else break;
        i += 1;
      }
      // Empty lines at the end of a body are not part of it: trailing body entries
      // whose patch line was empty are dropped (a ` ` line is a context line and stays).
      let end = hunk.body.length;
      while (end > 0) {
        const idx = i - (hunk.body.length - end) - 1;
        if (idx >= 0 && lines[idx] === '') end -= 1;
        else break;
      }
      hunk.body.length = end;
      sec.hunks.push(hunk);
    }
    sections.push(sec);
  }
  return sections.map((sec) => unifiedEdit(sec));
}

/** Does a `\` line follow the hunk's last context or `+` line? */
function hunkNoEol(hunk: UHunk): boolean {
  for (let k = hunk.body.length - 1; k >= 0; k--) {
    const b = hunk.body[k]!;
    if (b.kind === 'ctx' || b.kind === 'new') {
      return hunk.body[k + 1] !== undefined && hunk.body[k + 1]!.kind === 'bs';
    }
  }
  return false;
}

/** Does a `\` line follow the very last `+` line of a creation's hunks? */
function creationNoEol(hunks: UHunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const body = hunks[h]!.body;
    for (let k = body.length - 1; k >= 0; k--) {
      if (body[k]!.kind === 'new') return body[k + 1] !== undefined && body[k + 1]!.kind === 'bs';
    }
  }
  return false;
}

function hunkOldNew(hunk: UHunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of hunk.body) {
    if (b.kind === 'ctx') {
      n.push({ text: b.text, ctx: o.length });
      o.push(b.text);
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: -1 });
    }
  }
  return { o, n };
}

function unifiedEdit(sec: USection): Edit {
  return (tree) => {
    // Effective paths: the `---`/`+++` pair names them, else `rename from`/`to`,
    // else the `diff --git` paths.
    const oldP = sec.hasMinus ? sec.minus : (sec.renameFrom ?? sec.diffOld);
    const newP = sec.hasPlus ? sec.plus : (sec.renameTo ?? sec.diffNew);
    const isCreate = oldP === null || sec.isCreate;
    const isDelete = !isCreate && (newP === null || sec.isDelete);
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
    if (isCreate) {
      const target = newP!;
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const made: string[] = [];
      for (const hunk of sec.hunks) {
        for (const b of hunk.body) {
          if (b.kind === 'new') made.push(b.text);
        }
      }
      const noEol = creationNoEol(sec.hunks);
      tree.now.set(target, made.length === 0 ? '' : made.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const target = oldP!;
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const src = oldP!;
    if (!safe(src)) throw new Fail('unsafe', src);
    if (isMove) {
      if (!safe(newP!)) throw new Fail('unsafe', newP!);
    }
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    let doc = parseDoc(before);
    let d = 0;
    for (const hunk of sec.hunks) {
      const { o, n } = hunkOldNew(hunk);
      if (o.length === 0) {
        const at = Math.max(0, Math.min(hunk.a + d, doc.lines.length));
        const wasAtEnd = at === doc.lines.length;
        const texts = n.map((e) => e.text);
        doc.lines = [...doc.lines.slice(0, at), ...texts, ...doc.lines.slice(at)];
        // Inserted at the end: the result ends with a break unless a `\` line
        // follows the hunk's last context or `+` line.
        if (wasAtEnd && texts.length > 0) doc.final = !hunkNoEol(hunk);
        d += n.length;
        continue;
      }
      const found = findTier(doc.lines, o, strictFlag);
      if (found === null) throw new Fail('no-match', src);
      const want = hunk.a - 1 + d;
      let pos = found.occ[0]!;
      let best = Math.abs(pos - want);
      for (const p of found.occ) {
        const dist = Math.abs(p - want);
        if (dist < best) {
          best = dist;
          pos = p;
        }
      }
      const atEnd = pos + o.length === doc.lines.length;
      const built = buildNew(doc.lines, o, n, pos, found.tier);
      doc.lines = [...doc.lines.slice(0, pos), ...built, ...doc.lines.slice(pos + o.length)];
      if (atEnd) doc.final = !hunkNoEol(hunk);
      d += n.length - o.length;
    }
    const out = writeDoc(doc);
    if (isMove) {
      tree.now.set(newP!, out);
      tree.now.set(src, null);
      moves.push({ old: src, next: newP! });
    } else {
      tree.now.set(src, out);
    }
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let sep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, sep);
    const newLines = lines.slice(sep + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const doc = parseDoc(before);
    const found = findTier(doc.lines, oldLines, strictFlag);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const n: NLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    const built = buildNew(doc.lines, oldLines, n, pos, found.tier);
    doc.lines = [...doc.lines.slice(0, pos), ...built, ...doc.lines.slice(pos + oldLines.length)];
    tree.now.set(path, writeDoc(doc));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      // Section lines run to the next section start or End Patch.
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) j += 1;
      const raw = lines.slice(i + 1, j);
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const made: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const r = raw[k]!;
        if (r.startsWith('+')) made.push(r.slice(1));
        else if (blank(r)) made.push('');
        else throw new Exit2(`error: parse ${i + 1 + k + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, made.length === 0 ? '' : made.join('\n') + '\n');
      });
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i = j;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) j += 1;
      const raw = lines.slice(i + 1, j);
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (; k < raw.length; k++) {
        const r = raw[k]!;
        if (r.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: r.slice(2).trim(), eof: false, body: [] };
        } else if (r === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1 + k + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
        } else if (r === '' || r[0] === ' ' || r[0] === '-' || r[0] === '+') {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          if (r === '') cur.body.push({ kind: 'ctx', text: '' });
          else if (r[0] === ' ') cur.body.push({ kind: 'ctx', text: r.slice(1) });
          else if (r[0] === '-') cur.body.push({ kind: 'old', text: r.slice(1) });
          else cur.body.push({ kind: 'new', text: r.slice(1) });
        } else {
          throw new Exit2(`error: parse ${i + 1 + k + 1}`);
        }
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[]): Edit {
  return (tree) => {
    // Every path the edit names is checked for safety before anything else.
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = parseDoc(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        const foundAnchor = findTier(doc.lines, [chunk.anchor], strictFlag, cursor);
        if (foundAnchor === null) throw new Fail('no-match', path);
        cursor = foundAnchor.occ[0]! + 1;
      }
      const o: string[] = [];
      const n: NLine[] = [];
      for (const b of chunk.body) {
        if (b.kind === 'ctx') {
          n.push({ text: b.text, ctx: o.length });
          o.push(b.text);
        } else if (b.kind === 'old') {
          o.push(b.text);
        } else if (b.kind === 'new') {
          n.push({ text: b.text, ctx: -1 });
        }
      }
      if (o.length === 0) {
        const at = chunk.eof ? doc.lines.length : cursor;
        const texts = n.map((e) => e.text);
        doc.lines = [...doc.lines.slice(0, at), ...texts, ...doc.lines.slice(at)];
        cursor = at + texts.length;
        continue;
      }
      const found = findTier(doc.lines, o, strictFlag, cursor, chunk.eof);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.occ[0]!;
      const built = buildNew(doc.lines, o, n, pos, found.tier);
      doc.lines = [...doc.lines.slice(0, pos), ...built, ...doc.lines.slice(pos + o.length)];
      cursor = pos + built.length;
    }
    const out = writeDoc(doc);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      moves.push({ old: path, next: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Driver (SPEC.md sections 1, 2, 10)
// ---------------------------------------------------------------------------

let strictFlag = false;

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
  strictFlag = strict;
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
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else edits = v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const m of moves) {
    const wasOld = tree.original(m.old);
    const wasNew = tree.original(m.next);
    const nowOld = tree.get(m.old);
    const nowNew = tree.get(m.next);
    if (wasOld !== null && wasNew === null && nowOld === null && nowNew !== null) {
      rows.push({ key: m.next, line: `R ${m.old} -> ${m.next}` });
      consumed.add(m.old);
      consumed.add(m.next);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (tree.original(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
