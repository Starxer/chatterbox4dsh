/**
 * The programs a shell command runs, in order — what a `bash` row on the compact
 * turn card names ("what did this call actually do").
 *
 * A model-written `bash` command is usually a small SCRIPT, not a one-liner. The
 * real calls this was written against (2026-10-12, read back out of a session
 * log rather than imagined) contained:
 *
 * - heredocs — `cat > out/prompt.txt <<'EOF' … EOF` — whose PROSE was read as a
 *   command list (`cat / For / integrated_multimodal_description:`);
 * - multi-line quoted Python — `python3 -c "… import sys …"` — which produced
 *   `import` as a "program";
 * - quoted alternations — `grep -n "first.frame\|first_frame" x.py` — where the
 *   `\|` inside the quotes was mistaken for a pipe, leaving `first_frame"` (quote
 *   and all) as a program name;
 * - `for … do … done` loops, `#` comments, emoji headings and dates.
 *
 * Half of those 12 commands came out wrong. So this PARSES instead of splitting:
 * quotes, comments and heredoc bodies are skipped, separators only count outside
 * them, a `\`-continuation keeps its line, and a candidate must LOOK like a bare
 * program name before it is reported. Anything unreadable is dropped — a row
 * that names the wrong program is worse than a row that names none.
 *
 * Deliberately NOT a shell: no substitutions (`$(…)`, backticks), no `&&`-aware
 * control flow, no alias or PATH resolution. Names are basenames
 * (`/usr/bin/python3` → `python3`), which is what a card row can carry.
 *
 * @module @starxer/chatterbox4dsh/shell-programs
 */

/**
 * Distinct programs one row may name.
 *
 * A run of same-named calls is one row, and the row can only carry so much: the
 * first few are what tells the run apart ("it ran npm, then node, then git")
 * without turning the row into a command line.
 */
export const SHELL_PROGRAMS_LIMIT = 3

/** Words that begin a shell construct rather than a program. */
const SHELL_HEADS: ReadonlySet<string> = new Set([
  'for', 'while', 'until', 'if', 'case', 'in', 'done', 'fi', 'esac', '}', '((',
])

/**
 * Words that PREFIX a command on the same segment: skip the word, the program is
 * right behind it (`do curl …`, `then npm test`, `{ echo ok`).
 */
const SHELL_PREFIXES: ReadonlySet<string> = new Set(['do', 'then', 'else', 'elif', '{'])

/** Control-flow builtins: they run nothing a row should name. */
const SHELL_BUILTINS: ReadonlySet<string> = new Set(['break', 'continue', 'return', 'exit'])

/** Wrappers: what follows one of these is the program, not the wrapper itself. */
const SHELL_WRAPPERS: ReadonlySet<string> = new Set([
  'sudo', 'time', 'nohup', 'env', 'command', 'exec', 'builtin', 'nice', 'xargs', 'cd', 'timeout',
])

/** A bare program name: no quotes, redirects, substitutions or punctuation. */
const PROGRAM_NAME = /^[A-Za-z_][A-Za-z0-9_.+-]*$/u

/** An env assignment (`FOO=1`), which precedes the program instead of being it. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u

/** A heredoc opener at the end of a segment: `<<EOF`, `<<'EOF'`, `<<-"EOF"`. */
const HEREDOC_OPENER = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*$/u

/**
 * Split a command into the segments the shell would run, ignoring separators
 * that sit inside quotes, comments or a heredoc body.
 *
 * `\`-continuations are kept (a folded command is ONE segment, so the program is
 * still the first word of it, not the flag on the next line). A `#` starts a
 * comment only at the start of a segment or after whitespace.
 *
 * @param command - the raw command string.
 * @returns the non-empty segments, in order.
 */
export function splitShellSegments(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let heredoc: string | undefined
  let index = 0
  const push = (): void => {
    const segment = current.trim()
    if (segment !== '') out.push(segment)
    current = ''
  }
  while (index < command.length) {
    const char = command[index]!
    if (heredoc !== undefined) {
      // The body is DATA: skip whole lines until the terminator stands alone.
      const newline = command.indexOf('\n', index)
      const line = (newline === -1 ? command.slice(index) : command.slice(index, newline)).trim()
      if (line === heredoc) heredoc = undefined
      index = newline === -1 ? command.length : newline + 1
      continue
    }
    if (quote !== undefined) {
      current += char
      // `\` escapes the next char, including a quote, and a newline inside the
      // quotes is ordinary text (a multi-line `python3 -c "…"` stays one segment).
      if (char === '\\') {
        current += command[index + 1] ?? ''
        index += 2
        continue
      }
      if (char === quote) quote = undefined
      index += 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      index += 1
      continue
    }
    if (char === '\\') {
      current += char + (command[index + 1] ?? '')
      index += 2
      continue
    }
    if (char === '#' && (current === '' || /\s$/u.test(current))) {
      const newline = command.indexOf('\n', index)
      index = newline === -1 ? command.length : newline + 1
      push()
      continue
    }
    if (char === '\n' || char === ';' || char === '|' || char === '&') {
      // A heredoc opener ENDS a segment and swallows what follows it.
      const opener = char === '\n' ? HEREDOC_OPENER.exec(current) : null
      push()
      if (opener !== null) heredoc = opener[2]
      index += 1
      continue
    }
    current += char
    index += 1
  }
  push()
  return out
}

/**
 * The programs a command runs, in order, at most `limit` distinct ones.
 *
 * @param command - the raw command string from a `bash` call's arguments.
 * @param limit - how many distinct programs to keep.
 * @returns the program names, possibly empty.
 */
export function shellPrograms(command: string, limit = SHELL_PROGRAMS_LIMIT): string[] {
  const programs: string[] = []
  for (const segment of splitShellSegments(command)) {
    const tokens = segment.split(/\s+/u).filter(token => token !== '')
    const first = tokens[0]
    // `for i in …` / `do` / `done` / an `if` head run no program, and `cd` only
    // names a directory — its ARGUMENT must not be read as one (`cd /w && git
    // status` is a `git` row, not a `w` row).
    if (first === undefined || first === 'cd' || SHELL_HEADS.has(first)) continue
    let at = 0
    while (at < tokens.length) {
      const token = tokens[at]!
      if (ENV_ASSIGNMENT.test(token) || token.startsWith('-') || /^\d+$/u.test(token)
        || SHELL_WRAPPERS.has(token) || SHELL_PREFIXES.has(token) || SHELL_BUILTINS.has(token)) {
        at += 1
        continue
      }
      break
    }
    const token = tokens[at]
    if (token === undefined) continue
    const name = token.split(/[\\/]/u).pop() ?? token
    if (!PROGRAM_NAME.test(name) || name === '') continue
    if (!programs.includes(name)) programs.push(name)
    if (programs.length >= limit) break
  }
  return programs
}
