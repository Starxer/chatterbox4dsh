/**
 * Feishu card-based model selector. Two-step flow:
 *   1. Provider selection — pick a provider from a dropdown.
 *   2. Model selection — pick a model from a dropdown, click "确认" to apply.
 *
 * The model dropdown and confirm button are inside a form container so that
 * selecting a model does NOT trigger any callback — only clicking "确认"
 * submits the form and applies the switch.
 *
 * @module @starxer/chatterbox4dsh/feishu-model-select
 */

import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { LlmProviderInfo, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { HarnessConversationService } from './harness.ts'
import type { ConversationMessage } from './conversation.ts'
import type { Translations } from './i18n.ts'
import { renderSupersededCard } from './card-supersede.ts'
import type { CardTopicRegistry } from './card-topics.ts'
import type { RecentModelEntry } from './recent-models.ts'

/** Minimal logger surface. */
interface PluginLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/** Source of the current bridge — recreated on every channel reconcile. */
interface BridgeHolder {
  current: HarnessConversationService | undefined
}

/** Subset of the cardAction event the selector consumes. */
export interface CardActionLike {
  messageId?: string
  chatId?: string
  operator?: { openId?: string }
  action?: { value?: unknown; tag?: string; option?: string }
  raw?: { action?: { value?: unknown; tag?: string; option?: string; form_value?: Record<string, unknown> } }
}

/** Channel adapter — same surface as feishu-questions.ts plus the V2 card
 *  instance methods used by the model selector. */
export interface ModelSelectChannel {
  send(to: string, input: { card: object } | { text: string }, opts?: { replyInThread?: boolean }): Promise<{ messageId?: string }>
  updateCard(messageId: string, card: object): Promise<void>
  recallMessage(messageId: string): Promise<void>
  onCardAction(handler: (evt: CardActionLike) => void | Promise<void>): () => void
  createCardInstance(card: object): Promise<string>
  sendCardByReference(to: string, cardId: string, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }>
  updateCardInstance(cardId: string, card: object, sequence: number): Promise<void>
}

/** Narrow llm directory view. */
interface LlmDirectoryLike {
  listProviders(): readonly LlmProviderInfo[]
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
  resolveModelInfo(provider: string, model: string): Promise<{ reasoning?: { efforts: readonly { id: string }[]; defaultEffort?: string } | undefined }>
}

/** Reasoning metadata for one exact model route, as either discovery source reports it. */
interface ReasoningLike {
  readonly efforts: readonly { readonly id: string; readonly name?: string }[]
  readonly defaultEffort?: string
}

/** The Host's own provider/model catalog, as `sessionController.modelCatalog()` answers it. */
interface ModelCatalogLike {
  readonly groups: readonly {
    readonly id: string
    readonly name: string
    readonly models: readonly {
      readonly id: string
      readonly name: string
      readonly description?: string
      readonly reasoning?: ReasoningLike
    }[]
  }[]
}

/** Narrow SessionController view — what feishu-model-select actually uses. */
interface SessionControllerLike {
  selectModel(request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<unknown>
  /**
   * The Host's model catalog: one call for every provider, its models, and each
   * model's reasoning efforts. Optional so this module still runs against a Host
   * that predates it — discovery then falls back to the llm directory below.
   */
  modelCatalog?(): Promise<ModelCatalogLike>
}

/** A resolved model selection. */
interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** A queued card action. */
interface QueuedAction {
  action: ModelCardAction
  flow?: ModelCardFlow
  chatMessage: ConversationMessage
  messageId: string | undefined
}

// ---------------------------------------------------------------------------
// Card action payload types
// ---------------------------------------------------------------------------

type ModelCardAction =
  | { type: 'enter-select' }
  | { type: 'select-provider'; provider: string }
  | { type: 'go-back' }
  | { type: 'confirm-select'; provider: string; model: string; reasoningEffort?: string }
  | { type: 'switch-last' }
  | { type: 'switch-recent'; provider: string; model: string; reasoningEffort?: string }
  | { type: 'switch-effort'; effort: string }

/** Flow marker embedded in card action values. `undefined` = the standalone
 *  `/model` switch flow; `'new-session'` = the `/new` card flow reusing the
 *  same provider/model cards but committing to session creation instead. */
export type ModelCardFlow = 'new-session' | undefined

// ---------------------------------------------------------------------------
// Card rendering — two-step dropdown flow
// ---------------------------------------------------------------------------

function buildProviderOptions(providers: readonly LlmProviderInfo[]): object[] {
  return providers.map(p => ({
    text: { tag: 'plain_text', content: p.name !== '' ? `${p.name} (${p.id})` : p.id },
    value: p.id,
  }))
}

function buildModelOptions(models: readonly LlmModelInfo[]): object[] {
  return models.map(m => ({
    text: { tag: 'plain_text', content: m.name !== '' && m.name !== m.id ? `${m.name} (${m.id})` : m.id },
    value: m.id,
  }))
}

/** Step 1 — Provider selection card. `flow` distinguishes the standalone
 *  `/model` switch from the `/new` card flow reusing the same card.
 *
 *  Both flows get the same three sections — the route in effect, the
 *  "previous model" quick action and the GLOBAL recently-used rows — because
 *  the `/new` model step is the same decision, only the consequence differs:
 *  a `/model` pick switches the running Session, a `/new` pick becomes the
 *  route of the session that is about to be created. The action values carry
 *  the flow marker so the handlers never apply one to the other. */
export function renderProviderSelectCard(
  providers: readonly LlmProviderInfo[],
  current: ModelSelection,
  flow: ModelCardFlow | undefined,
  t: Translations,
  options: { lastUsed?: ModelSelection | undefined; recent?: readonly RecentModelEntry[] | undefined } = {},
): object {
  const effort = current.reasoningEffort !== undefined && current.reasoningEffort !== ''
    ? current.reasoningEffort
    : 'default'
  // A `/new` card must never read like a switch: these variants say "this is
  // the model the new session gets", and their confirm button creates.
  const forNewSession = flow === 'new-session'
  const flowMarker = forNewSession ? { flow: 'new-session' as const } : {}
  // `/model` shows the current route MARKED inside the list (dropping it made
  // the whole section vanish when the memory held only that route). `/new`
  // already shows it as its own tappable row above, so it is filtered out here
  // instead of appearing twice — once dead.
  const recentRows = (options.recent ?? []).filter(entry =>
    !(forNewSession && entry.provider === current.provider && entry.model === current.model))

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: flow === 'new-session' ? t.modelSelectNewSessionTitle : t.modelSelectTitle(false) },
      template: 'blue',
    },
    body: {
      elements: [
        // The route in effect is context on `/model` (it is already applied,
        // so a tap would be a no-op). On `/new` it is a CHOICE: the default
        // route is exactly what the new session would inherit, so leaving it as
        // a dead line forced the operator through the provider/model dropdowns
        // just to accept what the card had already told them ("还是没法点击选择
        // 默认模型", 2026-10-23). A tappable row is the one-tap way to accept it.
        ...(forNewSession
          ? [{
            tag: 'interactive_container',
            elements: [{ tag: 'markdown', content: t.modelSelectNewSessionDefault(current.provider, current.model, effort) }],
            behaviors: [{
              type: 'callback',
              value: {
                action: 'switch-recent',
                provider: current.provider,
                model: current.model,
                ...(current.reasoningEffort === undefined || current.reasoningEffort === ''
                  ? {}
                  : { effort: current.reasoningEffort }),
                ...flowMarker,
              },
            }],
          }]
          : [{
            tag: 'markdown',
            content: t.modelSelectCurrent(current.provider, current.model, effort),
          }]),
        // The route goes in the card body: Feishu truncates button captions, so
        // a long "↺ 切回上次使用：provider/model" label was unreadable.
        ...(options.lastUsed !== undefined
          && (options.lastUsed.provider !== current.provider || options.lastUsed.model !== current.model)
          ? [
            {
              tag: 'markdown',
              content: forNewSession
                ? t.modelSelectLastUsedNewSession(options.lastUsed.provider, options.lastUsed.model)
                : t.modelSelectLastUsed(options.lastUsed.provider, options.lastUsed.model),
            },
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: forNewSession ? t.modelSelectLastUsedButtonNewSession : t.modelSelectLastUsedButton,
              },
              type: 'default',
              behaviors: [{ type: 'callback', value: { action: 'switch-last', ...flowMarker } }],
            },
          ]
          : []),
        // GLOBAL recently used models (across Feishu sessions), one tappable row
        // each. In `/model` they switch THIS session only (the global default
        // stays put); in `/new` they become the new session's route.
        ...(recentRows.length > 0
          ? [
            {
              tag: 'markdown',
              content: forNewSession ? t.modelSelectRecentHeaderNewSession : t.modelSelectRecentHeader,
            },
            ...recentRows.map(entry => {
              // Already in effect: a mark, not an action.
              if (entry.provider === current.provider && entry.model === current.model) {
                return { tag: 'markdown', content: t.modelSelectRecentCurrent(entry.provider, entry.model) }
              }
              return {
                tag: 'interactive_container',
                elements: [{
                  tag: 'markdown',
                  content: `\`${entry.provider}/${entry.model}\`${entry.reasoningEffort === undefined ? '' : ` · 💡 ${entry.reasoningEffort}`}`,
                }],
                behaviors: [{
                  type: 'callback',
                  value: {
                    action: 'switch-recent',
                    provider: entry.provider,
                    model: entry.model,
                    ...(entry.reasoningEffort === undefined ? {} : { effort: entry.reasoningEffort }),
                    ...flowMarker,
                  },
                }],
              }
            }),
          ]
          : []),
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: t.modelSelectProviderHeader,
        },
        {
          tag: 'select_static',
          placeholder: { tag: 'plain_text', content: t.modelSelectProviderPlaceholder },
          options: buildProviderOptions(providers),
          value: current.provider,
          behaviors: [{
            type: 'callback',
            value: { action: 'select-provider', ...(flow === undefined ? {} : { flow }) },
          }],
        },
      ],
    },
  }
}

