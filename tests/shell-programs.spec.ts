import { describe, expect, it } from 'vitest'
import { SHELL_PROGRAMS_LIMIT, shellPrograms, splitShellSegments } from '../src/shell-programs.ts'

/**
 * The `bash` row on the compact turn card names the programs a command ran.
 *
 * The first version split on `| ; &&` and took the first word, which was wrong
 * for HALF the real commands this was written against (2026-10-12: 12 commands
 * read back out of a session log, 6 wrong). The cases below are those commands,
 * verbatim, so the regression is pinned to real input rather than to invented
 * one-liners.
 */
describe('shellPrograms', () => {
  it('reads a simple one-liner', () => {
    expect(shellPrograms('npm run typecheck 2>&1 | tail -5')).toEqual(['npm', 'tail'])
    expect(shellPrograms('ls | wc -l && echo done')).toEqual(['ls', 'wc', 'echo'])
  })

  it('drops wrappers, env assignments and a wrapper argument', () => {
    expect(shellPrograms('sudo FOO=1 timeout 5 npm test')).toEqual(['npm'])
    expect(shellPrograms('nohup ./run.sh > out.log 2>&1 &')).toEqual(['run.sh'])
  })

  it('basenames a program and dedupes it', () => {
    expect(shellPrograms('/usr/bin/python3 x.py && python3 y.py')).toEqual(['python3'])
  })

  it('keeps a `\\`-continued command as one segment, so the flag is not a program', () => {
    expect(shellPrograms('python3 run.py --seed 1 \\\n  --first-frame "$FF" --out x')).toEqual(['python3'])
  })

  it('skips a directory, flags, substitutions and non-program words', () => {
    expect(shellPrograms('cd /w && git status --short')).toEqual(['git'])
    expect(shellPrograms('-x; ls')).toEqual(['ls'])
    expect(shellPrograms('echo $(whoami)')).toEqual(['echo'])
  })

  it('caps the row at the limit', () => {
    expect(shellPrograms('a; b; c; d; e')).toEqual(['a', 'b', 'c'])
    expect(SHELL_PROGRAMS_LIMIT).toBe(3)
  })

  // ---- the real commands this was fixed against ----

  it('does not read a quoted `\\|` alternation as a pipe', () => {
    // Was `echo / grep / first_frame"` — the card the user photographed.
    const command = [
      'cd ~/workspace/example; echo "=== 1) does the ero model support --first-frame ==="',
      'grep -n "first.frame\\|first_frame" scripts/h3_eros_run.py | head -6',
      'echo',
      'echo "=== 2) presets and first-frame compatibility ==="',
      'grep -n "draft-fast\\|draft_fast" scripts/h3_ab_run.py | head -8',
      'head -8 output/prompts/three.txt',
    ].join('\n')
    expect(shellPrograms(command)).toEqual(['echo', 'grep', 'head'])
  })

  it('does not read a heredoc body as commands', () => {
    // Was `cat / For / integrated_multimodal_description:`.
    const command = [
      'cd ~/workspace/example',
      "cat > output/prompts/clip.txt <<'EOF'",
      'For the target video, at 0.00 seconds into the target video, <Picture 1> is referenced.',
      '',
      'integrated_multimodal_description: [Shot 1] Live-action, photographic.',
      'subject_definitions:',
      '<Subject 1> is the young woman in <Picture 1>.',
      'EOF',
      'python3 scripts/run.py --prompt-file output/prompts/clip.txt',
    ].join('\n')
    expect(shellPrograms(command)).toEqual(['cat', 'python3'])
  })

  it('does not read a multi-line quoted program as commands', () => {
    // Was `echo / python3 / import`.
    const command = [
      'cd ~/workspace/example',
      'echo "=== sizing ==="',
      'python3 -c "',
      "import sys; sys.path.insert(0,'scripts')",
      'import runner as r',
      "print('SIZES:', getattr(r,'SIZES',None))",
      '" 2>&1 | head -6',
    ].join('\n')
    expect(shellPrograms(command)).toEqual(['echo', 'python3', 'head'])
  })

  it('ignores shell keywords in a loop', () => {
    // Was `run.sh / for / do`.
    const command = [
      'cd ~/ComfyUI-h3 && nohup ./run_h3.sh > /tmp/x.log 2>&1 &',
      'for i in $(seq 1 90); do curl -s http://127.0.0.1:8189/system_stats >/dev/null 2>&1 && { echo ok; break; }; sleep 1; done',
      'cd ~/workspace/example',
      'echo "=== draft ==="',
    ].join('\n')
    expect(shellPrograms(command)).toEqual(['run_h3.sh', 'curl', 'echo'])
  })

  it('ignores comments, emoji headings and dates', () => {
    // Was `python3 / # / Qwen-Image-2.1（2026-10-12`, `git / 2026-10-12 / ##`.
    const command = [
      'cd ~/workspace/example   # 2026-10-12',
      '# Qwen-Image-2.1（2026-10-12）',
      'git log --oneline -3',
      'echo "## 2026-10-12 ⚠️ 30 sec"',
    ].join('\n')
    expect(shellPrograms(command)).toEqual(['git', 'echo'])
  })

  it('names a script invoked through a wrapper, and nothing from an unreadable token', () => {
    expect(shellPrograms('./deploy.sh --force')).toEqual(['deploy.sh'])
    expect(shellPrograms('"$WEIRD_BIN" --x')).toEqual([])
    expect(shellPrograms('2>&1 | 1')).toEqual([])
  })
})

describe('splitShellSegments', () => {
  it('keeps separators inside quotes', () => {
    expect(splitShellSegments('grep "a|b" f | head')).toEqual(['grep "a|b" f', 'head'])
  })

  it('keeps a continuation line inside its segment', () => {
    expect(splitShellSegments('python3 a.py \\\n  --flag x')).toEqual(['python3 a.py \\\n  --flag x'])
  })

  it('drops a comment line', () => {
    expect(splitShellSegments('ls  # list\npwd')).toEqual(['ls', 'pwd'])
  })

  it('swallows a heredoc body whole', () => {
    expect(splitShellSegments("cat <<'EOF'\na | b; c\nEOF\npwd")).toEqual(["cat <<'EOF'", 'pwd'])
  })
})
