#!/usr/bin/env node
/**
 * Maintenance-only helper: pull DSH's built-in (WebUI) client locale dictionaries
 * and report how our plugin's own i18n copy compares, so we can align our wording
 * to the officially shipped UI strings instead of relying on hand-written
 * (and occasionally stiff) translations.
 *
 * This is a DEV-TIME tool. It is not shipped, not imported by lib/client, and
 * never runs inside the deployed plugin. It only READS DSH sources and writes a
 * snapshot + a markdown difference report for a human to act on. It never edits
 * `src/i18n.ts` / `src/commands-i18n.ts` on its own.
 *
 * Usage:
 *   DSH_ROOT=/path/to/deepseek-harness node scripts/sync-dsh-locales.mjs [pluginRoot] [--out <dir>]
 *
 *   - DSH_ROOT (env) or the first CLI arg is the DSH monorepo root. No local
 *     absolute path is baked into this file — supply it at run time.
 *   - pluginRoot is optional; defaults to the directory containing this script.
 *   - Output goes to <pluginRoot>/scripts/out/ by default (override with --out).
 *
 * Join strategy: within each DSH locale file the `zh`/`en` objects share the same
 * keys, so we pair each key's English and Chinese string; we then match the
 * ENGLISH strings that our own i18n already ships and surface the authoritative
 * DSH Chinese for that same concept.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)))

/** True when a string contains CJK ideographs. */
function isCJK(value) {
  return /[\u3000-\u9fff\uff00-\uffef]/.test(value)
}

/** Extract `export const <name> = { ... }` blocks from a locale module. */
function parseBlocks(source) {
  const blocks = []
  const re = /export\s+const\s+([A-Za-z$][\w$]*)\s*=\s*\{([\s\S]*?)\}/g
  let m
  while ((m = re.exec(source)) !== null) {
    blocks.push({ name: m[1], body: m[2] })
  }
  return blocks
}

/** Extract `'key': 'value'` pairs (single or double quoted, one line) from an object body. */
function parseEntries(body) {
  const entries = []
  // Match one-line quoted key/value pairs. Values never span lines here.
  const re = /(['"])([\w./-]+)\1\s*:\s*(['"])([^'"\r\n]*)\3/g
  let m
  while ((m = re.exec(body)) !== null) {
    entries.push({ key: m[2], value: m[4] })
  }
  return entries
}

/** Recursively enumerate files under a directory matching an extension/predicate. */
function walk(dir, depth = 0) {
  const out = []
  if (depth > 12) return out
  let list
  try {
    list = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of list) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walk(full, depth + 1))
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
  return out
}

/** Paired (en, zh) values for one locale file: { key: { en?, zh? } }. */
function parseLocaleFile(filePath) {
  const source = readFileSync(filePath, 'utf8')
  const byName = {}
  for (const block of parseBlocks(source)) {
    byName[block.name] = parseEntries(block.body)
  }
  // Collect both an "en-ish" and a "zh-ish" value per key within this file.
  const paired = {}
  for (const entries of Object.values(byName)) {
    for (const { key, value } of entries) {
      const entry = (paired[key] ??= {})
      if (isCJK(value)) {
        entry.zh ??= value
      } else if (value.trim() !== '') {
        entry.en ??= value
      }
    }
  }
  return { pairs: paired }
}

function arg(args, name, fallback) {
  const idx = args.indexOf(name)
  if (idx !== -1 && args[idx + 1] !== undefined) return args[idx + 1]
  return fallback
}