/** The `/reasoning` quick-effort card: one tappable row per declared effort. */
export function renderReasoningCard(
  current: ModelSelection,
  efforts: readonly { readonly id: string; readonly name?: string }[],
  currentEffort: string | undefined,
  t: Translations,
): object {
  const rows: object[] = [
    { tag: 'markdown', content: `${t.reasoningCardHint}\n\n${t.modelSelectCurrent(current.provider, current.model, currentEffort ?? 'default')}` },
    { tag: 'hr' },
  ]
  if (efforts.length === 0) {
    rows.push({ tag: 'markdown', content: t.reasoningCardEmpty })
  } else {
    if (currentEffort === undefined) {
      rows.push({ tag: 'markdown', content: t.reasoningCardCurrent(t.reasoningCardDefault) })
    }
    for (const effort of efforts) {
      const label = effort.name !== undefined && effort.name !== '' && effort.name !== effort.id
        ? `${effort.name} (${effort.id})`
        : effort.id
      if (effort.id === currentEffort) {
        rows.push({ tag: 'markdown', content: t.reasoningCardCurrent(label) })
        continue
      }
      rows.push({
        tag: 'interactive_container',
        elements: [{ tag: 'markdown', content: `\`${label}\`` }],
        behaviors: [{ type: 'callback', value: { action: 'switch-effort', effort: effort.id } }],
      })
    }
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.reasoningCardTitle }, template: 'blue' },
    body: { elements: rows },
  }
}

/** Step 2 — Model selection card.
 *  Model dropdown + (optional) reasoning effort dropdown + confirm button
 *  inside a form. Selecting a model or effort does NOT trigger a callback —
 *  only clicking "确认" submits the form and applies the switch.
 *  Back button outside the form. */
