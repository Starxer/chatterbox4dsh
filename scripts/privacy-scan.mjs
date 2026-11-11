#!/usr/bin/env node
/**
 * Repository privacy gate — AGENTS.md hard rule 1, mechanised.
 *
 * This repository is public twice: on GitHub (every commit that was ever
 * pushed) and on npm (the packaged tarball). Naming THIS machine, its owner,
 * the network it sits on, a credential value or a real tenant id is a leak on
 * both. So the gate checks three surfaces that are all public-facing:
 *
 *   1. tracked files   `git ls-files` (what GitHub renders)
 *   2. published files `npm pack --dry-run --json` (includes the generated,
 *                      untracked `lib/` — the tarball is what npm serves)
 *   3. history         `git log --all -p` (with `--history`)
 *
 * Usage:
 *   node scripts/privacy-scan.mjs                  # tracked + published files
 *   node scripts/privacy-scan.mjs --history        # also every commit diff
 *   PRIVACY_HOSTNAME=$(hostname) node scripts/privacy-scan.mjs
 *                                                 # additionally flag this
 *                                                 # machine's own hostname
 *
 * Exit codes: 0 clean, 1 findings, 2 the gate could not run.
 *
 * Matched values are REDACTED before printing: CI logs for a public repository
 * are public too, so a failing gate must not re-publish what it caught.
 *
 * What it cannot check: an arbitrary machine name or user name that is not in a
 * path (English prose can mention "my laptop" in a hundred ways). Pass
 * PRIVACY_HOSTNAME on the machine itself when you want that covered; CI cannot
 * know it.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** This file necessarily contains safe samples of every rule; never scan it. */
const SELF_PATH = 'scripts/privacy-scan.mjs'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const BINARY_EXTENSIONS = new Set([
  '.tgz', '.gz', '.zip', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.bmp',
  '.mp4', '.mov', '.mkv', '.mp3', '.m4a', '.ogg', '.opus', '.wav', '.woff', '.woff2',
  '.ttf', '.otf', '.pdf', '.docx', '.xlsx', '.pptx', '.wasm', '.node', '.so', '.dylib',
])

/** User-name segments that are documentation placeholders, not people. */
const PLACEHOLDER_USERS = new Set([
  'me', 'user', 'you', 'username', 'yourname', 'name', 'example', 'sample', 'demo', 'test',
  'alice', 'bob', 'jane', 'john', 'someone', 'nobody', 'foo', 'bar', 'someoneelse',
  // CI runner accounts (GitHub Actions uses `runner`/`runneradmin`, and Windows
  // passes its profile back as the 8.3 short name `RUNNER~1`); a build log or a
  // note about one is not somebody's private machine.
  'runner', 'runneradmin', 'runner~1',
])
/** Documentation addresses (RFC 5737 is public IP space, not a real host). */
const PLACEHOLDER_IPS = new Set([
  '10.0.0.1', '10.0.0.2', '192.168.0.1', '192.168.1.1', '192.168.1.2', '172.16.0.1',
])
const PLACEHOLDER_EMAIL_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'example.invalid', 'localhost',
  'users.noreply.github.com',
])

/**
 * Exact (file, value) pairs whose fixtures intentionally look like leaks.
 * Keep this list SHORT and file-scoped — a value allowed everywhere is not a
 * check any more.
 */
const FIXTURE_ALLOWLIST = new Set([
  'tests/outbound-safety.spec.ts\u0000t-1234567890abcdef',
])