function main() {
  const args = process.argv.slice(2)
  const dshRoot = process.env.DSH_ROOT || arg(args, '--dsh-root', args[0] || '')
  if (!dshRoot || !existsSync(dshRoot)) {
    console.error('sync-dsh-locales: DSH_ROOT (or --dsh-root <path>) must point at the DSH monorepo root.')
    process.exit(1)
  }
  const pluginRoot = arg(args, '--plugin-root', arg(args, '--root', resolve(__dirname, '..')))
  const outDir = resolve(pluginRoot, arg(args, '--out', 'scripts/out'))
  mkdirSync(outDir, { recursive: true })

  const localeFiles = walk(join(dshRoot, 'packages'))
    .filter(f => f.endsWith('.ts') && /[\\/]src[\\/]client[\\/]locales[^\\/]*\.ts$/.test(f))
    .sort()

  if (localeFiles.length === 0) {
    console.error('sync-dsh-locales: no DSH client locale files found under packages/')
    process.exit(1)
  }

  const namespaces = {}
  /** en-string -> zh-string, joined across every locale file. */
  const enToZh = new Map()
  /** zh-string -> en-string (used to detect whether we already ship the zh). */
  const zhToEn = new Map()

  for (const file of localeFiles) {
    const ns = relative(join(dshRoot, 'packages'), file).replace(/\\/g, '/').replace(/\/src\/client\/locales[^\/]*\.ts$/, '')
    const { pairs } = parseLocaleFile(file)
    namespaces[ns] = namespaces[ns] ?? {}
    for (const [key, { en, zh }] of Object.entries(pairs)) {
      namespaces[ns][key] = { ...(en !== undefined ? { en } : {}), ...(zh !== undefined ? { zh } : {}) }
      if (en !== undefined && zh !== undefined) {
        if (!enToZh.has(en)) enToZh.set(en, zh)
        if (!zhToEn.has(zh)) zhToEn.set(zh, en)
      }
    }
  }

  // Snapshot the whole DSH dictionary.
  const snapshot = {
    generatedAt: new Date().toISOString(),
    dshRootBasename: 'dsh-root', // never leak a real path into the snapshot
    count: Object.keys(enToZh).length,
    namespaces,
  }

  // Read our own i18n string literals.
  const i18nFiles = ['src/i18n.ts', 'src/commands-i18n.ts']
    .map(f => join(pluginRoot, f))
    .filter(existsSync)
  const ourStrings = new Set()
  for (const file of i18nFiles) {
    const source = readFileSync(file, 'utf8')
    // Read source line-by-line and pull only single-line quoted literals, so a
    // string never accidentally swallows a later quote across newlines (the
    // plugin's i18n uses template literals + apostrophe-rich prose).
    for (const line of source.split('\n')) {
      const re = /(['"])([^'"\r\n]*)\1/g
      let m
      while ((m = re.exec(line)) !== null) {
        const v = m[2]
        if (v.trim() !== '') ourStrings.add(v)
      }
    }
  }

  // Match our English literals to DSH concepts and report authoritative zh.
  const matches = []
  for (const [en, zh] of enToZh) {
    if (ourStrings.has(en)) {
      matches.push({ en, zh, aligned: ourStrings.has(zh) })
    }
  }
  matches.sort((a, b) => a.en.localeCompare(b.en))

  // Write outputs.
  writeFileSync(join(outDir, 'dsh-webui-locales.json'), JSON.stringify(snapshot, null, 2) + '\n')

  const lines = []
  lines.push('# DSH WebUI 文案对齐报告')
  lines.push('')
  lines.push(`> 自动生成于 ${snapshot.generatedAt}（维护期工具，非插件运行时）。`)
  lines.push('> 来源：DSH 客户端内置 locales 字典（即 WebUI 渲染文案）。')
  lines.push('> 方法：按「同一 key 的英文值」对齐我们的插件文案，列出 DSH 官方中文。')
  lines.push('')
  lines.push(`共从 DSH 提取 **${enToZh.size}** 条中英对照，命中我们插件现有英文文案 **${matches.length}** 条。`)
  lines.push('')
  lines.push('| DSH 术语（en） | DSH 官方中文 | 我们是否已对齐 |')
  lines.push('|---|---|---|')
  for (const { en, zh, aligned } of matches) {
    lines.push(`| \`${en}\` | ${zh} | ${aligned ? '✅' : '⚠️ 需要更新'} |`)
  }
  lines.push('')
  lines.push('> ⚠️ 需要更新 = 我们插件里没有与 DSH 官方中文一致的字面量（可能用了生硬的机翻），请据此核改 `src/i18n.ts` / `src/commands-i18n.ts`。')
  lines.push('')
  const report = lines.join('\n')
  writeFileSync(join(outDir, 'dsh-webui-locales-align.md'), report)

  console.log(`sync-dsh-locales: scanned ${localeFiles.length} locale files, ${enToZh.size} paired concepts, ${matches.length} matched our i18n.`)
  console.log(`snapshot -> ${join(outDir, 'dsh-webui-locales.json')}`)
  console.log(`report   -> ${join(outDir, 'dsh-webui-locales-align.md')}`)
  console.log('')
  console.log(report)
}

main()