export function renderModelSelectCard(
  providers: readonly LlmProviderInfo[],
  models: readonly LlmModelInfo[],
  selectedProvider: string,
  selectedModel: string,
  currentEffort: string | undefined,
  supportedEfforts: readonly { id: string; name?: string }[],
  modelDefaultEffort: string | undefined,
  flow: ModelCardFlow | undefined,
  t: Translations,
): object {
  const modelOptions = buildModelOptions(models)

  const providerInfo = providers.find(p => p.id === selectedProvider)
  const providerLabel = providerInfo !== undefined && providerInfo.name !== ''
    ? `${providerInfo.name} (${providerInfo.id})`
    : selectedProvider

  // Build effort dropdown from the model's actual supported efforts.
  // Always include 'default' (no override) as the first option.
  const effortIds = supportedEfforts.map(e => e.id)
  const effortOptions: object[] = [
    { text: { tag: 'plain_text', content: t.modelEffortDefault }, value: 'default' },
    ...supportedEfforts
      .filter(e => e.id !== 'default')
      .map(e => ({
        text: { tag: 'plain_text', content: e.name ?? e.id.charAt(0).toUpperCase() + e.id.slice(1) },
        value: e.id,
      })),
  ]
  // Select initial value: prefer current effort if supported, else model default, else 'default'.
  const effortValue = (currentEffort !== undefined && currentEffort !== '' && currentEffort !== 'default' && effortIds.includes(currentEffort))
    ? currentEffort
    : (modelDefaultEffort !== undefined && effortIds.includes(modelDefaultEffort) ? modelDefaultEffort : 'default')

  // Build form elements — conditionally include reasoning effort dropdown.
  const formElements: object[] = [
    {
      tag: 'markdown',
      content: t.modelSelectModelHeader,
    },
    {
      tag: 'select_static',
      name: 'model',
      placeholder: { tag: 'plain_text', content: t.modelSelectModelPlaceholder(modelOptions.length === 0) },
      options: modelOptions,
      value: selectedModel,
    },
  ]

  if (supportedEfforts.length > 0 && effortOptions.length > 1) {
    formElements.push({
      tag: 'markdown',
      content: t.modelSelectEffortHeader,
    })
    formElements.push({
      tag: 'select_static',
      name: 'reasoning_effort',
      placeholder: { tag: 'plain_text', content: t.modelSelectEffortPlaceholder },
      options: effortOptions,
      value: effortValue,
    })
  }

  formElements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t.modelSelectConfirm(flow === 'new-session') },
    type: 'primary',
    name: 'confirm',
    form_action_type: 'submit',
    behaviors: [{
      type: 'callback',
      value: { action: 'confirm-select', provider: selectedProvider, ...(flow === undefined ? {} : { flow }) },
    }],
  })

  const elements: object[] = [
    {
      tag: 'markdown',
      content: t.modelSelectProviderLabel(providerLabel),
    },
    { tag: 'hr' },
    {
      tag: 'form',
      name: `model_form_${selectedProvider}`,
      elements: formElements,
    },
    // Back button — outside the form so it triggers a regular callback. It MUST
    // carry the flow marker: without it, stepping back from the `/new` model
    // card re-rendered the provider card as the standalone `/model` one (wrong
    // title and wording) and, worse, its rows would then switch the RUNNING
    // session instead of choosing the route of the session being created
    // (true on 2026-10-23: the operator went back and the card silently turned
    // into `/model`).
    {
      tag: 'button',
      text: { tag: 'plain_text', content: t.modelSelectBack },
      type: 'default',
      behaviors: [{
        type: 'callback',
        value: { action: 'go-back', ...(flow === undefined ? {} : { flow }) },
      }],
    },
  ]

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.modelSelectTitle(false) },
      template: 'blue',
    },
    body: { elements },
  }
}

/** Confirmation card after a successful switch. */
function renderSwitchedCard(provider: string, model: string, name: string | undefined, reasoningEffort: string | undefined, t: Translations): object {
  const label = name !== undefined && name !== '' && name !== model
    ? `${name} (\`${provider}/${model}\`)`
    : `\`${provider}/${model}\``
  const effortLine = reasoningEffort !== undefined && reasoningEffort !== ''
    ? `\n${t.modelSelectEffortLine(reasoningEffort)}`
    : ''
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.modelSelectTitle(false) },
      template: 'green',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `${t.modelSelectSwitchedHeader}\n\n` +
            `🔹 ${label}${effortLine}\n\n` +
            t.modelSelectSwitchedNext,
        },
      ],
    },
  }
}

// ---------------------------------------------------------------------------
// Card action handler
// ---------------------------------------------------------------------------

/** Parse cardAction events. Handles both button callbacks (action.value)
 *  and form submissions (raw.action.form_value). */