const RULES = [
  {
    id: 'local-path',
    why: 'absolute local path names a real user or the local filesystem layout',
    pattern: /(?<![\w.<~/-])\/(?:home|Users|root)\/[A-Za-z0-9._-]+/g,
    mask: (value) => `${value.slice(0, value.indexOf('/', 1) + 1)}<redacted>`,
    allow: (value) => PLACEHOLDER_USERS.has(value.split('/')[2] ?? ''),
  },
  {
    id: 'local-path-windows',
    why: 'absolute local path names a real user on Windows',
    pattern: /(?<![\w.])[A-Za-z]:\\Users\\[A-Za-z0-9._ -]+/g,
    mask: () => 'C:\\Users\\<redacted>',
    allow: (value) => {
      const segment = (value.split('\\')[2] ?? '').trim().toLowerCase()
      // `C:\Users\...` is prose for "some user", not a leaked name.
      return PLACEHOLDER_USERS.has(segment) || /^\.{2,}$/u.test(segment)
    },
  },
  {
    id: 'private-ip',
    why: 'private / carrier-grade NAT address identifies the local network',
    pattern:
      /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/g,
    allow: (value) => PLACEHOLDER_IPS.has(value),
  },
  {
    id: 'tailscale-host',
    why: 'tailnet hostname identifies the private network and usually the machine',
    pattern: /\b[a-z0-9][a-z0-9-]{0,62}\.(?:ts\.net|tailscale\.net)\b/gi,
  },
  {
    id: 'private-key',
    why: 'private key material',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  },
  {
    id: 'github-token',
    why: 'GitHub credential value',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  },
  {
    id: 'npm-token',
    why: 'npm credential value',
    pattern: /\bnpm_[A-Za-z0-9]{30,}/g,
  },
  {
    id: 'api-key',
    why: 'API key / secret value',
    pattern: /\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'slack-token',
    why: 'Slack credential value',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  },
  {
    id: 'aws-key-id',
    why: 'AWS access key id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'feishu-token',
    why: 'Lark/Feishu tenant or user access token',
    pattern: /\b[tu]-[0-9a-f]{16,}\b/g,
  },
  {
    id: 'feishu-id',
    why: 'real Lark/Feishu tenant, chat, user or app id',
    pattern: /\b(?:oc|ou|on|om|cli)_[0-9a-f]{12,}\b/g,
  },
  {
    id: 'assigned-secret',
    why: 'assignment whose value looks like a live credential',
    pattern:
      /\b(?:app[_-]?secret|client[_-]?secret|api[_-]?key|access[_-]?token|tenant[_-]?access[_-]?token|refresh[_-]?token|password|passwd)\b\s*[:=]\s*['"]?([A-Za-z0-9_+/=-]{16,})/gi,
    mask: (value) => value.replace(/([:=]\s*['"]?)[^\s'"]+$/, '$1<redacted>'),
    allow: (value) => isPlaceholderValue(/([:=]\s*['"]?)([^\s'"]+)$/.exec(value)?.[2] ?? ''),
  },
  {
    id: 'real-email',
    why: 'real e-mail address (virtual noreply addresses are fine)',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    allow: (value) => {
      const domain = value.slice(value.lastIndexOf('@') + 1).toLowerCase()
      const localPart = value.slice(0, value.lastIndexOf('@')).toLowerCase()
      return (
        PLACEHOLDER_EMAIL_DOMAINS.has(domain) ||
        domain.endsWith('.users.noreply.github.com') ||
        // `noreply@` / `no-reply@` addresses are non-personal by construction
        // (e.g. the Co-Authored-By trailers bots add).
        /^no-?reply/.test(localPart)
      )
    },
  },
]

/** Extra literal terms from the environment (e.g. this machine's hostname). */
const EXTRA_RULES = []
const extraTerm = process.env.PRIVACY_HOSTNAME?.trim()
if (extraTerm) {
  EXTRA_RULES.push({
    id: 'local-hostname',
    why: 'this machine\'s hostname (from PRIVACY_HOSTNAME)',
    pattern: new RegExp(escapeRegExp(extraTerm), 'g'),
    mask: () => '<hostname>',
  })
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isPlaceholderValue(value) {
  const trimmed = value.replace(/^['"]|['"]$/g, '')
  return (
    trimmed === '' ||
    /^[xX*]{8,}$/.test(trimmed) ||
    /^0{8,}$/.test(trimmed) ||
    /^(?:your|dummy|fake|test|example|sample|redacted|placeholder|change ?me|secret|token|value|none|null|undefined|xxxx|\))/i.test(trimmed) ||
    /[<${}…%]/.test(trimmed) ||
    /^\$\{/.test(trimmed)
  )
}

function isAllowed(rule, value, file) {
  return FIXTURE_ALLOWLIST.has(`${file}\u0000${value}`) || rule.allow?.(value) === true
}

function defaultMask(value) {
  const head = value.slice(0, 3)
  return `${head}…(${value.length} chars)`
}

function scanLine(line, file) {
  const findings = []
  for (const rule of [...RULES, ...EXTRA_RULES]) {
    rule.pattern.lastIndex = 0
    let match
    while ((match = rule.pattern.exec(line)) !== null) {
      const value = match[0]
      if (rule.pattern.lastIndex === match.index) rule.pattern.lastIndex += 1
      if (isAllowed(rule, value, file)) continue
      findings.push({ rule: rule.id, masked: rule.mask ? rule.mask(value) : defaultMask(value) })
    }
  }
  return findings
}

function scanText(text, file) {
  const findings = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.length < 8) continue
    for (const finding of scanLine(line, file)) {
      findings.push({ file, line: index + 1, ...finding })
    }
  }
  return findings
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
}

function trackedFiles() {
  return git(['ls-files', '-z'])
    .split('\u0000')
    .filter(Boolean)
}

/** The exact file list npm would publish, including generated untracked files. */
function publishedFiles() {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const parsed = JSON.parse(output)
  return (Array.isArray(parsed) ? parsed[0] : parsed).files.map((entry) => entry.path)
}

function scanFiles(files) {
  const findings = []
  let scanned = 0
  for (const file of files) {
    if (file === SELF_PATH) continue
    const absolute = path.join(ROOT, file)
    let stats
    try {
      stats = statSync(absolute)
    } catch {
      continue // listed by git but deleted in the working tree
    }
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_FILE_BYTES) continue
    if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) continue
    const buffer = readFileSync(absolute)
    if (buffer.subarray(0, 8192).includes(0)) continue
    const text = buffer.toString('utf8')
    if (text.includes('\uFFFD')) continue // not UTF-8; the rules are text based
    scanned += 1
    findings.push(...scanText(text, file))
  }
  return { findings, scanned }
}

function scanHistory() {
  const log = git(['log', '--all', '-p', '--format=@@@%H%n%B'])
  const findings = []
  let commit = '?'
  let file = ''
  const seen = new Set()
  for (const line of log.split('\n')) {
    const header = /^@@@([0-9a-f]{7,40})$/.exec(line)
    if (header) {
      commit = header[1].slice(0, 12)
      file = ''
      continue
    }
    if (line.startsWith('+++ b/')) {
      file = line.slice('+++ b/'.length)
      continue
    }
    if (line.startsWith('--- a/')) continue
    if (file === SELF_PATH) continue
    if (line.length < 8) continue
    for (const finding of scanLine(line, file)) {
      const key = `${commit}\u0000${file}\u0000${finding.rule}\u0000${finding.masked}`
      if (seen.has(key)) continue
      seen.add(key)
      findings.push({ commit, file: file || '(commit message)', ...finding })
    }
  }
  return findings
}

function report(findings, surfaces) {
  if (findings.length === 0) {
    console.log(`privacy scan clean — ${surfaces.join(', ')}`)
    return 0
  }
  console.error(`privacy scan FAILED — ${findings.length} finding(s)\n`)
  const sorted = findings.slice().sort((left, right) =>
    `${left.file}${left.line ?? ''}`.localeCompare(`${right.file}${right.line ?? ''}`),
  )
  for (const finding of sorted) {
    const where = finding.commit
      ? `commit ${finding.commit} ${finding.file}`
      : `${finding.file}:${finding.line}`
    const why = [...RULES, ...EXTRA_RULES].find((rule) => rule.id === finding.rule)?.why ?? ''
    console.error(`  ${where}  [${finding.rule}]  ${finding.masked}${why ? `  — ${why}` : ''}`)
  }
  console.error(
    '\nFix the content, or — for a deliberate fixture — add a narrowly scoped (file, value) entry to FIXTURE_ALLOWLIST in scripts/privacy-scan.mjs.',
  )
  return 1
}

/** Fail loudly when a rule stops matching: a silently broken gate is worse than none. */
function selfTest() {
  const samples = [
    ['local-path', `x /${'home'}/${'realuser42'}/project y`, true],
    ['local-path', `x /${'home'}/${'me'}/project y`, false],
    ['local-path', `x /${'Users'}/${'you'}/project y`, false],
    ['private-ip', `host ${'10'}.${'23'}.${'4'}.${'5'}`, true],
    ['private-ip', `host ${'192'}.${'168'}.${'0'}.${'1'}`, false],
    ['private-ip', `host ${'192'}.${'168'}.${'1'}.${'2'}`, false],
    ['tailscale-host', `host ${'box'}.${'ts'}.${'net'}`, true],
    ['github-token', `token ${'ghp_'}${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`, true],
    ['feishu-token', `bearer ${'t-'}${'0123456789abcdef0123'}`, true],
    ['feishu-id', `chat ${'oc_'}${'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'}`, true],
    ['feishu-id', `chat ${'oc_'}${'1'}`, false],
    ['assigned-secret', `app_secret=${'a1b2c3d4e5f6g7h8i9j0k1l2'}`, true],
    ['assigned-secret', `app_secret=${'x'.repeat(32)}`, false],
    ['assigned-secret', `appSecretRef=${'DSH_LARK_APP_SECRET'}`, false],
    ['real-email', `mail ${'someone'}@${'example'}${'.'}${'com'}`, false],
    ['real-email', `mail ${'real.person'}@${'gmail'}${'.'}${'com'}`, true],
    ['real-email', `Co-Authored-By: bot <${'noreply'}@${'anthropic'}${'.'}${'com'}>`, false],
    ['private-key', `-----BEGIN ${'RSA '}PRIVATE KEY-----`, true],
  ]
  const failures = []
  for (const [ruleId, line, shouldFlag] of samples) {
    const flagged = scanLine(line, 'self-test').some((finding) => finding.rule === ruleId)
    if (flagged !== shouldFlag) failures.push(`${ruleId}: expected flagged=${shouldFlag} on ${JSON.stringify(line)}`)
  }
  if (failures.length > 0) {
    console.error('privacy scan self-test FAILED:\n  ' + failures.join('\n  '))
    process.exit(2)
  }
}

export { RULES, scanLine, scanText, scanHistory, scanFiles, selfTest }

function main() {
  selfTest()
  const wantHistory = process.argv.includes('--history')
  const surfaces = []
  let findings = []

  let tracked = []
  let published = []
  try {
    tracked = trackedFiles()
    published = publishedFiles()
  } catch (error) {
    console.error(`privacy scan could not collect the file surfaces: ${error.message}`)
    process.exit(2)
  }
  const union = [...new Set([...tracked, ...published])]
  const fileResult = scanFiles(union)
  findings = findings.concat(fileResult.findings)
  surfaces.push(`${fileResult.scanned} files (${tracked.length} tracked, ${published.length} published)`)

  if (wantHistory) {
    findings = findings.concat(scanHistory())
    surfaces.push('full git history')
  }

  process.exit(report(findings, surfaces))
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