function parseCardAction(evt: CardActionLike): { action: ModelCardAction; flow?: ModelCardFlow } | undefined {
  // --- Form submission: confirm button inside the model form ---
  const formValue = evt.raw?.action?.form_value
  if (formValue !== undefined) {
    const raw = evt.action?.value
    let valueObj: Record<string, unknown> | undefined
    if (typeof raw === 'object' && raw !== null) {
      valueObj = raw as Record<string, unknown>
    } else if (typeof raw === 'string') {
      try {
        let result: unknown = JSON.parse(raw)
        let depth = 0
        while (typeof result === 'string' && depth < 4) {
          try { result = JSON.parse(result) } catch { break }
          depth++
        }
        if (typeof result === 'object' && result !== null) valueObj = result as Record<string, unknown>
      } catch { /* not JSON */ }
    }
    const actionType = valueObj !== undefined
      ? (typeof valueObj.action === 'string' ? valueObj.action : undefined)
      : undefined
    const provider = valueObj !== undefined
      ? (typeof valueObj.provider === 'string' ? valueObj.provider : undefined)
      : undefined
    const flow = valueObj !== undefined && valueObj.flow === 'new-session' ? 'new-session' as const : undefined

    if (actionType === 'confirm-select' && typeof provider === 'string') {
      const model = typeof formValue.model === 'string' ? formValue.model : undefined
      const effort = typeof formValue.reasoning_effort === 'string' && formValue.reasoning_effort !== 'default'
        ? formValue.reasoning_effort
        : undefined
      if (typeof model === 'string' && model !== '') {
        return { action: { type: 'confirm-select', provider, model, ...(effort !== undefined ? { reasoningEffort: effort } : {}) }, flow }
      }
      // Never drop a confirm in silence: an empty `model` means the dropdown
      // had no valid selection (see `handleSelectProvider`), and the operator
      // otherwise just sees a dead button.
      console.log(`dsh-feishu: [card] confirm-select ignored: provider=${provider} submitted no model (form_value=${JSON.stringify(formValue).slice(0, 200)})`)
    }
    return undefined
  }

  // --- Button callback ---
  const raw = evt.action?.value
  let valueObj: Record<string, unknown> | undefined
  if (typeof raw === 'string') {
    try {
      let result: unknown = JSON.parse(raw)
      let depth = 0
      while (typeof result === 'string' && depth < 4) {
        try { result = JSON.parse(result) } catch { break }
        depth++
      }
      if (typeof result === 'object' && result !== null) valueObj = result as Record<string, unknown>
    } catch { /* not JSON */ }
  } else if (typeof raw === 'object' && raw !== null) {
    valueObj = raw as Record<string, unknown>
  }

  if (valueObj === undefined) return undefined
  const actionType = typeof valueObj.action === 'string' ? valueObj.action : (typeof valueObj.type === 'string' ? valueObj.type : undefined)
  const provider = typeof valueObj.provider === 'string' ? valueObj.provider : undefined
  const model = typeof valueObj.model === 'string' ? valueObj.model : undefined
  const option = evt.action?.option
  const flow = valueObj.flow === 'new-session' ? 'new-session' as const : undefined

  if (actionType === 'enter-select') return { action: { type: 'enter-select' }, flow }
  if (actionType === 'select-provider' && typeof option === 'string') return { action: { type: 'select-provider', provider: option }, flow }
  if (actionType === 'go-back') return { action: { type: 'go-back' }, flow }
  if (actionType === 'switch-last') return { action: { type: 'switch-last' }, flow }
  if (actionType === 'switch-effort' && typeof valueObj.effort === 'string' && valueObj.effort !== '') {
    return { action: { type: 'switch-effort', effort: valueObj.effort }, flow }
  }
  if (actionType === 'switch-recent' && typeof provider === 'string' && typeof model === 'string') {
    const effort = typeof valueObj.effort === 'string' && valueObj.effort !== '' ? valueObj.effort : undefined
    return { action: { type: 'switch-recent', provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }, flow }
  }
  return undefined
}

function chatMessageFromEvent(evt: CardActionLike): ConversationMessage | undefined {
  if (evt.chatId === undefined) return undefined
  return { chatId: evt.chatId, chatType: 'p2p' }
}

// ---------------------------------------------------------------------------
// V2 card instance helpers
// ---------------------------------------------------------------------------

export async function sendModelCardV2(
  channel: ModelSelectChannel,
  chatMessage: ConversationMessage,
  card: object,
  cardByMessage: Map<string, string>,
  sequenceByCard: Map<string, number>,
  cardTopics?: CardTopicRegistry,
): Promise<{ messageId: string; cardId: string }> {
  const cardId = await channel.createCardInstance(card)
  // Topic messages must be sent as replies to the topic ROOT message so the
  // card lands inside the topic instead of leaking to the main chat stream.
  const opts = chatMessage.threadId !== undefined && chatMessage.rootId !== undefined
    ? { replyInThread: true, replyTo: chatMessage.rootId }
    : {}
  const result = await channel.sendCardByReference(chatMessage.chatId, cardId, opts)
  const messageId = result.messageId ?? ''
  if (messageId !== '') {
    cardByMessage.set(messageId, cardId)
    sequenceByCard.set(cardId, 0)
    // Record the topic this card went into, keyed by its message id — the
    // click that comes back carries no thread id (see `card-topics.ts`).
    cardTopics?.note(messageId, {
      ...(chatMessage.threadId !== undefined ? { threadId: chatMessage.threadId } : {}),
      ...(chatMessage.rootId !== undefined ? { rootId: chatMessage.rootId } : {}),
    })
  }
  return { messageId, cardId }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/** What {@link startFeishuModelSelect} hands back to the plugin. */
export interface FeishuModelSelectHandle {
  dispose(): void
  /** message id → CardKit card id, for in-place updates and retirement. */
  cardByMessage: Map<string, string>
  /** CardKit sequence per card id, shared with the retirement path. */
  sequenceByCard: Map<string, number>
  /** Send the `/new` flow's step-1 (provider) card. It carries the same
   *  sections the standalone `/model` card does — the route in effect, the
   *  previous-model quick action and the global recently-used rows — with the
   *  `new-session` flow marker, so a pick becomes the new session's route
   *  instead of switching the running one. */
  sendNewSessionProviderCard(chatMessage: ConversationMessage): Promise<{ messageId: string; cardId: string }>
}

export function startFeishuModelSelect(deps: {
  llm: LlmDirectoryLike
  agentDefaultModel: AgentDefaultModelConfig
  bridgeHolder: BridgeHolder
  sessionController: SessionControllerLike
  channel: ModelSelectChannel
  logger: PluginLogger
  /** Return the strings for the ACTIVE locale, read at render time. */
  getTranslations: () => Translations
  /** When set, confirm actions carrying the `new-session` flow marker are
   *  forwarded here instead of applying the model switch. Used by the
   *  `/new` card flow, which reuses the provider/model cards but commits the
   *  selection to session creation. */
  onNewSessionConfirm?: (chatMessage: ConversationMessage, selection: { provider: string; model: string; reasoningEffort?: string }, messageId: string | undefined) => Promise<void>
  /** Topic reply context for a clicked card. Card action events carry only
   *  `chatId` + `messageId`, so the caller restores the thread context here —
   *  otherwise selections / new-session commits inside a topic would target
   *  the main chat key instead of the topic key. The message id is the card's,
   *  which is what makes the lookup unambiguous in a group with several
   *  topics (see `card-topics.ts`). */
  topicFor?: (message: { chatId: string; messageId?: string }) => { rootId?: string; threadId?: string }
  /** Shared `messageId → topic` registry; cards sent from here are recorded so
   *  a click on them resolves to their own topic. */
  cardTopics?: CardTopicRegistry
}): FeishuModelSelectHandle {
  const { llm, agentDefaultModel, bridgeHolder, sessionController, channel, logger, getTranslations, onNewSessionConfirm, topicFor, cardTopics } = deps

  /**
   * Read the Host's model catalog, or `undefined` when this Host has none or the
   * read failed. Failure is never fatal: discovery falls back to the llm
   * directory, which is what this module used before the catalog existed.
   */
  async function loadCatalog(): Promise<ModelCatalogLike | undefined> {
    if (sessionController.modelCatalog === undefined) return undefined
    try {
      return await sessionController.modelCatalog()
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.warn(`dsh-feishu: model catalog read failed, falling back to the llm directory: ${msg}`)
      return undefined
    }
  }

  /** The provider list the cards render: the Host's catalog when available, else the llm directory. */
  async function discoverProviders(): Promise<readonly LlmProviderInfo[]> {
    const catalog = await loadCatalog()
    if (catalog !== undefined) return catalog.groups.map(group => ({ id: group.id, name: group.name }))
    return llm.listProviders()
  }

  /**
   * One provider's models plus a lazy reasoning lookup for a single model id.
   * The catalog answers both from one read — including the human-readable model
   * names it carries — while the llm fallback lists models per provider and
   * resolves reasoning per model, exactly as this module did before.
   * @param provider - provider route key.
   * @returns the models to offer and a resolver for one model's efforts.
   */
  async function discoverModels(provider: string): Promise<{
    readonly models: readonly LlmModelInfo[]
    reasoning(modelId: string): Promise<ReasoningLike | undefined>
  }> {
    const catalog = await loadCatalog()
    const group = catalog?.groups.find(candidate => candidate.id === provider)
    if (group !== undefined) {
      return {
        models: group.models.map(model => ({
          provider: group.id,
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
        })),
        reasoning: async (modelId: string) => group.models.find(model => model.id === modelId)?.reasoning,
      }
    }
    let models: readonly LlmModelInfo[]
    try {
      models = await llm.listModels(provider)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.warn(`dsh-feishu: failed to list models for ${provider}: ${msg}`)
      models = []
    }
    return {
      models,
      reasoning: async (modelId: string) => {
        try {
          return (await llm.resolveModelInfo(provider, modelId)).reasoning
        } catch {
          return undefined
        }
      },
    }
  }

  const processing = new Map<string, true>()
  const actionQueue = new Map<string, QueuedAction[]>()
  const MIN_UPDATE_INTERVAL_MS = 500

  /**
   * The newest route this Session used that differs from `current`, if any.
   *
   * Read from the Session log, never from the global default: this is what
   * makes the quick action session-local (`关键坑 59`).
   */
  async function lastUsedRoute(chatMessage: ConversationMessage, current: ModelSelection): Promise<ModelSelection | undefined> {
    const bridge = bridgeHolder.current
    if (bridge === undefined) return undefined
    const routes = await bridge.recentRoutes(chatMessage).catch(() => [])
    const previous = routes.find(route => route.provider !== current.provider || route.model !== current.model)
    if (previous === undefined) return undefined
    return {
      provider: previous.provider,
      model: previous.model,
      ...(previous.reasoningEffort === undefined ? {} : { reasoningEffort: previous.reasoningEffort }),
    }
  }

  /**
   * The route a NEW session would start with: DSH's global default.
   *
   * A `/new` flow builds a session from scratch, so the Session this chat runs
   * right now is NOT the reference — its route only wins if it was persisted as
   * the default (explicit `/model <provider>/<model>`), and a session-local
   * quick pick deliberately never is (`关键坑 59`).
   */
  function newSessionCurrent(): ModelSelection {
    const fallback = agentDefaultModel.currentSelection()
    return {
      provider: fallback.provider,
      model: fallback.model,
      ...(fallback.reasoningEffort !== undefined && fallback.reasoningEffort !== ''
        ? { reasoningEffort: String(fallback.reasoningEffort) }
        : {}),
    }
  }

  /**
   * Resolve the route the CARD should show as "current".
   *
   * `/model`: the model THIS chat's session actually runs, falling back to the
   * global default. `agentDefaultModel.currentSelection()` is only the default
   * for agents without a session-specific selection; a WebUI switch or session
   * creation can set a per-session model that never touches that default, so
   * reading the session's own `request/header` (the authority, matching
   * `/status` and the reply card) is what keeps the "当前模型" line truthful.
   *
   * `/new`: the global default — see {@link newSessionCurrent}.
   */
  async function resolveCurrent(chatMessage: ConversationMessage, flow?: ModelCardFlow): Promise<ModelSelection> {
    if (flow === 'new-session') return newSessionCurrent()
    const bridge = bridgeHolder.current
    const sessionSel = bridge !== undefined
      ? await bridge.sessionCurrentSelection(chatMessage).catch(() => undefined)
      : undefined
    const fallback = agentDefaultModel.currentSelection()
    const base = sessionSel ?? { provider: fallback.provider, model: fallback.model }
    return {
      provider: base.provider,
      model: base.model,
      ...(base.reasoningEffort !== undefined ? { reasoningEffort: String(base.reasoningEffort) } : {}),
    }
  }

  const cardByMessage = new Map<string, string>()
  const sequenceByCard = new Map<string, number>()

  async function updateCardInstanceOnMessage(
    messageId: string | undefined,
    chatMessage: ConversationMessage,
    card: object,
  ): Promise<void> {
    if (messageId === undefined) {
      await sendModelCardV2(channel, chatMessage, card, cardByMessage, sequenceByCard, cardTopics)
      return
    }
    const cardId = cardByMessage.get(messageId)
    if (cardId === undefined) {
      await sendModelCardV2(channel, chatMessage, card, cardByMessage, sequenceByCard, cardTopics)
      return
    }
    const seq = (sequenceByCard.get(cardId) ?? 0) + 1
    sequenceByCard.set(cardId, seq)
    try {
      await channel.updateCardInstance(cardId, card, seq)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.warn(`dsh-feishu: model-select updateCardInstance failed: ${msg} — sending fresh card`)
      const fresh = await sendModelCardV2(channel, chatMessage, card, cardByMessage, sequenceByCard, cardTopics)
      cardByMessage.set(fresh.messageId, fresh.cardId)
      // The old card could not be updated — retire it so its buttons do not
      // keep looking live next to the fresh one. Best-effort.
      const seq = (sequenceByCard.get(cardId) ?? 0) + 1
      sequenceByCard.set(cardId, seq)
      await channel.updateCardInstance(cardId, renderSupersededCard(getTranslations()), seq).catch((retireError: unknown) => {
        const retireMsg = retireError instanceof Error ? retireError.message : String(retireError)
        logger.warn(`dsh-feishu: could not mark model-select card ${cardId} as superseded: ${retireMsg}`)
      })
    }
  }

  /** Step 1 → Step 2: provider selected, load its models. */
  async function handleSelectProvider(
    chatMessage: ConversationMessage,
    messageId: string | undefined,
    provider: string,
    flow?: ModelCardFlow,
  ): Promise<void> {
    const bridge = bridgeHolder.current
    if (bridge === undefined) return
    const current = await resolveCurrent(chatMessage, flow)

    const { models, reasoning } = await discoverModels(provider)

    // Resolve the model's actual supported reasoning efforts.
    // Prefer the session's current model if it belongs to this provider,
    // else the first model in the list. pi-ai typically has uniform effort
    // sets within a provider, so this covers the whole provider well.
    const defaultForEfforts = models.find(m => m.id === current.model) ?? models[0]
    let supportedEfforts: readonly { id: string; name?: string }[] = []
    let modelDefaultEffort: string | undefined
    if (defaultForEfforts !== undefined) {
      const info = await reasoning(defaultForEfforts.id)
      if (info !== undefined && info.efforts.length > 0) {
        supportedEfforts = info.efforts
        modelDefaultEffort = info.defaultEffort
      }
    }

    const providers = await discoverProviders()
    // The dropdown must open on a model that BELONGS to the provider just
    // picked. Handing it the session's current model blindly produced a
    // `select_static` whose value is not among its own options whenever the
    // operator switched providers (e.g. current `deepseek-official/…` while
    // picking `minimax-cn`): the dropdown rendered empty, the form submitted no
    // `model`, and the confirm silently did nothing at all — which is how a
    // `/new` flow died one step before its confirmation card, with no card, no
    // error and no log.
    const initialModel = models.find(m => m.id === current.model)?.id ?? models[0]?.id ?? current.model
    const card = renderModelSelectCard(providers, models, provider, initialModel, current.reasoningEffort, supportedEfforts, modelDefaultEffort, flow, getTranslations())
    await updateCardInstanceOnMessage(messageId, chatMessage, card)
  }

  /**
   * Build the step-1 (provider) card for `chatMessage`.
   *
   * Always includes the same three sections — the route in effect, the
   * "previous model" quick action and the GLOBAL recently-used rows — for the
   * standalone `/model` flow and for the `/new` model step alike; only the
   * wording and what a pick DOES differ (see renderProviderSelectCard).
   */
  async function renderProviderCard(chatMessage: ConversationMessage, flow?: ModelCardFlow): Promise<object> {
    const current = await resolveCurrent(chatMessage, flow)
    const providers = await discoverProviders()
    const lastUsed = await lastUsedRoute(chatMessage, current)
    const recent = await recentModelChoices(chatMessage)
    return renderProviderSelectCard(providers, current, flow, getTranslations(), { lastUsed, recent })
  }

  /** Step 2 → Step 1: back button (form reset). */
  async function handleGoBack(
    chatMessage: ConversationMessage,
    messageId: string | undefined,
    flow?: ModelCardFlow,
  ): Promise<void> {
    const bridge = bridgeHolder.current
    if (bridge === undefined) return
    await updateCardInstanceOnMessage(messageId, chatMessage, await renderProviderCard(chatMessage, flow))
  }

  /**
   * A quick pick on the `/new` model card CHOOSES the route of the session that
   * is about to be created. It must not touch the session that is running (no
   * `switchRoute`, no global default) — the caller collects the choice into the
   * final confirmation card, where creating the session is still an explicit
   * tap (`src/new-session-card.ts`).
   */
  async function commitNewSessionRoute(
    chatMessage: ConversationMessage,
    messageId: string | undefined,
    route: { provider: string; model: string; reasoningEffort?: string | undefined },
  ): Promise<void> {
    if (onNewSessionConfirm === undefined) {
      logger.warn('dsh-feishu: new-session quick pick received but no onNewSessionConfirm callback registered')
      return
    }
    await onNewSessionConfirm(chatMessage, {
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined || route.reasoningEffort === ''
        ? {}
        : { reasoningEffort: route.reasoningEffort }),
    }, messageId)
  }

  /** Quick action: switch back to the previous route of THIS session only. */
  async function handleSwitchLast(
    chatMessage: ConversationMessage,
    messageId: string | undefined,
    flow?: ModelCardFlow,
  ): Promise<void> {
    const t = getTranslations()
    const bridge = bridgeHolder.current
    if (bridge === undefined) return
    if (flow === 'new-session') {
      const target = await lastUsedRoute(chatMessage, newSessionCurrent())
      if (target === undefined) {
        logger.info('dsh-feishu: new-session quick pick has no previous route to reuse')
        return
      }
      await commitNewSessionRoute(chatMessage, messageId, target)
      return
    }
    const current = await resolveCurrent(chatMessage)
    const target = await lastUsedRoute(chatMessage, current)
    if (target === undefined) {
      logger.info('dsh-feishu: model-select switch-last has no previous route to go back to')
      return
    }
    const outcome = await bridge.switchRoute(chatMessage, target)
    if (!outcome.ok) {
      const reason = outcome.reason === 'no-agent'
        ? t.modelSelectLastUsedFailedNoSession
        : outcome.reason === 'rejected' && outcome.detail !== undefined
          ? outcome.detail
          : t.modelSelectLastUsedFailedUnsupported
      const card = {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: t.modelSelectTitle(false) }, template: 'red' },
        body: { elements: [{ tag: 'markdown', content: t.modelSelectLastUsedFailed(reason) }] },
      }
      await updateCardInstanceOnMessage(messageId, chatMessage, card as object)
      return
    }
    let modelName: string | undefined
    try {
      const discovered = await discoverModels(target.provider)
      modelName = discovered.models.find(entry => entry.id === target.model)?.name
    } catch {
      modelName = undefined
    }
    const card = renderSwitchedCard(target.provider, target.model, modelName, target.reasoningEffort, t) as { body: { elements: object[] } }
    // Say plainly that this did NOT touch the global default: the old failure
    // mode was a quick pick silently becoming every session's model.
    card.body.elements.push({ tag: 'markdown', content: t.modelSelectLastUsedSwitched })
    await updateCardInstanceOnMessage(messageId, chatMessage, card)
  }

  /** Quick row: switch to one of the GLOBAL recently used models, session-locally.
   *  On the `/new` card the same row instead becomes the new session's route. */
  async function handleSwitchRecent(
    chatMessage: ConversationMessage,
    messageId: string | undefined,
    provider: string,
    model: string,
    reasoningEffort?: string,
    flow?: ModelCardFlow,
  ): Promise<void> {
    const t = getTranslations()
    const bridge = bridgeHolder.current
    if (bridge === undefined) return
    const providers = new Set((await discoverProviders()).map(entry => entry.id))
    if (!providers.has(provider)) {
      logger.warn(`dsh-feishu: model-select recent row names unknown provider ${provider}`)
      if (flow === 'new-session') {
        // Silence is the worst answer here: the row is gone but the operator
        // must not be left staring at a dead card.
        await updateCardInstanceOnMessage(messageId, chatMessage, {
          schema: '2.0',
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: t.modelSelectNewSessionTitle }, template: 'red' },
          body: { elements: [{ tag: 'markdown', content: t.newSessionRouteUnavailable }] },
        })
      }
      return
    }
    if (flow === 'new-session') {
      await commitNewSessionRoute(chatMessage, messageId, {
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      })
      return
    }
    const outcome = await bridge.switchRoute(chatMessage, {
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    })
    if (!outcome.ok) {
      const reason = outcome.reason === 'no-agent'
        ? t.modelSelectLastUsedFailedNoSession
        : outcome.reason === 'rejected' && outcome.detail !== undefined
          ? outcome.detail
          : t.modelSelectLastUsedFailedUnsupported
      const card = {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: t.modelSelectTitle(false) }, template: 'red' },
        body: { elements: [{ tag: 'markdown', content: t.modelSelectLastUsedFailed(reason) }] },
      }
      await updateCardInstanceOnMessage(messageId, chatMessage, card as object)
      return
    }
    let modelName: string | undefined
    try {
      const discovered = await discoverModels(provider)
      modelName = discovered.models.find(entry => entry.id === model)?.name
    } catch {
      modelName = undefined
    }
    const card = renderSwitchedCard(provider, model, modelName, reasoningEffort, t) as { body: { elements: object[] } }
    card.body.elements.push({ tag: 'markdown', content: t.modelSelectRecentSwitched })
    await updateCardInstanceOnMessage(messageId, chatMessage, card)
  }

  /** Quick effort switch: same provider/model, new reasoning effort, this session only. */
  async function handleSwitchEffort(chatMessage: ConversationMessage, messageId: string | undefined, effort: string): Promise<void> {
    const t = getTranslations()
    const bridge = bridgeHolder.current
    if (bridge === undefined) return
    const current = await resolveCurrent(chatMessage)
    const discovered = await discoverModels(current.provider)
    const supported = await discovered.reasoning(current.model).catch(() => undefined)
    const effortIds = supported?.efforts.map(entry => entry.id) ?? []
    if (effortIds.length > 0 && !effortIds.includes(effort)) {
      logger.warn(`dsh-feishu: reasoning switch to unsupported effort ${effort}`)
      return
    }
    const outcome = await bridge.switchRoute(chatMessage, {
      provider: current.provider,
      model: current.model,
      reasoningEffort: effort,
    })
    const card = outcome.ok
      ? {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: t.reasoningCardTitle }, template: 'green' },
        body: { elements: [{ tag: 'markdown', content: t.reasoningCardSwitched(effort) }] },
      }
      : {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: t.reasoningCardTitle }, template: 'red' },
        body: { elements: [{ tag: 'markdown', content: outcome.reason === 'no-agent'
          ? t.reasoningCardNoAgent
          : outcome.reason === 'rejected' && outcome.detail !== undefined
            ? outcome.detail
            : t.reasoningCardUnsupported }] },
      }
    await updateCardInstanceOnMessage(messageId, chatMessage, card as object)
  }

  /** The global+session shortlist for this chat (current route included, marked). */
  async function recentModelChoices(chatMessage: ConversationMessage): Promise<readonly RecentModelEntry[]> {
    const bridge = bridgeHolder.current
    if (bridge === undefined) return []
    return bridge.recentModelChoices(chatMessage)
  }

  /** Step 3: confirm button clicked, apply the selection. */
  async function handleConfirmSelect(
    chatMessage: ConversationMessage,
    messageId: string | undefined,
    provider: string,
    model: string,
    reasoningEffort?: string,
    flow?: ModelCardFlow,
  ): Promise<void> {
    const bridge = bridgeHolder.current
    if (bridge === undefined) return

    // New-session flow: the card is part of `/new` session creation — commit
    // the selection to the caller (which creates the session) instead of
    // switching the current chat's model.
    if (flow === 'new-session') {
      if (onNewSessionConfirm === undefined) {
        logger.warn('dsh-feishu: new-session confirm received but no onNewSessionConfirm callback registered')
        return
      }
      await onNewSessionConfirm(chatMessage, { provider, model, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) }, messageId)
      return
    }

    const providers = new Set((await discoverProviders()).map(p => p.id))
    if (!providers.has(provider)) {
      logger.warn(`dsh-feishu: model-select attempted to switch to unknown provider ${provider}`)
      return
    }

    // Get model name and resolve its actual supported efforts (non-fatal).
    let modelName: string | undefined
    let supportedEffortIds: string[] | undefined
    let modelDefaultEffort: string | undefined
    const discovered = await discoverModels(provider)
    modelName = discovered.models.find(m => m.id === model)?.name
    const reasoning = await discovered.reasoning(model)
    if (reasoning !== undefined && reasoning.efforts.length > 0) {
      supportedEffortIds = reasoning.efforts.map(e => e.id)
      modelDefaultEffort = reasoning.defaultEffort
    }

    // Auto-downgrade: if the chosen effort isn't supported by this model,
    // fall back to the model's default effort, then to undefined (no override).
    let effectiveReasoningEffort = reasoningEffort
    if (supportedEffortIds !== undefined) {
      if (reasoningEffort !== undefined && reasoningEffort !== 'default') {
        if (!supportedEffortIds.includes(reasoningEffort)) {
          effectiveReasoningEffort = (modelDefaultEffort !== undefined && supportedEffortIds.includes(modelDefaultEffort))
            ? modelDefaultEffort
            : undefined
        }
      } else {
        // 'default' or undefined → omit (no override).
        effectiveReasoningEffort = undefined
      }
    }

    // Atomic model switch via session controller: resolves the session
    // (creating the live agent if needed), validates the model, writes the
    // agent-scoped selection ref so the WebUI sees the change immediately,
    // AND persists the default selection. No two-step fallback needed.
    try {
      const sessionId = bridge.resolveSessionIdFor(chatMessage)
      await sessionController.selectModel({
        sessionId,
        provider,
        model,
        ...(effectiveReasoningEffort !== undefined ? { reasoningEffort: effectiveReasoningEffort } : {}),
      })
      bridge.rememberModelRoute({
        provider,
        model,
        ...(effectiveReasoningEffort !== undefined ? { reasoningEffort: effectiveReasoningEffort } : {}),
      })
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.warn(`dsh-feishu: model-select failed: ${msg}`)
      const card = {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: getTranslations().modelSelectTitle(false) }, template: 'red' },
        body: { elements: [{ tag: 'markdown', content: `${getTranslations().modelSelectFailHeader}\n\n${msg}` }] },
      }
      await updateCardInstanceOnMessage(messageId, chatMessage, card)
      return
    }

    // Step 3: Show success card.
    const card = renderSwitchedCard(provider, model, modelName, effectiveReasoningEffort, getTranslations())
    await updateCardInstanceOnMessage(messageId, chatMessage, card)
  }

  /**
   * Send the `/new` flow's step-1 model card.
   *
   * The preset step calls this instead of rendering its own provider card, so
   * the `/new` model step and `/model` cannot drift apart: both show the route
   * in effect, the previous-model quick action and the global recently-used
   * rows, and both send through the same card bookkeeping (the card id map
   * that later in-place updates and retirements rely on).
   */
  async function sendNewSessionProviderCard(chatMessage: ConversationMessage): Promise<{ messageId: string; cardId: string }> {
    const card = await renderProviderCard(chatMessage, 'new-session')
    return sendModelCardV2(channel, chatMessage, card, cardByMessage, sequenceByCard, cardTopics)
  }

  const onCardAction = async (evt: CardActionLike): Promise<void> => {
    const parsed = parseCardAction(evt)
    if (parsed === undefined) return

    const bridge = bridgeHolder.current
    if (bridge === undefined) {
      logger.warn('dsh-feishu: model-select card action received but bridge is not ready')
      return
    }

    const chatMessage = chatMessageFromEvent(evt)
    if (chatMessage === undefined) {
      logger.warn('dsh-feishu: model-select card action missing chatId')
      return
    }

    // Card actions carry only chatId + messageId; restore the topic context
    // recorded when the card was sent so selections and `new-session` commits
    // target the topic's key instead of the main chat's.
    const topic = topicFor?.({ chatId: chatMessage.chatId, ...(evt.messageId !== undefined ? { messageId: evt.messageId } : {}) })
    if (topic?.threadId !== undefined && chatMessage.threadId === undefined) {
      chatMessage.threadId = topic.threadId
      if (topic.rootId !== undefined) chatMessage.rootId = topic.rootId
    }

    const key = chatMessage.chatId
    let queue = actionQueue.get(key)
    if (queue === undefined) {
      queue = []
      actionQueue.set(key, queue)
    }
    queue.push({ action: parsed.action, flow: parsed.flow, chatMessage, messageId: evt.messageId })
    await drainQueue(key)
  }

  async function drainQueue(key: string): Promise<void> {
    if (processing.has(key)) return
    processing.set(key, true)
    try {
      const queue = actionQueue.get(key)
      if (queue === undefined) return
      while (queue.length > 0) {
        const item = queue.shift()!
        try {
          switch (item.action.type) {
            case 'enter-select': {
              const bridge = bridgeHolder.current
              if (bridge === undefined) break
              await updateCardInstanceOnMessage(item.messageId, item.chatMessage, await renderProviderCard(item.chatMessage, item.flow))
              break
            }
            case 'select-provider':
              await handleSelectProvider(item.chatMessage, item.messageId, item.action.provider, item.flow)
              break
            case 'go-back':
              await handleGoBack(item.chatMessage, item.messageId, item.flow)
              break
            case 'switch-last':
              await handleSwitchLast(item.chatMessage, item.messageId, item.flow)
              break
            case 'switch-recent':
              await handleSwitchRecent(item.chatMessage, item.messageId, item.action.provider, item.action.model, item.action.reasoningEffort, item.flow)
              break
            case 'switch-effort':
              await handleSwitchEffort(item.chatMessage, item.messageId, item.action.effort)
              break
            case 'confirm-select':
              await handleConfirmSelect(item.chatMessage, item.messageId, item.action.provider, item.action.model, item.action.reasoningEffort, item.flow)
              break
          }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error)
          logger.error(`dsh-feishu: model-select action failed: ${msg}`)
        }
        if (queue.length > 0) {
          await new Promise<void>(r => setTimeout(r, MIN_UPDATE_INTERVAL_MS))
        }
      }
    } finally {
      processing.delete(key)
      actionQueue.delete(key)
    }
  }

  const unsubscribe = channel.onCardAction(onCardAction)
  return {
    dispose: () => {
      unsubscribe()
      processing.clear()
      actionQueue.clear()
    },
    cardByMessage,
    sequenceByCard,
    sendNewSessionProviderCard,
  }
}
