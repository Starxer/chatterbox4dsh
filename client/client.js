window.__ModuleLoader__.load({ id: "@starxer/chatterbox4dsh", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp$1 = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp$1 = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp$1.call(to, key) && key !== except) __defProp$1(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp$1(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);
let __deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
__deepseek_ai_dsh_client_ui_primitives = __toESM(__deepseek_ai_dsh_client_ui_primitives);
let react_jsx_runtime = require("react/jsx-runtime");
react_jsx_runtime = __toESM(react_jsx_runtime);

//#region src/client/snapshot-store.ts
/** One published snapshot plus its listener set. */
var SnapshotStore = class {
	listeners = /* @__PURE__ */ new Set();
	snapshot;
	/** @param initial - first published state. */
	constructor(initial) {
		this.snapshot = initial;
	}
	/** @returns the current snapshot, stable until the next publish. */
	getSnapshot = () => this.snapshot;
	/** @param listener - invoked after each publish. @returns the disposer. */
	subscribe = (listener) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	/** @param next - replacement state; notifies only when the reference changes. */
	set(next) {
		if (next === this.snapshot) return;
		this.snapshot = next;
		for (const listener of [...this.listeners]) listener();
	}
};

//#endregion
//#region src/client/LarkSettingsCardController.ts
/** The levels in the order the DSH settings page lists them. */
const TRANSCRIPT_VIEWS = [
	"compact",
	"standard",
	"detailed",
	"verbose"
];
/**
* Read one stored level. The WebUI's two legacy spellings (`normal`,
* `expanded`) both mean `detailed` in 0.2.0, and a value this page cannot
* recognize must not silently render as "compact" — so anything unknown falls
* back to the default too.
*/
function parseTranscriptView(value) {
	if (value === "normal" || value === "expanded") return "detailed";
	return typeof value === "string" && TRANSCRIPT_VIEWS.includes(value) ? value : "detailed";
}
/** The modes in the order the page lists them (most useful first). */
const PRODUCE_CARD_MODES = [
	"delivery",
	"summary",
	"off"
];
/** Read one stored mode; anything unrecognized falls back to the default. */
function parseProduceCardMode(value) {
	return typeof value === "string" && PRODUCE_CARD_MODES.includes(value) ? value : "delivery";
}
/**
* Namespace of this plugin's Host entry (`options.id`): the profile row id,
* which is what `settings.describe()` keys every descriptor on. Spelled here
* rather than imported — the client half must not depend on a Host module.
*/
const LARK_SETTINGS_NAMESPACE = "lark-channel";
/** Credential reference the plugin resolves when the section names none. */
const LARK_APP_SECRET_REF = "DSH_LARK_APP_SECRET";
/**
* Bounds of the per-card media limit, mirroring `CARD_MEDIA_LIMIT` in
* `src/config.ts`.
*
* Deliberately repeated: this bundle includes no Host module (it would drag the
* config schema and zod into the browser), and the Host schema is what really
* enforces them. These numbers only keep the input usable and the staged value
* sane before it is written.
*/
const CARD_MEDIA_LIMIT = {
	min: 1,
	max: 30,
	default: 12
};
/** Clamp a staged media limit the way the Host schema would. */
function clampCardMediaLimit(value) {
	if (!Number.isFinite(value)) return CARD_MEDIA_LIMIT.default;
	return Math.min(CARD_MEDIA_LIMIT.max, Math.max(CARD_MEDIA_LIMIT.min, Math.trunc(value)));
}
/**
* Bounds and defaults of the three auto-inline SIZE limits (MB), mirroring
* `CARD_MEDIA_MAX_MB` in `src/config.ts`.
*
* The maxima are Feishu's upload ceilings: an image over 10 MB cannot come from
* `im.v1.image.create`, and video/audio over 30 MB cannot come from
* `im.v1.file.create`, so a larger number could never take effect.
*/
const CARD_MEDIA_MAX_MB = {
	cardImageMaxMb: {
		min: 1,
		max: 10,
		default: 10
	},
	cardVideoMaxMb: {
		min: 1,
		max: 30,
		default: 15
	},
	cardAudioMaxMb: {
		min: 1,
		max: 30,
		default: 15
	}
};
/**
* Bounds and default of `deliverDocMaxMb`, mirroring `DELIVER_DOC_MAX_MB` in
* `src/config.ts`: how large a whitelisted document (pdf/doc/docx/ppt/pptx/
* xls/xlsx) may be before `present` stops delivering it by itself and offers a
* confirmation row instead.
*/
const DELIVER_DOC_MAX_MB = {
	min: 1,
	max: 30,
	default: 30
};
/**
* Bounds and defaults of the three PREVIEW character caps, mirroring
* `PREVIEW_CHARS` in `src/config.ts`.
*
* They are one family: how much of a long block shows before it is cut
* (reasoning head, tool result, tool arguments). The maxima keep one block well
* inside the card's ~30 KB budget.
*/
const PREVIEW_CHARS = {
	reasoningPreviewChars: {
		min: 80,
		max: 4e3,
		default: 200
	},
	resultPreviewChars: {
		min: 200,
		max: 6e3,
		default: 1500
	},
	argsPreviewChars: {
		min: 200,
		max: 6e3,
		default: 2e3
	}
};
/** Clamp one staged preview cap; blank/unparsable falls back to its default. */
function clampPreviewChars(field, raw) {
	const bounds = PREVIEW_CHARS[field];
	const text = raw.trim();
	if (text === "") return bounds.default;
	const value = Number(text);
	if (!Number.isFinite(value)) return bounds.default;
	return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(value)));
}
/** Clamp the staged document auto-delivery limit the way the Host schema would. */
function clampDeliverDocMaxMb(raw) {
	const text = raw.trim();
	if (text === "") return DELIVER_DOC_MAX_MB.default;
	const value = Number(text);
	if (!Number.isFinite(value)) return DELIVER_DOC_MAX_MB.default;
	return Math.min(DELIVER_DOC_MAX_MB.max, Math.max(DELIVER_DOC_MAX_MB.min, Math.trunc(value)));
}
/**
* Parse and clamp one staged size field.
*
* A blank field means "the user cleared it" and falls back to that field's own
* default rather than to the minimum; anything unparsable does the same, so a
* save can never write `NaN`, `0` or a value the Host would refuse.
*/
function clampCardMediaMaxMb(field, raw) {
	const bounds = CARD_MEDIA_MAX_MB[field];
	const text = raw.trim();
	if (text === "") return bounds.default;
	const value = Number(text);
	if (!Number.isFinite(value)) return bounds.default;
	return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(value)));
}
/** The field order every save walks; also the only keys a save may write. */
const EDITABLE_FIELDS = [
	"appId",
	"domain",
	"requireMention",
	"dmMode",
	"groupAllowlist",
	"dmAllowlist",
	"reactEmoji",
	"showReasoning",
	"showToolCalls",
	"showToolArgs",
	"showToolResults",
	"transcriptView",
	"locale",
	"cardImages",
	"cardMediaLimit",
	"cardImageMaxMb",
	"cardVideoMaxMb",
	"cardAudioMaxMb",
	"deliverDocMaxMb",
	"reasoningPreviewChars",
	"resultPreviewChars",
	"argsPreviewChars",
	"produceCard"
];
/** Bridges the `lark-channel` form and the credentials domain onto the page. */
var LarkSettingsCardController = class {
	store;
	unsubscribeScope;
	/** Fields the user edited since the last load; absent keys keep the Host value. */
	edits = {};
	/** Staged secret literal; blank means "keep whatever the Host holds". */
	secretText = "";
	credential = {
		ref: "",
		configured: false,
		writable: true
	};
	busy = false;
	noticeKey;
	noticeDetail;
	/**
	* @param scope - the bound `lark-channel` settings form.
	* @param host - the page plugin's context slice owning `remote.credentials`.
	* @param t - the plugin's dictionary translator.
	*/
	constructor(scope, host, t) {
		this.scope = scope;
		this.host = host;
		this.t = t;
		this.store = new SnapshotStore(this.projection());
		this.unsubscribeScope = scope.subscribe(() => {
			this.onScopeChange();
		});
		this.onScopeChange();
	}
	/**
	* Build the face the page's slot registration injects.
	* @returns the page's snapshot observable and its actions.
	*/
	inject() {
		return {
			hooks: { larkSettings: this.store },
			edit: (field, value) => {
				this.edit(field, value);
			},
			setSecret: (value) => {
				this.setSecret(value);
			},
			save: () => this.save(),
			removeSecret: () => this.removeSecret()
		};
	}
	/**
	* Stage one edited control.
	* @param field - control key.
	* @param value - staged value.
	*/
	edit(field, value) {
		const edits = { ...this.edits };
		edits[field] = value;
		this.edits = edits;
		this.clearNotice();
		this.publish();
	}
	/**
	* Stage the secret literal. Leaving it blank never clears a stored secret;
	* the separate remove control is the only way to clear one.
	* @param value - staged literal.
	*/
	setSecret(value) {
		this.secretText = value;
		this.clearNotice();
		this.publish();
	}
	/**
	* Write every edited field in one revision-fenced mutate, then the staged
	* secret when the user typed one. A refused mutate leaves the edits staged
	* for a retry and does not write the secret.
	* @returns a promise settling when the save attempt is reported.
	*/
	async save() {
		if (this.busy) return;
		this.busy = true;
		this.noticeKey = "saving";
		this.noticeDetail = void 0;
		this.publish();
		try {
			const ops = this.buildOps();
			const accepted = ops.length === 0 ? true : await this.scope.mutate(ops, this.scope.getSnapshot().revision);
			let secretWritten = true;
			if (accepted && this.secretText !== "") secretWritten = await this.writeSecret();
			if (accepted && secretWritten) {
				this.edits = {};
				this.secretText = "";
				this.noticeKey = "saved";
				this.noticeDetail = void 0;
			} else this.noticeKey = "saveFailed";
		} catch (error) {
			this.noticeKey = "saveFailed";
			this.noticeDetail = messageOf$1(error);
		} finally {
			this.busy = false;
			this.publish();
		}
	}
	/**
	* Clear the stored credential through the credentials domain, then re-read
	* whether the Host still holds one.
	* @returns a promise settling when the attempt is reported.
	*/
	async removeSecret() {
		if (this.busy) return;
		this.busy = true;
		this.noticeKey = "removing";
		this.noticeDetail = void 0;
		this.publish();
		try {
			const response = await this.host.remote.credentials.unset(this.credentialRef());
			if (!response.ok) throw new Error(response.error.message);
			await this.readCredential();
			this.noticeKey = "removed";
		} catch (error) {
			this.noticeKey = "removeFailed";
			this.noticeDetail = messageOf$1(error);
		} finally {
			this.busy = false;
			this.publish();
		}
	}
	/**
	* Re-read after the Host reports a change to the reference this page watches.
	* @param ref - the reference the Host reports as changed.
	*/
	refreshCredential(ref) {
		if (ref !== this.credential.ref) return;
		this.readCredential();
	}
	/**
	* Re-read the credential the section currently names.
	*
	* The scan-to-configure flow completes on another surface (the Plugins detail
	* page) and the Host writes the secret there, so the badge has to be told.
	*/
	rereadCredential() {
		this.readCredential();
	}
	/** Release the form subscription. */
	dispose() {
		this.unsubscribeScope();
	}
	/** Re-read the credential when the reference the section names changes. */
	async onScopeChange() {
		const ref = this.credentialRef();
		if (ref !== this.credential.ref) {
			this.credential = {
				ref,
				configured: false,
				writable: true
			};
			this.publish();
			await this.readCredential();
			return;
		}
		this.publish();
	}
	/**
	* Ask the credentials domain about the reference the section currently
	* names. The answer is stored with the reference it describes, so a stale
	* response for another reference is dropped.
	*/
	async readCredential() {
		const ref = this.credentialRef();
		try {
			const response = await this.host.remote.credentials.describe([ref]);
			if (!response.ok || ref !== this.credentialRef()) return;
			const view = response.value[ref];
			const source = view?.source;
			this.credential = {
				ref,
				configured: view?.configured ?? false,
				writable: view?.writable ?? true,
				...source !== void 0 ? { source } : {}
			};
			this.publish();
		} catch {}
	}
	/** @returns the credential reference the section names, or the plugin default. */
	credentialRef() {
		const declared = this.scope.getSnapshot().value?.appSecretRef;
		return declared !== void 0 && declared.length > 0 ? declared : LARK_APP_SECRET_REF;
	}
	/** @returns the operations for exactly the fields the user edited. */
	buildOps() {
		const form = this.formValues();
		const ops = [];
		for (const field of EDITABLE_FIELDS) {
			if (!Object.hasOwn(this.edits, field)) continue;
			ops.push({
				op: "set",
				path: [field],
				value: writeValue(field, form)
			});
		}
		return ops;
	}
	/**
	* Write the staged secret, then re-read whether the Host now holds one.
	* @returns whether the credentials domain accepted the write.
	*/
	async writeSecret() {
		const response = await this.host.remote.credentials.set(this.credentialRef(), this.secretText);
		await this.readCredential();
		if (!response.ok) {
			this.noticeDetail = response.error.message;
			return false;
		}
		return this.credential.configured;
	}
	/** @returns the staged form values, defaults and Host values folded under the edits. */
	formValues() {
		const value = this.scope.getSnapshot().value;
		return {
			appId: value?.appId ?? "",
			domain: value?.domain ?? "feishu",
			requireMention: value?.requireMention ?? true,
			dmMode: value?.dmMode ?? "open",
			groupAllowlist: (value?.groupAllowlist ?? []).join("\n"),
			dmAllowlist: (value?.dmAllowlist ?? []).join("\n"),
			reactEmoji: value?.reactEmoji ?? "",
			showReasoning: value?.showReasoning ?? true,
			showToolCalls: value?.showToolCalls ?? true,
			showToolArgs: value?.showToolArgs ?? true,
			showToolResults: value?.showToolResults ?? true,
			transcriptView: parseTranscriptView(value?.transcriptView),
			locale: value?.locale ?? "auto",
			cardImages: value?.cardImages ?? "workspace",
			cardMediaLimit: String(value?.cardMediaLimit ?? CARD_MEDIA_LIMIT.default),
			cardImageMaxMb: String(value?.cardImageMaxMb ?? CARD_MEDIA_MAX_MB.cardImageMaxMb.default),
			cardVideoMaxMb: String(value?.cardVideoMaxMb ?? CARD_MEDIA_MAX_MB.cardVideoMaxMb.default),
			cardAudioMaxMb: String(value?.cardAudioMaxMb ?? CARD_MEDIA_MAX_MB.cardAudioMaxMb.default),
			deliverDocMaxMb: String(value?.deliverDocMaxMb ?? DELIVER_DOC_MAX_MB.default),
			reasoningPreviewChars: String(value?.reasoningPreviewChars ?? PREVIEW_CHARS.reasoningPreviewChars.default),
			resultPreviewChars: String(value?.resultPreviewChars ?? PREVIEW_CHARS.resultPreviewChars.default),
			argsPreviewChars: String(value?.argsPreviewChars ?? PREVIEW_CHARS.argsPreviewChars.default),
			produceCard: parseProduceCardMode(value?.produceCard),
			...this.edits
		};
	}
	/** @returns the published page state. */
	projection() {
		const snapshot = this.scope.getSnapshot();
		const source = this.credential.source;
		return {
			status: snapshot.status,
			writable: snapshot.writable,
			form: this.formValues(),
			secret: {
				value: this.secretText,
				configured: this.credential.configured,
				writable: this.credential.writable,
				...source !== void 0 ? { source } : {}
			},
			busy: this.busy,
			notice: this.noticeText()
		};
	}
	/** @returns the localized notice line. */
	noticeText() {
		const head = this.noticeKey === void 0 ? "" : this.t(this.noticeKey);
		if (this.noticeDetail === void 0 || this.noticeDetail === "") return head;
		return head === "" ? this.noticeDetail : `${head}: ${this.noticeDetail}`;
	}
	/** Drop any staged notice (edits and discards invalidate it). */
	clearNotice() {
		this.noticeKey = void 0;
		this.noticeDetail = void 0;
	}
	/** Publish a fresh projection. */
	publish() {
		this.store.set(this.projection());
	}
};
/** @param value - one staged form value. @returns its wire shape for a `set` op. */
function writeValue(field, form) {
	switch (field) {
		case "appId": return form.appId.trim();
		case "cardMediaLimit": {
			const raw = form.cardMediaLimit.trim();
			return raw === "" ? CARD_MEDIA_LIMIT.default : clampCardMediaLimit(Number(raw));
		}
		case "cardImageMaxMb":
		case "cardVideoMaxMb":
		case "cardAudioMaxMb": return clampCardMediaMaxMb(field, form[field]);
		case "deliverDocMaxMb": return clampDeliverDocMaxMb(form.deliverDocMaxMb);
		case "reasoningPreviewChars":
		case "resultPreviewChars":
		case "argsPreviewChars": return clampPreviewChars(field, form[field]);
		case "groupAllowlist": return lines(form.groupAllowlist);
		case "dmAllowlist": return lines(form.dmAllowlist);
		default: return form[field];
	}
}
/** @param value - textarea content. @returns trimmed non-empty lines. */
function lines(value) {
	return value.split(/\n/u).map((item) => item.trim()).filter(Boolean);
}
/** @param error - a thrown value. @returns its message. */
function messageOf$1(error) {
	return error instanceof Error ? error.message : String(error);
}

//#endregion
//#region src/client/LarkSettingsCard.tsx
/**
* Render the plugin's one-liner or its settings page, as the Plugins page asks.
* @param props - the view asked for, locale copy, the form snapshot, and its actions.
* @returns the one-liner, or the settings page.
*/
function LarkSettingsCard(props) {
	const { t } = props;
	const state = props.useLarkSettings((snapshot) => snapshot);
	if (props.view === "summary") return t("subtitle");
	const form = state.form;
	const blocked = !state.writable;
	const toolsOff = !form.showToolCalls;
	/**
	* One numeric row of the three inline size limits. Bounds come from the
	* shared table so a field cannot drift from what the Host schema accepts.
	*/
	const mediaMaxRow = (field, label, hint) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Input, {
			"aria-label": field,
			type: "number",
			min: CARD_MEDIA_MAX_MB[field].min,
			max: CARD_MEDIA_MAX_MB[field].max,
			step: 1,
			inputMode: "numeric",
			disabled: blocked,
			value: form[field],
			onChange: (event) => {
				props.edit(field, event.target.value);
			}
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: "dsh-feishu-toggle-hint",
			children: hint
		})
	] });
	/** One numeric row of the three preview caps (reasoning / result / args). */
	const previewCharsRow = (field, label, hint) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Input, {
			"aria-label": field,
			type: "number",
			min: PREVIEW_CHARS[field].min,
			max: PREVIEW_CHARS[field].max,
			step: 1,
			inputMode: "numeric",
			disabled: blocked,
			value: form[field],
			onChange: (event) => {
				props.edit(field, event.target.value);
			}
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: "dsh-feishu-toggle-hint",
			children: hint
		})
	] });
	/** One labelled toggle row: title + one-line hint, control on the right. */
	const toggleRow = (options) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: options.nested === true ? "dsh-feishu-toggle dsh-feishu-toggle-nested" : "dsh-feishu-toggle",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
			className: "dsh-feishu-toggle-text",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dsh-feishu-toggle-label",
				children: options.label
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dsh-feishu-toggle-hint",
				children: options.hint
			})]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Switch, {
			checked: options.checked,
			onChange: options.onToggle,
			label: options.label,
			...options.disabled === true ? {
				disabled: true,
				...options.nested === true ? { title: t("requiresToolCalls") } : {}
			} : {}
		})]
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: "dsh-feishu-settings",
		"aria-labelledby": "dsh-feishu-title",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("header", {
				className: "dsh-feishu-header",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						id: "dsh-feishu-title",
						children: t("title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("subtitle") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dsh-feishu-pointer",
						children: t("connectionMoved")
					})
				] })
			}),
			state.status === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-feishu-loading",
				children: t("loading")
			}) : null,
			state.status !== "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
				onSubmit: (event) => {
					event.preventDefault();
					props.save();
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-feishu-card",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("application") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-feishu-grid",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("appId") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Input, {
									"aria-label": "appId",
									disabled: blocked,
									value: form.appId,
									onChange: (event) => {
										props.edit("appId", event.target.value);
									},
									autoComplete: "off"
								})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("domain") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									"aria-label": "domain",
									disabled: blocked,
									value: form.domain,
									onChange: (event) => {
										props.edit("domain", event.target.value);
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "feishu",
										children: "Feishu"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "lark",
										children: "Lark"
									})]
								})] })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("appSecret") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Input, {
								"aria-label": "appSecret",
								type: "password",
								disabled: blocked || !state.secret.writable,
								value: state.secret.value,
								onChange: (event) => {
									props.setSecret(event.target.value);
								},
								autoComplete: "new-password",
								placeholder: t("secretPlaceholder")
							})] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-feishu-credential",
								"aria-label": state.secret.configured ? t("credentialConfigured") : t("credentialMissing"),
								"data-state": state.secret.configured ? "configured" : "missing",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "dsh-feishu-credential-badge",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsh-feishu-credential-dot",
											"aria-hidden": "true"
										}), state.secret.configured ? t("credentialConfigured") : t("credentialMissing")]
									}),
									state.secret.source !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: state.secret.source }) : null,
									!state.secret.writable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("readOnly") }) : null
								]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-feishu-card",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("access") }),
							toggleRow({
								label: t("requireMention"),
								hint: t("requireMentionHint"),
								checked: form.requireMention,
								onToggle: (next) => {
									props.edit("requireMention", next);
								},
								disabled: blocked
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("dmMode") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								"aria-label": "dmMode",
								disabled: blocked,
								value: form.dmMode,
								onChange: (event) => {
									props.edit("dmMode", event.target.value);
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "open",
										children: t("open")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "allowlist",
										children: t("allowlist")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "disabled",
										children: t("disabled")
									})
								]
							})] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-feishu-grid",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("groupAllowlist") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									"aria-label": "groupAllowlist",
									disabled: blocked,
									value: form.groupAllowlist,
									onChange: (event) => {
										props.edit("groupAllowlist", event.target.value);
									},
									placeholder: t("onePerLine")
								})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("dmAllowlist") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									"aria-label": "dmAllowlist",
									disabled: blocked,
									value: form.dmAllowlist,
									onChange: (event) => {
										props.edit("dmAllowlist", event.target.value);
									},
									placeholder: t("onePerLine")
								})] })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("reactEmoji") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Input, {
								"aria-label": "reactEmoji",
								disabled: blocked,
								value: form.reactEmoji,
								onChange: (event) => {
									props.edit("reactEmoji", event.target.value);
								},
								placeholder: t("reactEmojiHint")
							})] })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-feishu-card",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("display") }),
							toggleRow({
								label: t("showReasoning"),
								hint: t("showReasoningHint"),
								checked: form.showReasoning,
								onToggle: (next) => {
									props.edit("showReasoning", next);
								},
								disabled: blocked
							}),
							toggleRow({
								label: t("showToolCalls"),
								hint: t("showToolCallsHint"),
								checked: form.showToolCalls,
								onToggle: (next) => {
									props.edit("showToolCalls", next);
								},
								disabled: blocked
							}),
							toggleRow({
								label: t("showToolArgs"),
								hint: t("showToolArgsHint"),
								checked: form.showToolArgs,
								onToggle: (next) => {
									props.edit("showToolArgs", next);
								},
								disabled: blocked || toolsOff,
								nested: true
							}),
							toggleRow({
								label: t("showToolResults"),
								hint: t("showToolResultsHint"),
								checked: form.showToolResults,
								onToggle: (next) => {
									props.edit("showToolResults", next);
								},
								disabled: blocked || toolsOff,
								nested: true
							}),
							previewCharsRow("reasoningPreviewChars", t("reasoningPreviewChars"), t("reasoningPreviewCharsHint")),
							previewCharsRow("resultPreviewChars", t("resultPreviewChars"), t("resultPreviewCharsHint")),
							previewCharsRow("argsPreviewChars", t("argsPreviewChars"), t("argsPreviewCharsHint")),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("transcriptView") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									"aria-label": "transcriptView",
									disabled: blocked,
									value: form.transcriptView,
									onChange: (event) => {
										props.edit("transcriptView", event.target.value);
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "compact",
											children: t("transcriptViewCompact")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "standard",
											children: t("transcriptViewStandard")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "detailed",
											children: t("transcriptViewDetailed")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "verbose",
											children: t("transcriptViewVerbose")
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsh-feishu-toggle-hint",
									children: t("transcriptViewHint")
								})
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("cardImages") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									"aria-label": "cardImages",
									disabled: blocked,
									value: form.cardImages,
									onChange: (event) => {
										props.edit("cardImages", event.target.value);
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "workspace",
											children: t("cardImagesWorkspace")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "text",
											children: t("cardImagesText")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "any",
											children: t("cardImagesAny")
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsh-feishu-toggle-hint",
									children: t("cardImagesHint")
								})
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("cardMediaLimit") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Input, {
									"aria-label": "cardMediaLimit",
									type: "number",
									min: CARD_MEDIA_LIMIT.min,
									max: CARD_MEDIA_LIMIT.max,
									step: 1,
									inputMode: "numeric",
									disabled: blocked,
									value: form.cardMediaLimit,
									onChange: (event) => {
										props.edit("cardMediaLimit", event.target.value);
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsh-feishu-toggle-hint",
									children: t("cardMediaLimitHint")
								})
							] }),
							mediaMaxRow("cardImageMaxMb", t("cardImageMaxMb"), t("cardImageMaxMbHint")),
							mediaMaxRow("cardVideoMaxMb", t("cardVideoMaxMb"), t("cardVideoMaxMbHint")),
							mediaMaxRow("cardAudioMaxMb", t("cardAudioMaxMb"), t("cardAudioMaxMbHint")),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("deliverDocMaxMb") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Input, {
									"aria-label": "deliverDocMaxMb",
									type: "number",
									min: DELIVER_DOC_MAX_MB.min,
									max: DELIVER_DOC_MAX_MB.max,
									step: 1,
									inputMode: "numeric",
									disabled: blocked,
									value: form.deliverDocMaxMb,
									onChange: (event) => {
										props.edit("deliverDocMaxMb", event.target.value);
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsh-feishu-toggle-hint",
									children: t("deliverDocMaxMbHint")
								})
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("produceCard") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									"aria-label": "produceCard",
									disabled: blocked,
									value: form.produceCard,
									onChange: (event) => {
										props.edit("produceCard", event.target.value);
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "delivery",
											children: t("produceCardDelivery")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "summary",
											children: t("produceCardSummary")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "off",
											children: t("produceCardOff")
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsh-feishu-toggle-hint",
									children: t("produceCardHint")
								})
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("locale") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								"aria-label": "locale",
								disabled: blocked,
								value: form.locale,
								onChange: (event) => {
									props.edit("locale", event.target.value);
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "auto",
										children: t("localeAuto")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "zh",
										children: t("localeZh")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "en",
										children: t("localeEn")
									})
								]
							})] })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("footer", {
						className: "dsh-feishu-actions",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "primary",
								type: "submit",
								disabled: state.busy || blocked,
								children: state.busy ? t("saving") : t("save")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								type: "button",
								disabled: state.busy || blocked || !state.secret.configured || !state.secret.writable,
								onClick: () => {
									props.removeSecret();
								},
								children: t("removeSecret")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								role: "status",
								"aria-live": "polite",
								children: state.notice
							})
						]
					})
				]
			}) : null
		]
	});
}

//#endregion
//#region src/client/LarkChannelStatusController.ts
/** The plugin's bounded HTTP route: channel runtime state plus provisioning. */
const CHANNEL_STATUS_PATH = "/dsh-feishu/provision";
/** Poll interval while the scan-to-configure flow is in flight. */
const PROVISION_POLL_MS = 2e3;
/**
* Poll interval for the live channel status while nothing is being configured.
*
* Slow on purpose: the read is a loopback JSON GET, but what it reports (the
* outbound link's verdict and the long connection's state) changes on the order
* of seconds at worst, and a page left open all day should not hammer the host
* for a badge. Bounded by the mounted entries, so it costs nothing when the
* detail page is closed.
*/
const CHANNEL_STATUS_POLL_MS = 1e4;
/** Bound on one channel-status request; a hung request must not pin a pending promise. */
const CHANNEL_STATUS_TIMEOUT_MS = 1e4;
/** Whether a provisioning run is still moving and therefore worth polling. */
function isProvisionActive(phase) {
	return phase === "waiting" || phase === "configuring";
}
/** Publishes the live channel status and drives the scan-to-configure flow. */
var LarkChannelStatusController = class {
	store;
	view;
	runtime = { state: "connecting" };
	provision = { phase: "idle" };
	loading = true;
	provisioning = false;
	statusFailed = false;
	noticeKey;
	noticeDetail;
	timer;
	/** Interval the live timer was armed with, so a retune only re-arms on change. */
	pollInterval;
	/**
	* True from the moment a status read shows a scan-to-configure run moving
	* until a poll observes it leave those phases. What makes the completion
	* callback fire ONCE, now that the status poll outlives the run.
	*/
	provisionWasActive = false;
	subscribers = 0;
	disposed = false;
	/**
	* @param t - the plugin's dictionary translator.
	* @param deps - plugin-side collaborators; every one is optional.
	*/
	constructor(t, deps = {}) {
		this.t = t;
		this.deps = deps;
		this.store = new SnapshotStore(this.projection());
		this.view = {
			getSnapshot: this.store.getSnapshot,
			subscribe: this.subscribe
		};
	}
	/**
	* Build the face the detail entries inject.
	* @returns the status observable and its actions.
	*/
	face() {
		return {
			hooks: { channelStatus: this.view },
			startProvision: () => this.startProvision()
		};
	}
	/**
	* Start the scan-to-configure flow and begin polling its progress.
	* @returns a promise settling when the start request is reported.
	*/
	async startProvision() {
		if (this.disposed) return;
		this.provisioning = true;
		this.clearNotice();
		this.publish();
		try {
			const response = await fetchChannelStatus({
				method: "POST",
				headers: { accept: "application/json" }
			});
			const value = await response.json();
			if (!response.ok) throw new Error(value.error ?? this.t("provisionFailed"));
			this.adoptStatus(value);
			this.loading = false;
			this.retunePolling();
		} catch (error) {
			this.noticeDetail = messageOf(error);
			this.noticeKey = void 0;
		} finally {
			this.provisioning = false;
			this.publish();
		}
	}
	/** Stop the provisioning poll; the route reads carry their own abort deadline. */
	dispose() {
		this.disposed = true;
		this.stopPolling();
	}
	/**
	* The view's `subscribe`: the first subscriber starts the read, the last one
	* ends the poll. Both halves are needed — the read keeps a page that never
	* polls fresh, and the poll must not outlive the page that asked for it.
	*/
	subscribe = (listener) => {
		const release = this.store.subscribe(listener);
		this.subscribers += 1;
		if (this.subscribers === 1) this.activate();
		return () => {
			release();
			this.subscribers -= 1;
			if (this.subscribers === 0) this.stopPolling();
		};
	};
	/**
	* Read the status once, then keep reading it while an entry stays mounted.
	*
	* The read alone is not enough: a health indicator that is only sampled when
	* the page opens cannot report an outage that starts afterwards — the
	* 2026-10-11 TLS failure stayed invisible exactly that way.
	*/
	async activate() {
		await this.refreshStatus(false);
		this.retunePolling();
	}
	/**
	* Read the channel status route once.
	* @param polling - true for a poll tick, false for an on-demand read.
	*/
	async refreshStatus(polling) {
		if (this.disposed) return;
		try {
			const response = await fetchChannelStatus({
				headers: { accept: "application/json" },
				cache: "no-store"
			});
			const value = await response.json();
			if (!response.ok) throw new Error(value.error ?? this.t("loadFailed"));
			this.adoptStatus(value);
			if (this.statusFailed) {
				this.statusFailed = false;
				this.noticeKey = void 0;
				this.noticeDetail = void 0;
			}
			if (polling && this.provisionWasActive && !isProvisionActive(this.provision.phase)) {
				this.provisionWasActive = false;
				if (this.provision.phase === "done") this.deps.onProvisionCompleted?.();
			}
			if (polling) this.retunePolling();
		} catch (error) {
			this.statusFailed = true;
			this.noticeKey = "loadFailed";
			this.noticeDetail = messageOf(error);
		} finally {
			this.loading = false;
			this.publish();
		}
	}
	/** @param value - a channel status payload; absent halves keep their last state. */
	adoptStatus(value) {
		if (value.runtime !== void 0) this.runtime = value.runtime;
		if (value.provision !== void 0) this.provision = value.provision;
		if (isProvisionActive(this.provision.phase)) this.provisionWasActive = true;
		this.publish();
	}
	/**
	* Keep the status poll running while an entry is mounted, at the cadence the
	* current phase deserves: {@link PROVISION_POLL_MS} while a scan-to-configure
	* run is moving, {@link CHANNEL_STATUS_POLL_MS} otherwise.
	*
	* Re-arms only when the interval actually changes, so a steady state does not
	* restart the timer on every tick.
	*/
	retunePolling() {
		if (this.disposed || this.subscribers === 0) return;
		const interval = isProvisionActive(this.provision.phase) ? PROVISION_POLL_MS : CHANNEL_STATUS_POLL_MS;
		if (this.timer !== void 0 && this.pollInterval === interval) return;
		this.stopPolling();
		this.pollInterval = interval;
		this.timer = setInterval(() => {
			this.refreshStatus(true);
		}, interval);
	}
	/** Stop any status poll. */
	stopPolling() {
		if (this.timer === void 0) return;
		clearInterval(this.timer);
		this.timer = void 0;
		this.pollInterval = void 0;
	}
	/** Drop any staged notice (a new attempt invalidates the previous one). */
	clearNotice() {
		this.noticeKey = void 0;
		this.noticeDetail = void 0;
		this.statusFailed = false;
	}
	/** @returns the published status state. */
	projection() {
		return {
			loading: this.loading,
			runtime: this.runtime,
			provision: this.provision,
			provisioning: this.provisioning,
			notice: this.noticeText()
		};
	}
	/** @returns the localized notice line. */
	noticeText() {
		const head = this.noticeKey === void 0 ? "" : this.t(this.noticeKey);
		if (this.noticeDetail === void 0 || this.noticeDetail === "") return head;
		return head === "" ? this.noticeDetail : `${head}: ${this.noticeDetail}`;
	}
	/** Publish a fresh projection. */
	publish() {
		this.store.set(this.projection());
	}
};
/** @param error - a thrown value. @returns its message. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* One bounded request to the plugin's channel-status route. The route is
* loopback-only, but a request that never settles would still leave a pending
* promise behind, so every read carries its own abort deadline.
* @param init - request init merged over the abort signal.
* @returns the response.
*/
async function fetchChannelStatus(init) {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, CHANNEL_STATUS_TIMEOUT_MS);
	try {
		return await fetch(CHANNEL_STATUS_PATH, {
			...init,
			signal: controller.signal
		});
	} finally {
		clearTimeout(timer);
	}
}

//#endregion
//#region node_modules/qrcode.react/lib/esm/index.js
var __defProp = Object.defineProperty;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, {
	enumerable: true,
	configurable: true,
	writable: true,
	value
}) : obj[key] = value;
var __spreadValues = (a, b) => {
	for (var prop in b || (b = {})) if (__hasOwnProp.call(b, prop)) __defNormalProp(a, prop, b[prop]);
	if (__getOwnPropSymbols) {
		for (var prop of __getOwnPropSymbols(b)) if (__propIsEnum.call(b, prop)) __defNormalProp(a, prop, b[prop]);
	}
	return a;
};
var __objRest = (source, exclude) => {
	var target = {};
	for (var prop in source) if (__hasOwnProp.call(source, prop) && exclude.indexOf(prop) < 0) target[prop] = source[prop];
	if (source != null && __getOwnPropSymbols) {
		for (var prop of __getOwnPropSymbols(source)) if (exclude.indexOf(prop) < 0 && __propIsEnum.call(source, prop)) target[prop] = source[prop];
	}
	return target;
};
/**
* @license QR Code generator library (TypeScript)
* Copyright (c) Project Nayuki.
* SPDX-License-Identifier: MIT
*/
var qrcodegen;
((qrcodegen2) => {
	const _QrCode = class _QrCode$1 {
		constructor(version, errorCorrectionLevel, dataCodewords, msk) {
			this.version = version;
			this.errorCorrectionLevel = errorCorrectionLevel;
			this.modules = [];
			this.isFunction = [];
			if (version < _QrCode$1.MIN_VERSION || version > _QrCode$1.MAX_VERSION) throw new RangeError("Version value out of range");
			if (msk < -1 || msk > 7) throw new RangeError("Mask value out of range");
			this.size = version * 4 + 17;
			let row = [];
			for (let i = 0; i < this.size; i++) row.push(false);
			for (let i = 0; i < this.size; i++) {
				this.modules.push(row.slice());
				this.isFunction.push(row.slice());
			}
			this.drawFunctionPatterns();
			const allCodewords = this.addEccAndInterleave(dataCodewords);
			this.drawCodewords(allCodewords);
			if (msk == -1) {
				let minPenalty = 1e9;
				for (let i = 0; i < 8; i++) {
					this.applyMask(i);
					this.drawFormatBits(i);
					const penalty = this.getPenaltyScore();
					if (penalty < minPenalty) {
						msk = i;
						minPenalty = penalty;
					}
					this.applyMask(i);
				}
			}
			assert(0 <= msk && msk <= 7);
			this.mask = msk;
			this.applyMask(msk);
			this.drawFormatBits(msk);
			this.isFunction = [];
		}
		static encodeText(text, ecl) {
			const segs = qrcodegen2.QrSegment.makeSegments(text);
			return _QrCode$1.encodeSegments(segs, ecl);
		}
		static encodeBinary(data, ecl) {
			const seg = qrcodegen2.QrSegment.makeBytes(data);
			return _QrCode$1.encodeSegments([seg], ecl);
		}
		static encodeSegments(segs, ecl, minVersion = 1, maxVersion = 40, mask = -1, boostEcl = true) {
			if (!(_QrCode$1.MIN_VERSION <= minVersion && minVersion <= maxVersion && maxVersion <= _QrCode$1.MAX_VERSION) || mask < -1 || mask > 7) throw new RangeError("Invalid value");
			let version;
			let dataUsedBits;
			for (version = minVersion;; version++) {
				const dataCapacityBits2 = _QrCode$1.getNumDataCodewords(version, ecl) * 8;
				const usedBits = QrSegment.getTotalBits(segs, version);
				if (usedBits <= dataCapacityBits2) {
					dataUsedBits = usedBits;
					break;
				}
				if (version >= maxVersion) throw new RangeError("Data too long");
			}
			for (const newEcl of [
				_QrCode$1.Ecc.MEDIUM,
				_QrCode$1.Ecc.QUARTILE,
				_QrCode$1.Ecc.HIGH
			]) if (boostEcl && dataUsedBits <= _QrCode$1.getNumDataCodewords(version, newEcl) * 8) ecl = newEcl;
			let bb = [];
			for (const seg of segs) {
				appendBits(seg.mode.modeBits, 4, bb);
				appendBits(seg.numChars, seg.mode.numCharCountBits(version), bb);
				for (const b of seg.getData()) bb.push(b);
			}
			assert(bb.length == dataUsedBits);
			const dataCapacityBits = _QrCode$1.getNumDataCodewords(version, ecl) * 8;
			assert(bb.length <= dataCapacityBits);
			appendBits(0, Math.min(4, dataCapacityBits - bb.length), bb);
			appendBits(0, (8 - bb.length % 8) % 8, bb);
			assert(bb.length % 8 == 0);
			for (let padByte = 236; bb.length < dataCapacityBits; padByte ^= 253) appendBits(padByte, 8, bb);
			let dataCodewords = [];
			while (dataCodewords.length * 8 < bb.length) dataCodewords.push(0);
			bb.forEach((b, i) => dataCodewords[i >>> 3] |= b << 7 - (i & 7));
			return new _QrCode$1(version, ecl, dataCodewords, mask);
		}
		getModule(x, y) {
			return 0 <= x && x < this.size && 0 <= y && y < this.size && this.modules[y][x];
		}
		getModules() {
			return this.modules;
		}
		drawFunctionPatterns() {
			for (let i = 0; i < this.size; i++) {
				this.setFunctionModule(6, i, i % 2 == 0);
				this.setFunctionModule(i, 6, i % 2 == 0);
			}
			this.drawFinderPattern(3, 3);
			this.drawFinderPattern(this.size - 4, 3);
			this.drawFinderPattern(3, this.size - 4);
			const alignPatPos = this.getAlignmentPatternPositions();
			const numAlign = alignPatPos.length;
			for (let i = 0; i < numAlign; i++) for (let j = 0; j < numAlign; j++) if (!(i == 0 && j == 0 || i == 0 && j == numAlign - 1 || i == numAlign - 1 && j == 0)) this.drawAlignmentPattern(alignPatPos[i], alignPatPos[j]);
			this.drawFormatBits(0);
			this.drawVersion();
		}
		drawFormatBits(mask) {
			const data = this.errorCorrectionLevel.formatBits << 3 | mask;
			let rem = data;
			for (let i = 0; i < 10; i++) rem = rem << 1 ^ (rem >>> 9) * 1335;
			const bits = (data << 10 | rem) ^ 21522;
			assert(bits >>> 15 == 0);
			for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, getBit(bits, i));
			this.setFunctionModule(8, 7, getBit(bits, 6));
			this.setFunctionModule(8, 8, getBit(bits, 7));
			this.setFunctionModule(7, 8, getBit(bits, 8));
			for (let i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, getBit(bits, i));
			for (let i = 0; i < 8; i++) this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
			for (let i = 8; i < 15; i++) this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
			this.setFunctionModule(8, this.size - 8, true);
		}
		drawVersion() {
			if (this.version < 7) return;
			let rem = this.version;
			for (let i = 0; i < 12; i++) rem = rem << 1 ^ (rem >>> 11) * 7973;
			const bits = this.version << 12 | rem;
			assert(bits >>> 18 == 0);
			for (let i = 0; i < 18; i++) {
				const color = getBit(bits, i);
				const a = this.size - 11 + i % 3;
				const b = Math.floor(i / 3);
				this.setFunctionModule(a, b, color);
				this.setFunctionModule(b, a, color);
			}
		}
		drawFinderPattern(x, y) {
			for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
				const dist = Math.max(Math.abs(dx), Math.abs(dy));
				const xx = x + dx;
				const yy = y + dy;
				if (0 <= xx && xx < this.size && 0 <= yy && yy < this.size) this.setFunctionModule(xx, yy, dist != 2 && dist != 4);
			}
		}
		drawAlignmentPattern(x, y) {
			for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) != 1);
		}
		setFunctionModule(x, y, isDark) {
			this.modules[y][x] = isDark;
			this.isFunction[y][x] = true;
		}
		addEccAndInterleave(data) {
			const ver = this.version;
			const ecl = this.errorCorrectionLevel;
			if (data.length != _QrCode$1.getNumDataCodewords(ver, ecl)) throw new RangeError("Invalid argument");
			const numBlocks = _QrCode$1.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
			const blockEccLen = _QrCode$1.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver];
			const rawCodewords = Math.floor(_QrCode$1.getNumRawDataModules(ver) / 8);
			const numShortBlocks = numBlocks - rawCodewords % numBlocks;
			const shortBlockLen = Math.floor(rawCodewords / numBlocks);
			let blocks = [];
			const rsDiv = _QrCode$1.reedSolomonComputeDivisor(blockEccLen);
			for (let i = 0, k = 0; i < numBlocks; i++) {
				let dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
				k += dat.length;
				const ecc = _QrCode$1.reedSolomonComputeRemainder(dat, rsDiv);
				if (i < numShortBlocks) dat.push(0);
				blocks.push(dat.concat(ecc));
			}
			let result = [];
			for (let i = 0; i < blocks[0].length; i++) blocks.forEach((block, j) => {
				if (i != shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
			});
			assert(result.length == rawCodewords);
			return result;
		}
		drawCodewords(data) {
			if (data.length != Math.floor(_QrCode$1.getNumRawDataModules(this.version) / 8)) throw new RangeError("Invalid argument");
			let i = 0;
			for (let right = this.size - 1; right >= 1; right -= 2) {
				if (right == 6) right = 5;
				for (let vert = 0; vert < this.size; vert++) for (let j = 0; j < 2; j++) {
					const x = right - j;
					const y = (right + 1 & 2) == 0 ? this.size - 1 - vert : vert;
					if (!this.isFunction[y][x] && i < data.length * 8) {
						this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
						i++;
					}
				}
			}
			assert(i == data.length * 8);
		}
		applyMask(mask) {
			if (mask < 0 || mask > 7) throw new RangeError("Mask value out of range");
			for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) {
				let invert;
				switch (mask) {
					case 0:
						invert = (x + y) % 2 == 0;
						break;
					case 1:
						invert = y % 2 == 0;
						break;
					case 2:
						invert = x % 3 == 0;
						break;
					case 3:
						invert = (x + y) % 3 == 0;
						break;
					case 4:
						invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 == 0;
						break;
					case 5:
						invert = x * y % 2 + x * y % 3 == 0;
						break;
					case 6:
						invert = (x * y % 2 + x * y % 3) % 2 == 0;
						break;
					case 7:
						invert = ((x + y) % 2 + x * y % 3) % 2 == 0;
						break;
					default: throw new Error("Unreachable");
				}
				if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x];
			}
		}
		getPenaltyScore() {
			let result = 0;
			for (let y = 0; y < this.size; y++) {
				let runColor = false;
				let runX = 0;
				let runHistory = [
					0,
					0,
					0,
					0,
					0,
					0,
					0
				];
				for (let x = 0; x < this.size; x++) if (this.modules[y][x] == runColor) {
					runX++;
					if (runX == 5) result += _QrCode$1.PENALTY_N1;
					else if (runX > 5) result++;
				} else {
					this.finderPenaltyAddHistory(runX, runHistory);
					if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * _QrCode$1.PENALTY_N3;
					runColor = this.modules[y][x];
					runX = 1;
				}
				result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * _QrCode$1.PENALTY_N3;
			}
			for (let x = 0; x < this.size; x++) {
				let runColor = false;
				let runY = 0;
				let runHistory = [
					0,
					0,
					0,
					0,
					0,
					0,
					0
				];
				for (let y = 0; y < this.size; y++) if (this.modules[y][x] == runColor) {
					runY++;
					if (runY == 5) result += _QrCode$1.PENALTY_N1;
					else if (runY > 5) result++;
				} else {
					this.finderPenaltyAddHistory(runY, runHistory);
					if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * _QrCode$1.PENALTY_N3;
					runColor = this.modules[y][x];
					runY = 1;
				}
				result += this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * _QrCode$1.PENALTY_N3;
			}
			for (let y = 0; y < this.size - 1; y++) for (let x = 0; x < this.size - 1; x++) {
				const color = this.modules[y][x];
				if (color == this.modules[y][x + 1] && color == this.modules[y + 1][x] && color == this.modules[y + 1][x + 1]) result += _QrCode$1.PENALTY_N2;
			}
			let dark = 0;
			for (const row of this.modules) dark = row.reduce((sum, color) => sum + (color ? 1 : 0), dark);
			const total = this.size * this.size;
			const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
			assert(0 <= k && k <= 9);
			result += k * _QrCode$1.PENALTY_N4;
			assert(0 <= result && result <= 2568888);
			return result;
		}
		getAlignmentPatternPositions() {
			if (this.version == 1) return [];
			else {
				const numAlign = Math.floor(this.version / 7) + 2;
				const step = this.version == 32 ? 26 : Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
				let result = [6];
				for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
				return result;
			}
		}
		static getNumRawDataModules(ver) {
			if (ver < _QrCode$1.MIN_VERSION || ver > _QrCode$1.MAX_VERSION) throw new RangeError("Version number out of range");
			let result = (16 * ver + 128) * ver + 64;
			if (ver >= 2) {
				const numAlign = Math.floor(ver / 7) + 2;
				result -= (25 * numAlign - 10) * numAlign - 55;
				if (ver >= 7) result -= 36;
			}
			assert(208 <= result && result <= 29648);
			return result;
		}
		static getNumDataCodewords(ver, ecl) {
			return Math.floor(_QrCode$1.getNumRawDataModules(ver) / 8) - _QrCode$1.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver] * _QrCode$1.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
		}
		static reedSolomonComputeDivisor(degree) {
			if (degree < 1 || degree > 255) throw new RangeError("Degree out of range");
			let result = [];
			for (let i = 0; i < degree - 1; i++) result.push(0);
			result.push(1);
			let root = 1;
			for (let i = 0; i < degree; i++) {
				for (let j = 0; j < result.length; j++) {
					result[j] = _QrCode$1.reedSolomonMultiply(result[j], root);
					if (j + 1 < result.length) result[j] ^= result[j + 1];
				}
				root = _QrCode$1.reedSolomonMultiply(root, 2);
			}
			return result;
		}
		static reedSolomonComputeRemainder(data, divisor) {
			let result = divisor.map((_) => 0);
			for (const b of data) {
				const factor = b ^ result.shift();
				result.push(0);
				divisor.forEach((coef, i) => result[i] ^= _QrCode$1.reedSolomonMultiply(coef, factor));
			}
			return result;
		}
		static reedSolomonMultiply(x, y) {
			if (x >>> 8 != 0 || y >>> 8 != 0) throw new RangeError("Byte out of range");
			let z = 0;
			for (let i = 7; i >= 0; i--) {
				z = z << 1 ^ (z >>> 7) * 285;
				z ^= (y >>> i & 1) * x;
			}
			assert(z >>> 8 == 0);
			return z;
		}
		finderPenaltyCountPatterns(runHistory) {
			const n = runHistory[1];
			assert(n <= this.size * 3);
			const core = n > 0 && runHistory[2] == n && runHistory[3] == n * 3 && runHistory[4] == n && runHistory[5] == n;
			return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
		}
		finderPenaltyTerminateAndCount(currentRunColor, currentRunLength, runHistory) {
			if (currentRunColor) {
				this.finderPenaltyAddHistory(currentRunLength, runHistory);
				currentRunLength = 0;
			}
			currentRunLength += this.size;
			this.finderPenaltyAddHistory(currentRunLength, runHistory);
			return this.finderPenaltyCountPatterns(runHistory);
		}
		finderPenaltyAddHistory(currentRunLength, runHistory) {
			if (runHistory[0] == 0) currentRunLength += this.size;
			runHistory.pop();
			runHistory.unshift(currentRunLength);
		}
	};
	_QrCode.MIN_VERSION = 1;
	_QrCode.MAX_VERSION = 40;
	_QrCode.PENALTY_N1 = 3;
	_QrCode.PENALTY_N2 = 3;
	_QrCode.PENALTY_N3 = 40;
	_QrCode.PENALTY_N4 = 10;
	_QrCode.ECC_CODEWORDS_PER_BLOCK = [
		[
			-1,
			7,
			10,
			15,
			20,
			26,
			18,
			20,
			24,
			30,
			18,
			20,
			24,
			26,
			30,
			22,
			24,
			28,
			30,
			28,
			28,
			28,
			28,
			30,
			30,
			26,
			28,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30
		],
		[
			-1,
			10,
			16,
			26,
			18,
			24,
			16,
			18,
			22,
			22,
			26,
			30,
			22,
			22,
			24,
			24,
			28,
			28,
			26,
			26,
			26,
			26,
			28,
			28,
			28,
			28,
			28,
			28,
			28,
			28,
			28,
			28,
			28,
			28,
			28,
			28,
			28,
			28,
			28,
			28,
			28
		],
		[
			-1,
			13,
			22,
			18,
			26,
			18,
			24,
			18,
			22,
			20,
			24,
			28,
			26,
			24,
			20,
			30,
			24,
			28,
			28,
			26,
			30,
			28,
			30,
			30,
			30,
			30,
			28,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30
		],
		[
			-1,
			17,
			28,
			22,
			16,
			22,
			28,
			26,
			26,
			24,
			28,
			24,
			28,
			22,
			24,
			24,
			30,
			28,
			28,
			26,
			28,
			30,
			24,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30,
			30
		]
	];
	_QrCode.NUM_ERROR_CORRECTION_BLOCKS = [
		[
			-1,
			1,
			1,
			1,
			1,
			1,
			2,
			2,
			2,
			2,
			4,
			4,
			4,
			4,
			4,
			6,
			6,
			6,
			6,
			7,
			8,
			8,
			9,
			9,
			10,
			12,
			12,
			12,
			13,
			14,
			15,
			16,
			17,
			18,
			19,
			19,
			20,
			21,
			22,
			24,
			25
		],
		[
			-1,
			1,
			1,
			1,
			2,
			2,
			4,
			4,
			4,
			5,
			5,
			5,
			8,
			9,
			9,
			10,
			10,
			11,
			13,
			14,
			16,
			17,
			17,
			18,
			20,
			21,
			23,
			25,
			26,
			28,
			29,
			31,
			33,
			35,
			37,
			38,
			40,
			43,
			45,
			47,
			49
		],
		[
			-1,
			1,
			1,
			2,
			2,
			4,
			4,
			6,
			6,
			8,
			8,
			8,
			10,
			12,
			16,
			12,
			17,
			16,
			18,
			21,
			20,
			23,
			23,
			25,
			27,
			29,
			34,
			34,
			35,
			38,
			40,
			43,
			45,
			48,
			51,
			53,
			56,
			59,
			62,
			65,
			68
		],
		[
			-1,
			1,
			1,
			2,
			4,
			4,
			4,
			5,
			6,
			8,
			8,
			11,
			11,
			16,
			16,
			18,
			16,
			19,
			21,
			25,
			25,
			25,
			34,
			30,
			32,
			35,
			37,
			40,
			42,
			45,
			48,
			51,
			54,
			57,
			60,
			63,
			66,
			70,
			74,
			77,
			81
		]
	];
	qrcodegen2.QrCode = _QrCode;
	function appendBits(val, len, bb) {
		if (len < 0 || len > 31 || val >>> len != 0) throw new RangeError("Value out of range");
		for (let i = len - 1; i >= 0; i--) bb.push(val >>> i & 1);
	}
	function getBit(x, i) {
		return (x >>> i & 1) != 0;
	}
	function assert(cond) {
		if (!cond) throw new Error("Assertion error");
	}
	const _QrSegment = class _QrSegment$1 {
		constructor(mode, numChars, bitData) {
			this.mode = mode;
			this.numChars = numChars;
			this.bitData = bitData;
			if (numChars < 0) throw new RangeError("Invalid argument");
			this.bitData = bitData.slice();
		}
		static makeBytes(data) {
			let bb = [];
			for (const b of data) appendBits(b, 8, bb);
			return new _QrSegment$1(_QrSegment$1.Mode.BYTE, data.length, bb);
		}
		static makeNumeric(digits) {
			if (!_QrSegment$1.isNumeric(digits)) throw new RangeError("String contains non-numeric characters");
			let bb = [];
			for (let i = 0; i < digits.length;) {
				const n = Math.min(digits.length - i, 3);
				appendBits(parseInt(digits.substring(i, i + n), 10), n * 3 + 1, bb);
				i += n;
			}
			return new _QrSegment$1(_QrSegment$1.Mode.NUMERIC, digits.length, bb);
		}
		static makeAlphanumeric(text) {
			if (!_QrSegment$1.isAlphanumeric(text)) throw new RangeError("String contains unencodable characters in alphanumeric mode");
			let bb = [];
			let i;
			for (i = 0; i + 2 <= text.length; i += 2) {
				let temp = _QrSegment$1.ALPHANUMERIC_CHARSET.indexOf(text.charAt(i)) * 45;
				temp += _QrSegment$1.ALPHANUMERIC_CHARSET.indexOf(text.charAt(i + 1));
				appendBits(temp, 11, bb);
			}
			if (i < text.length) appendBits(_QrSegment$1.ALPHANUMERIC_CHARSET.indexOf(text.charAt(i)), 6, bb);
			return new _QrSegment$1(_QrSegment$1.Mode.ALPHANUMERIC, text.length, bb);
		}
		static makeSegments(text) {
			if (text == "") return [];
			else if (_QrSegment$1.isNumeric(text)) return [_QrSegment$1.makeNumeric(text)];
			else if (_QrSegment$1.isAlphanumeric(text)) return [_QrSegment$1.makeAlphanumeric(text)];
			else return [_QrSegment$1.makeBytes(_QrSegment$1.toUtf8ByteArray(text))];
		}
		static makeEci(assignVal) {
			let bb = [];
			if (assignVal < 0) throw new RangeError("ECI assignment value out of range");
			else if (assignVal < 128) appendBits(assignVal, 8, bb);
			else if (assignVal < 16384) {
				appendBits(2, 2, bb);
				appendBits(assignVal, 14, bb);
			} else if (assignVal < 1e6) {
				appendBits(6, 3, bb);
				appendBits(assignVal, 21, bb);
			} else throw new RangeError("ECI assignment value out of range");
			return new _QrSegment$1(_QrSegment$1.Mode.ECI, 0, bb);
		}
		static isNumeric(text) {
			return _QrSegment$1.NUMERIC_REGEX.test(text);
		}
		static isAlphanumeric(text) {
			return _QrSegment$1.ALPHANUMERIC_REGEX.test(text);
		}
		getData() {
			return this.bitData.slice();
		}
		static getTotalBits(segs, version) {
			let result = 0;
			for (const seg of segs) {
				const ccbits = seg.mode.numCharCountBits(version);
				if (seg.numChars >= 1 << ccbits) return Infinity;
				result += 4 + ccbits + seg.bitData.length;
			}
			return result;
		}
		static toUtf8ByteArray(str) {
			str = encodeURI(str);
			let result = [];
			for (let i = 0; i < str.length; i++) if (str.charAt(i) != "%") result.push(str.charCodeAt(i));
			else {
				result.push(parseInt(str.substring(i + 1, i + 3), 16));
				i += 2;
			}
			return result;
		}
	};
	_QrSegment.NUMERIC_REGEX = /^[0-9]*$/;
	_QrSegment.ALPHANUMERIC_REGEX = /^[A-Z0-9 $%*+.\/:-]*$/;
	_QrSegment.ALPHANUMERIC_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
	let QrSegment = _QrSegment;
	qrcodegen2.QrSegment = _QrSegment;
})(qrcodegen || (qrcodegen = {}));
((qrcodegen2) => {
	((QrCode2) => {
		const _Ecc = class _Ecc$1 {
			constructor(ordinal, formatBits) {
				this.ordinal = ordinal;
				this.formatBits = formatBits;
			}
		};
		_Ecc.LOW = new _Ecc(0, 1);
		_Ecc.MEDIUM = new _Ecc(1, 0);
		_Ecc.QUARTILE = new _Ecc(2, 3);
		_Ecc.HIGH = new _Ecc(3, 2);
		QrCode2.Ecc = _Ecc;
	})(qrcodegen2.QrCode || (qrcodegen2.QrCode = {}));
})(qrcodegen || (qrcodegen = {}));
((qrcodegen2) => {
	((QrSegment2) => {
		const _Mode = class _Mode$1 {
			constructor(modeBits, numBitsCharCount) {
				this.modeBits = modeBits;
				this.numBitsCharCount = numBitsCharCount;
			}
			numCharCountBits(ver) {
				return this.numBitsCharCount[Math.floor((ver + 7) / 17)];
			}
		};
		_Mode.NUMERIC = new _Mode(1, [
			10,
			12,
			14
		]);
		_Mode.ALPHANUMERIC = new _Mode(2, [
			9,
			11,
			13
		]);
		_Mode.BYTE = new _Mode(4, [
			8,
			16,
			16
		]);
		_Mode.KANJI = new _Mode(8, [
			8,
			10,
			12
		]);
		_Mode.ECI = new _Mode(7, [
			0,
			0,
			0
		]);
		QrSegment2.Mode = _Mode;
	})(qrcodegen2.QrSegment || (qrcodegen2.QrSegment = {}));
})(qrcodegen || (qrcodegen = {}));
var qrcodegen_default = qrcodegen;
/**
* @license qrcode.react
* Copyright (c) Paul O'Shannessy
* SPDX-License-Identifier: ISC
*/
var ERROR_LEVEL_MAP = {
	L: qrcodegen_default.QrCode.Ecc.LOW,
	M: qrcodegen_default.QrCode.Ecc.MEDIUM,
	Q: qrcodegen_default.QrCode.Ecc.QUARTILE,
	H: qrcodegen_default.QrCode.Ecc.HIGH
};
var DEFAULT_SIZE = 128;
var DEFAULT_LEVEL = "L";
var DEFAULT_BGCOLOR = "#FFFFFF";
var DEFAULT_FGCOLOR = "#000000";
var DEFAULT_INCLUDEMARGIN = false;
var DEFAULT_MINVERSION = 1;
var SPEC_MARGIN_SIZE = 4;
var DEFAULT_MARGIN_SIZE = 0;
var DEFAULT_IMG_SCALE = .1;
function generatePath(modules, margin = 0) {
	const ops = [];
	modules.forEach(function(row, y) {
		let start = null;
		row.forEach(function(cell, x) {
			if (!cell && start !== null) {
				ops.push(`M${start + margin} ${y + margin}h${x - start}v1H${start + margin}z`);
				start = null;
				return;
			}
			if (x === row.length - 1) {
				if (!cell) return;
				if (start === null) ops.push(`M${x + margin},${y + margin} h1v1H${x + margin}z`);
				else ops.push(`M${start + margin},${y + margin} h${x + 1 - start}v1H${start + margin}z`);
				return;
			}
			if (cell && start === null) start = x;
		});
	});
	return ops.join("");
}
function excavateModules(modules, excavation) {
	return modules.slice().map((row, y) => {
		if (y < excavation.y || y >= excavation.y + excavation.h) return row;
		return row.map((cell, x) => {
			if (x < excavation.x || x >= excavation.x + excavation.w) return cell;
			return false;
		});
	});
}
function getImageSettings(cells, size, margin, imageSettings) {
	if (imageSettings == null) return null;
	const numCells = cells.length + margin * 2;
	const defaultSize = Math.floor(size * DEFAULT_IMG_SCALE);
	const scale = numCells / size;
	const w = (imageSettings.width || defaultSize) * scale;
	const h = (imageSettings.height || defaultSize) * scale;
	const x = imageSettings.x == null ? cells.length / 2 - w / 2 : imageSettings.x * scale;
	const y = imageSettings.y == null ? cells.length / 2 - h / 2 : imageSettings.y * scale;
	const opacity = imageSettings.opacity == null ? 1 : imageSettings.opacity;
	let excavation = null;
	if (imageSettings.excavate) {
		let floorX = Math.floor(x);
		let floorY = Math.floor(y);
		excavation = {
			x: floorX,
			y: floorY,
			w: Math.ceil(w + x - floorX),
			h: Math.ceil(h + y - floorY)
		};
	}
	const crossOrigin = imageSettings.crossOrigin;
	return {
		x,
		y,
		h,
		w,
		excavation,
		opacity,
		crossOrigin
	};
}
function getMarginSize(includeMargin, marginSize) {
	if (marginSize != null) return Math.max(Math.floor(marginSize), 0);
	return includeMargin ? SPEC_MARGIN_SIZE : DEFAULT_MARGIN_SIZE;
}
function useQRCode({ value, level, minVersion, includeMargin, marginSize, imageSettings, size, boostLevel }) {
	let qrcode = react.default.useMemo(() => {
		const segments = (Array.isArray(value) ? value : [value]).reduce((accum, v) => {
			accum.push(...qrcodegen_default.QrSegment.makeSegments(v));
			return accum;
		}, []);
		return qrcodegen_default.QrCode.encodeSegments(segments, ERROR_LEVEL_MAP[level], minVersion, void 0, void 0, boostLevel);
	}, [
		value,
		level,
		minVersion,
		boostLevel
	]);
	const { cells, margin, numCells, calculatedImageSettings } = react.default.useMemo(() => {
		let cells2 = qrcode.getModules();
		const margin2 = getMarginSize(includeMargin, marginSize);
		return {
			cells: cells2,
			margin: margin2,
			numCells: cells2.length + margin2 * 2,
			calculatedImageSettings: getImageSettings(cells2, size, margin2, imageSettings)
		};
	}, [
		qrcode,
		size,
		imageSettings,
		includeMargin,
		marginSize
	]);
	return {
		qrcode,
		margin,
		cells,
		numCells,
		calculatedImageSettings
	};
}
var SUPPORTS_PATH2D = function() {
	try {
		new Path2D().addPath(new Path2D());
	} catch (e) {
		return false;
	}
	return true;
}();
var QRCodeCanvas = react.default.forwardRef(function QRCodeCanvas2(props, forwardedRef) {
	const _a = props, { value, size = DEFAULT_SIZE, level = DEFAULT_LEVEL, bgColor = DEFAULT_BGCOLOR, fgColor = DEFAULT_FGCOLOR, includeMargin = DEFAULT_INCLUDEMARGIN, minVersion = DEFAULT_MINVERSION, boostLevel, marginSize, imageSettings } = _a;
	const _b = __objRest(_a, [
		"value",
		"size",
		"level",
		"bgColor",
		"fgColor",
		"includeMargin",
		"minVersion",
		"boostLevel",
		"marginSize",
		"imageSettings"
	]), { style } = _b, otherProps = __objRest(_b, ["style"]);
	const imgSrc = imageSettings == null ? void 0 : imageSettings.src;
	const _canvas = react.default.useRef(null);
	const _image = react.default.useRef(null);
	const setCanvasRef = react.default.useCallback((node) => {
		_canvas.current = node;
		if (typeof forwardedRef === "function") forwardedRef(node);
		else if (forwardedRef) forwardedRef.current = node;
	}, [forwardedRef]);
	const [isImgLoaded, setIsImageLoaded] = react.default.useState(false);
	const { margin, cells, numCells, calculatedImageSettings } = useQRCode({
		value,
		level,
		minVersion,
		boostLevel,
		includeMargin,
		marginSize,
		imageSettings,
		size
	});
	react.default.useEffect(() => {
		if (_canvas.current != null) {
			const canvas = _canvas.current;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			let cellsToDraw = cells;
			const image = _image.current;
			const haveImageToRender = calculatedImageSettings != null && image !== null && image.complete && image.naturalHeight !== 0 && image.naturalWidth !== 0;
			if (haveImageToRender) {
				if (calculatedImageSettings.excavation != null) cellsToDraw = excavateModules(cells, calculatedImageSettings.excavation);
			}
			const pixelRatio = window.devicePixelRatio || 1;
			canvas.height = canvas.width = size * pixelRatio;
			const scale = size / numCells * pixelRatio;
			ctx.scale(scale, scale);
			ctx.fillStyle = bgColor;
			ctx.fillRect(0, 0, numCells, numCells);
			ctx.fillStyle = fgColor;
			if (SUPPORTS_PATH2D) ctx.fill(new Path2D(generatePath(cellsToDraw, margin)));
			else cells.forEach(function(row, rdx) {
				row.forEach(function(cell, cdx) {
					if (cell) ctx.fillRect(cdx + margin, rdx + margin, 1, 1);
				});
			});
			if (calculatedImageSettings) ctx.globalAlpha = calculatedImageSettings.opacity;
			if (haveImageToRender) ctx.drawImage(image, calculatedImageSettings.x + margin, calculatedImageSettings.y + margin, calculatedImageSettings.w, calculatedImageSettings.h);
		}
	});
	react.default.useEffect(() => {
		setIsImageLoaded(false);
	}, [imgSrc]);
	const canvasStyle = __spreadValues({
		height: size,
		width: size
	}, style);
	let img = null;
	if (imgSrc != null) img = /* @__PURE__ */ react.default.createElement("img", {
		src: imgSrc,
		key: imgSrc,
		style: { display: "none" },
		onLoad: () => {
			setIsImageLoaded(true);
		},
		ref: _image,
		crossOrigin: calculatedImageSettings == null ? void 0 : calculatedImageSettings.crossOrigin
	});
	return /* @__PURE__ */ react.default.createElement(react.default.Fragment, null, /* @__PURE__ */ react.default.createElement("canvas", __spreadValues({
		style: canvasStyle,
		height: size,
		width: size,
		ref: setCanvasRef,
		role: "img"
	}, otherProps)), img);
});
QRCodeCanvas.displayName = "QRCodeCanvas";
var QRCodeSVG = react.default.forwardRef(function QRCodeSVG2(props, forwardedRef) {
	const _a = props, { value, size = DEFAULT_SIZE, level = DEFAULT_LEVEL, bgColor = DEFAULT_BGCOLOR, fgColor = DEFAULT_FGCOLOR, includeMargin = DEFAULT_INCLUDEMARGIN, minVersion = DEFAULT_MINVERSION, boostLevel, title, marginSize, imageSettings } = _a, otherProps = __objRest(_a, [
		"value",
		"size",
		"level",
		"bgColor",
		"fgColor",
		"includeMargin",
		"minVersion",
		"boostLevel",
		"title",
		"marginSize",
		"imageSettings"
	]);
	const { margin, cells, numCells, calculatedImageSettings } = useQRCode({
		value,
		level,
		minVersion,
		boostLevel,
		includeMargin,
		marginSize,
		imageSettings,
		size
	});
	let cellsToDraw = cells;
	let image = null;
	if (imageSettings != null && calculatedImageSettings != null) {
		if (calculatedImageSettings.excavation != null) cellsToDraw = excavateModules(cells, calculatedImageSettings.excavation);
		image = /* @__PURE__ */ react.default.createElement("image", {
			href: imageSettings.src,
			height: calculatedImageSettings.h,
			width: calculatedImageSettings.w,
			x: calculatedImageSettings.x + margin,
			y: calculatedImageSettings.y + margin,
			preserveAspectRatio: "none",
			opacity: calculatedImageSettings.opacity,
			crossOrigin: calculatedImageSettings.crossOrigin
		});
	}
	const fgPath = generatePath(cellsToDraw, margin);
	return /* @__PURE__ */ react.default.createElement("svg", __spreadValues({
		height: size,
		width: size,
		viewBox: `0 0 ${numCells} ${numCells}`,
		ref: forwardedRef,
		role: "img"
	}, otherProps), !!title && /* @__PURE__ */ react.default.createElement("title", null, title), /* @__PURE__ */ react.default.createElement("path", {
		fill: bgColor,
		d: `M0,0 h${numCells}v${numCells}H0z`,
		shapeRendering: "crispEdges"
	}), /* @__PURE__ */ react.default.createElement("path", {
		fill: fgColor,
		d: fgPath,
		shapeRendering: "crispEdges"
	}), image);
});
QRCodeSVG.displayName = "QRCodeSVG";

//#endregion
//#region src/client/plugin-detail-contract.ts
/** This plugin's npm package name: the subject every entry here answers to. */
const LARK_PLUGIN_PACKAGE = "@starxer/chatterbox4dsh";
/**
* Whether one opened detail page is about this plugin.
*
* This bundle declares a single row, so its own page and that row's page are
* the only two subjects it has anything to show for. An official item is never
* ours: this plugin occupies no `plugins.item` entry.
* @param subject - the open page's subject, when the owner supplies one.
* @returns true for this bundle and its rows.
*/
function isLarkSubject(subject) {
	if (subject === void 0) return false;
	return (subject.kind === "bundle" || subject.kind === "row") && subject.pkg.name === LARK_PLUGIN_PACKAGE;
}

//#endregion
//#region src/client/LarkPluginDetail.tsx
/**
* Which half of the link is broken, if either.
*
* A boot verdict says the WebSocket handshake succeeded ONCE; it says nothing
* about either direction now. So a channel the runtime calls connected is still
* reported as broken when the requests cannot leave (outbound) or the long
* connection is no longer up (inbound) — the state that was missing during the
* 2026-10-11 TLS outage, when the badge read 已连接 while nothing could be sent.
*
* Only a `connected` verdict is second-guessed: `connecting`, `error` and the
* rest already describe themselves, and a stale outbound failure from an
* earlier channel must not repaint them.
*
* @param state - the channel status snapshot.
* @returns the broken half, or undefined while the link looks intact.
*/
function linkTrouble(state) {
	if (state.runtime.state !== "connected") return void 0;
	if (state.runtime.outbound?.verdict === "failing") return "outbound";
	const inbound = state.runtime.inbound?.state;
	if (inbound === "reconnecting" || inbound === "failed" || inbound === "idle") return "inbound";
}
/**
* Connection state beside a detail page's title.
* @param props - the open subject, the status snapshot, and locale copy.
* @returns the status pill, or null for a subject that is not this plugin's.
*/
function LarkConnectionBadge(props) {
	if (!isLarkSubject(props.subject)) return null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LarkConnectionBadgeBody, { ...props });
}
/**
* Page header control: start — or re-run — the scan-to-configure flow.
* @param props - the open subject, the status snapshot, and locale copy.
* @returns the control, or null for a subject that is not this plugin's.
*/
function LarkConnectionAction(props) {
	if (!isLarkSubject(props.subject)) return null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LarkConnectionActionBody, { ...props });
}
/**
* The section under a detail page's own content: connection state and the
* authorization QR code. The flow is started from the header control, so this
* section carries no second button for the same thing.
* @param props - the open subject, the status snapshot, and locale copy.
* @returns the section, or null for a subject that is not this plugin's.
*/
function LarkChannelSection(props) {
	if (!isLarkSubject(props.subject)) return null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LarkChannelSectionBody, { ...props });
}
/** @param props - the bound status face and locale copy. @returns the status pill. */
function LarkConnectionBadgeBody(props) {
	const state = props.useChannelStatus((snapshot) => snapshot);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusPill, {
		t: props.t,
		state
	});
}
/** @param props - the bound status face and locale copy. @returns the scan control. */
function LarkConnectionActionBody(props) {
	const { t } = props;
	const state = props.useChannelStatus((snapshot) => snapshot);
	const provision = state.provision;
	const repeated = provision.phase === "done" || provision.phase === "error" || state.runtime.state === "connected";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
		variant: "outline",
		size: "sm",
		disabled: state.provisioning || isProvisionActive(provision.phase),
		onClick: () => {
			props.startProvision();
		},
		children: state.provisioning ? t("provisionStarting") : repeated ? t("rescan") : t("scanToConfigure")
	});
}
/** @param props - the bound status face and locale copy. @returns the connection section. */
function LarkChannelSectionBody(props) {
	const { t } = props;
	const state = props.useChannelStatus((snapshot) => snapshot);
	const provision = state.provision;
	const trouble = linkTrouble(state);
	const detail = linkDetail(t, state);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: "dsh-feishu-detail-section",
		"aria-labelledby": "dsh-feishu-connection-title",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-feishu-detail-head",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
					id: "dsh-feishu-connection-title",
					children: t("connectionTitle")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusPill, {
					t,
					state
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-feishu-detail-hint",
				children: t("connectionHint")
			}),
			provision.phase === "waiting" && provision.qrUrl !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-feishu-qr",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QRCodeSVG, {
						value: provision.qrUrl,
						size: 220,
						marginSize: 1
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("scanHint") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
						className: "dsh-feishu-qr-link",
						children: provision.qrUrl
					})
				]
			}) : null,
			provision.phase === "waiting" && provision.qrUrl === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-feishu-detail",
				children: t("provisionPreparing")
			}) : null,
			provision.phase === "configuring" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-feishu-detail",
				children: t("provisioning")
			}) : null,
			provision.phase === "done" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-feishu-detail",
				children: t("provisionDone")
			}) : null,
			provision.phase === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				className: "dsh-feishu-detail dsh-feishu-error",
				children: [t("provisionFailed"), provision.errorCode === "start-timeout" ? `: ${t("provisionTimeout")}` : provision.message !== void 0 ? `: ${provision.message}` : ""]
			}) : null,
			state.runtime.message !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-feishu-detail",
				children: state.runtime.message
			}) : null,
			detail !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: trouble === void 0 ? "dsh-feishu-detail" : "dsh-feishu-detail dsh-feishu-error",
				children: detail
			}) : null,
			state.notice !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-feishu-detail dsh-feishu-error",
				role: "status",
				children: state.notice
			}) : null
		]
	});
}
/**
* The sentence behind a bad pill: which half broke, how badly, and the first
* concrete reason. Numbers and the peer's own wording are not translated — the
* reason is a diagnostic, and paraphrasing it would lose the code an operator
* needs.
*
* @param t - the dictionary translator.
* @param state - the channel status snapshot.
* @returns the line to render, or undefined while there is nothing to explain.
*/
function linkDetail(t, state) {
	const trouble = linkTrouble(state);
	if (trouble === "outbound") {
		const outbound = state.runtime.outbound;
		if (outbound === void 0) return void 0;
		const reason = outbound.lastError === void 0 ? "" : ` · ${outbound.lastError}`;
		return `${t("outboundFailures")}: ${outbound.consecutiveFailures}${reason}`;
	}
	if (trouble === "inbound") {
		const inbound = state.runtime.inbound;
		if (inbound === void 0) return void 0;
		const label = inbound.state === "reconnecting" ? t("statusConnecting") : t("statusOffline");
		return `${t("inboundState")}: ${label} · ${t("inboundRetries")} ${inbound.reconnectAttempts}`;
	}
	if (state.runtime.state === "connected" && state.runtime.outbound?.observed === 0) return t("outboundUnobserved");
}
/** One read-only status pill: a tone dot plus its localized label. */
function StatusPill({ t, state }) {
	const label = t(statusLabelKey(state));
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
		className: "dsh-feishu-status",
		"data-state": statusTone(state),
		"aria-label": label,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.StateDot, {
			state: statusDot(state),
			size: 8
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label })]
	});
}
/**
* @param state - channel status. @returns the dictionary key for its label.
*
* `loading` wins over the reported state: before the first read settles the
* runtime still holds its initial `connecting`, and claiming the channel is
* connecting while nothing has been asked would be a guess. A broken half of
* the link is named on top of the connected verdict for the same reason — the
* verdict is the boot fact, not the live one.
*/
function statusLabelKey(state) {
	if (state.loading) return "statusReading";
	switch (state.runtime.state) {
		case "connected": {
			const trouble = linkTrouble(state);
			if (trouble === "outbound") return "statusOutboundFailing";
			if (trouble === "inbound") return "statusInboundFailing";
			return "statusConnected";
		}
		case "connecting": return "statusConnecting";
		case "unconfigured": return "statusUnconfigured";
		case "stopped": return "statusStopped";
		default: return "statusOffline";
	}
}
/** @param state - channel status. @returns the pill's palette. */
function statusTone(state) {
	if (state.loading || state.runtime.state === "connecting") return "pending";
	switch (state.runtime.state) {
		case "connected": return linkTrouble(state) === void 0 ? "connected" : "error";
		case "error": return "error";
		default: return "idle";
	}
}
/** @param state - channel status. @returns the state dot's tone. */
function statusDot(state) {
	if (state.loading) return "ongoing";
	switch (state.runtime.state) {
		case "connected": return linkTrouble(state) === void 0 ? "done" : "error";
		case "connecting": return "ongoing";
		case "error": return "error";
		case "unconfigured": return "warning";
		default: return "idle";
	}
}

//#endregion
//#region src/client/styles.ts
const CLIENT_CSS = `
.dsh-feishu-settings{max-width:880px;padding:8px 2px 36px;color:var(--text-primary,#16181d)}
.dsh-feishu-header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:20px}.dsh-feishu-header h2{margin:0;font-size:22px}.dsh-feishu-header p{margin:6px 0 0;color:var(--text-secondary,#586174)}
.dsh-feishu-status{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--border-subtle,#dfe3ea);border-radius:999px;padding:4px 10px;font-size:12px;font-weight:700;white-space:nowrap}
.dsh-feishu-status[data-state=connected]{color:var(--success-text,#137333);background:var(--success-surface,#e8f5e9);border-color:currentColor}
.dsh-feishu-status[data-state=pending]{color:var(--warning-text,#9a6700);background:var(--warning-surface,#fff4ce);border-color:currentColor}
.dsh-feishu-status[data-state=error]{color:var(--danger-text,#b3261e);background:var(--surface-secondary,#f2f4f7);border-color:currentColor}
.dsh-feishu-status[data-state=idle]{color:var(--text-secondary,#586174);background:var(--surface-secondary,#f2f4f7)}
.dsh-feishu-card{display:grid;gap:16px;margin:0 0 14px;padding:20px;border:1px solid var(--border-subtle,#dfe3ea);border-radius:12px;background:var(--surface-primary,#fff)}.dsh-feishu-card h3{margin:0;font-size:15px}
.dsh-feishu-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}.dsh-feishu-card label{display:grid;gap:7px;font-size:13px;font-weight:600}.dsh-feishu-card select,.dsh-feishu-card textarea{box-sizing:border-box;width:100%;border:1px solid var(--border-default,#cbd1dc);border-radius:8px;background:var(--surface-primary,#fff);color:inherit;font:inherit;padding:9px 11px}.dsh-feishu-card textarea{min-height:82px;resize:vertical}.dsh-feishu-card select:focus-visible,.dsh-feishu-card textarea:focus-visible{outline:2px solid var(--accent-primary,#3b72e8);outline-offset:2px}
.dsh-feishu-check{display:flex!important;align-items:center;gap:9px}.dsh-feishu-check input{width:16px;height:16px}
.dsh-feishu-toggle{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:2px 0}
.dsh-feishu-toggle-nested{margin-left:18px;padding-left:14px;border-left:2px solid var(--border-subtle,#dfe3ea)}
.dsh-feishu-toggle-text{display:grid;gap:3px;min-width:0}
.dsh-feishu-toggle-label{font-size:13px;font-weight:600}
.dsh-feishu-toggle-hint{font-size:12px;font-weight:400;color:var(--text-secondary,#586174);line-height:1.45}
.dsh-feishu-toggle button{flex:none;margin-top:2px}.dsh-feishu-credential{display:flex;align-items:center;gap:9px;color:var(--text-secondary,#586174);font-size:12px}.dsh-feishu-credential-badge{display:inline-flex;align-items:center;gap:7px;border:1px solid currentColor;border-radius:999px;padding:4px 9px;font-weight:700}.dsh-feishu-credential[data-state=configured] .dsh-feishu-credential-badge{color:var(--success-text,#137333);background:var(--success-surface,#e8f5e9)}.dsh-feishu-credential[data-state=missing] .dsh-feishu-credential-badge{color:var(--warning-text,#9a6700);background:var(--warning-surface,#fff4ce)}.dsh-feishu-credential-dot{width:7px;height:7px;border-radius:50%;background:currentColor}.dsh-feishu-credential code{padding:2px 6px;border-radius:5px;background:var(--surface-secondary,#f2f4f7)}
.dsh-feishu-actions{display:flex;align-items:center;gap:10px;min-height:36px}.dsh-feishu-actions [role=status]{font-size:13px;color:var(--text-secondary,#586174)}.dsh-feishu-detail,.dsh-feishu-loading{color:var(--text-secondary,#586174);font-size:13px}
.dsh-feishu-provision{display:grid;gap:12px;align-items:start}.dsh-feishu-provision>button{justify-self:start}.dsh-feishu-qr{display:grid;gap:8px;justify-items:center;padding:14px;border:1px dashed var(--border-default,#cbd1dc);border-radius:10px;background:var(--surface-secondary,#f2f4f7)}.dsh-feishu-qr svg{display:block}.dsh-feishu-qr p{margin:0;color:var(--text-secondary,#586174);font-size:13px}.dsh-feishu-qr-link{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--text-secondary,#586174)}.dsh-feishu-error{color:var(--danger-text,#b3261e)}
.dsh-feishu-pointer{margin:10px 0 0;color:var(--text-secondary,#586174);font-size:13px}
.dsh-feishu-detail-section{display:grid;gap:12px;padding:20px;border:1px solid var(--border-subtle,#dfe3ea);border-radius:12px;background:var(--surface-primary,#fff)}
.dsh-feishu-detail-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.dsh-feishu-detail-head h4{margin:0;font-size:15px}
.dsh-feishu-detail-hint{margin:0;color:var(--text-secondary,#586174);font-size:13px}
@media(max-width:680px){.dsh-feishu-header{align-items:stretch;flex-direction:column}.dsh-feishu-grid{grid-template-columns:1fr}.dsh-feishu-actions{align-items:stretch;flex-direction:column}.dsh-feishu-actions button{width:100%}}
@media(prefers-reduced-motion:reduce){.dsh-feishu-settings *{scroll-behavior:auto!important;transition:none!important}}
`;

//#endregion
//#region src/client/index.ts
const NS = "dsh-feishu";
/**
* Entry id every surface this plugin registers under. The Settings tab and the
* three Plugins-detail contributions live in different slots, so one id is
* unambiguous; it matches the profile row whose client half this is.
*/
const LARK_ENTRY_ID = "lark-channel";
const dictionaries = {
	zh: {
		nav: "飞书与 Lark",
		title: "飞书与 Lark",
		subtitle: "配置消息渠道与卡片显示，保存后无需重启 Harness",
		connectionMoved: "连接状态与扫码配置在「插件 → 飞书与 Lark」详情页。",
		connectionTitle: "连接与扫码",
		connectionHint: "扫码授权由飞书 App 完成：点本页右上角的「扫码配置」，二维码会显示在这里。",
		rescan: "重新扫码",
		provisionDone: "授权已完成",
		statusReading: "读取中",
		statusConnected: "已连接",
		statusConnecting: "连接中",
		statusUnconfigured: "未配置",
		statusOffline: "未连接",
		statusStopped: "已停止",
		statusOutboundFailing: "已连接 · 出站异常",
		statusInboundFailing: "已连接 · 长连接断开",
		outboundFailures: "出站请求连续失败",
		outboundUnobserved: "尚未观测到出站请求",
		inboundState: "长连接",
		inboundRetries: "重连次数",
		application: "应用凭据",
		appId: "App ID",
		domain: "平台",
		appSecret: "App Secret",
		secretPlaceholder: "留空表示保留现有 Secret",
		credentialConfigured: "Secret 已配置",
		credentialMissing: "Secret 未配置",
		readOnly: "由配置或启动环境提供，只读",
		scanToConfigure: "扫码配置",
		provisionStarting: "正在生成二维码……",
		provisionPreparing: "正在向飞书申请二维码……（需要这台机器能访问 open.feishu.cn）",
		scanHint: "请用飞书 App 扫描二维码完成授权",
		provisioning: "正在配置应用……",
		provisionFailed: "配置失败",
		provisionTimeout: "没有从飞书授权服务拿到二维码：请确认这台机器能访问 open.feishu.cn（代理 / VPN / 防火墙），然后重试",
		access: "访问策略",
		requireMention: "群聊中必须 @机器人",
		requireMentionHint: "关闭后群聊里任何消息都会触发",
		dmMode: "单聊策略",
		open: "开放",
		allowlist: "仅白名单",
		disabled: "关闭",
		groupAllowlist: "群聊白名单",
		dmAllowlist: "用户白名单",
		onePerLine: "每行一个 ID",
		reactEmoji: "表情回应",
		reactEmojiHint: "留空表示不添加（默认 THUMBSUP）",
		display: "卡片显示",
		transcriptView: "工作步骤展示",
		transcriptViewHint: "对齐 DSH WebUI 的四档：简洁只报工具调用计数、标准每个工具一行摘要（推理只给首行）、详细（默认）带参数与结果、完全展开给出推理全文且不截断。下面四个开关只能在此基础上再关掉内容，不会让卡片比档位更详细。",
		transcriptViewCompact: "简洁",
		transcriptViewStandard: "标准",
		transcriptViewDetailed: "详细（默认）",
		transcriptViewVerbose: "完全展开",
		showReasoning: "显示思考过程",
		showReasoningHint: "步骤卡上展示模型的 reasoning 预览（最多 200 字）",
		showToolCalls: "显示工具调用",
		showToolCallsHint: "关闭后步骤卡不显示任何工具信息，只有工具的步骤不再发卡",
		showToolArgs: "显示参数",
		showToolArgsHint: "展示每个工具调用的入参 JSON",
		showToolResults: "显示结果",
		showToolResultsHint: "展示每个工具调用的结果预览",
		reasoningPreviewChars: "推理预览长度（字）",
		reasoningPreviewCharsHint: "详细档里折叠的推理只保留前 N 个字（默认 200，范围 80–4000）；完全展开档显示全文，不受此限。",
		resultPreviewChars: "工具结果预览长度（字）",
		resultPreviewCharsHint: "单个工具结果预览的字数上限（默认 1500，范围 200–6000）；完全展开档最多显示 4 倍（封顶 6000，卡片整体约 30KB 会被拒收）。",
		argsPreviewChars: "工具参数预览长度（字）",
		argsPreviewCharsHint: "单个工具调用参数块的字符上限（默认 2000，范围 200–6000）；完全展开档最多 4 倍（封顶 6000）。",
		requiresToolCalls: "需先开启「显示工具调用」",
		cardImages: "正文里的媒体",
		cardImagesHint: "飞书卡片只能显示上传过的媒体：这里决定正文里 ![图](路径)、[视频](路径)、[语音](路径) 这类引用怎么处理。图片与 MP4 视频直接内联，音频转成 Opus 播放器（需要 ffmpeg）；无论选哪档，卡片都不会因为媒体语法被拒收。",
		cardImagesWorkspace: "仅工作区内（默认）：自动上传并内联显示",
		cardImagesText: "不上传：只显示路径文字",
		cardImagesAny: "任意可读路径：工作区外的媒体也上传",
		produceCardDelivery: "自动投递（默认）",
		produceCardSummary: "只在卡上报个数",
		produceCardOff: "不处理",
		cardMediaLimit: "单卡媒体上限",
		cardMediaLimitHint: "一张卡里最多内联几个：图片算一处、视频与音频合起来算一处（各按这个数），1–30，默认 12；超出的一律退回可读路径文字。飞书本身能放更多（一张卡 200 个元素/组件，带封面的视频一个占 3 个名额、约 66 个），这个数字只是为了让消息别太长。",
		cardImageMaxMb: "图片内联上限（MB）",
		cardImageMaxMbHint: "超过这个大小的图片不上传、只留路径文字。范围 1–10，默认 10 —— 飞书的图片上传接口硬上限就是 10MB，写更大也不会生效。",
		cardVideoMaxMb: "视频内联上限（MB）",
		cardVideoMaxMbHint: "超过这个大小的视频不上传、只留路径文字。范围 1–30，默认 15；飞书文件接口硬上限 30MB。数字越大，卡片等上传的时间越长（已有预热与并发，但大文件仍会慢）。",
		cardAudioMaxMb: "音频内联上限（MB）",
		cardAudioMaxMbHint: "超过这个大小的音频不上传、只留路径文字。范围 1–30，默认 15；飞书文件接口硬上限 30MB。非 Opus 的音频还要先转码，另受 ffmpeg 是否可用的影响。",
		deliverDocMaxMb: "文档自动投递上限（MB）",
		deliverDocMaxMbHint: "`present` 声明的 pdf / doc / docx / ppt / pptx / xls / xlsx 不超过这个大小就直接发成飞书文件消息；超过它的文档、以及所有其他文件（源码、压缩包等）都变成交付清单里可点的一行，点一下弹确认卡，确认后才发送。范围 1–30，默认 30（飞书文件接口硬上限）。",
		produceCard: "本轮产出物",
		produceCardHint: "一轮里模型用 write/edit 写过、但没有用 `present` 声明的文件：源码、测试、临时脚本这类**永不投递**（这里是聊天，不是文件浏览器）；只有图片/视频/音频与 pdf/office 文档会被当成交付物。选「自动投递」（默认）会把这些产出物走和 `present` 完全一样的路：媒体内联在卡上、文档不超过上限就发成文件消息、其余给可点的一行；选「只在卡上报个数」只加一行「本回合新生成 N 个文件」；选「不处理」则完全静默。",
		locale: "插件语言",
		localeAuto: "跟随 Harness",
		localeZh: "中文",
		localeEn: "English",
		save: "保存并重新连接",
		saving: "正在保存......",
		saved: "已保存",
		saveFailed: "保存失败",
		loadFailed: "读取失败",
		removeSecret: "删除已保存的 Secret",
		removing: "正在删除......",
		removed: "Secret 已删除",
		removeFailed: "删除失败"
	},
	en: {
		nav: "Lark",
		title: "Feishu & Lark",
		subtitle: "Configure the message channel and card display without restarting Harness",
		connectionMoved: "Connection status and scan-to-configure live on the Plugins → Lark detail page.",
		connectionTitle: "Connection & scan",
		connectionHint: "Authorization happens in the Feishu app: use Scan to configure in this page's header and the QR code appears here.",
		rescan: "Scan again",
		provisionDone: "Authorization complete",
		statusReading: "Reading...",
		statusConnected: "Connected",
		statusConnecting: "Connecting",
		statusUnconfigured: "Not configured",
		statusOffline: "Not connected",
		statusStopped: "Stopped",
		statusOutboundFailing: "Connected · outbound failing",
		statusInboundFailing: "Connected · long connection down",
		outboundFailures: "Consecutive outbound failures",
		outboundUnobserved: "No outbound request observed yet",
		inboundState: "Long connection",
		inboundRetries: "Reconnect attempts",
		application: "Application credentials",
		appId: "App ID",
		domain: "Platform",
		appSecret: "App Secret",
		secretPlaceholder: "Leave blank to keep the stored secret",
		credentialConfigured: "Secret configured",
		credentialMissing: "Secret missing",
		readOnly: "Provided by config or launch environment; read-only",
		scanToConfigure: "Scan to configure",
		provisionStarting: "Generating QR code...",
		provisionPreparing: "Requesting a QR code from Feishu... (this machine must be able to reach open.feishu.cn)",
		scanHint: "Scan the QR code with the Feishu app to authorize",
		provisioning: "Configuring app...",
		provisionFailed: "Configuration failed",
		provisionTimeout: "No QR code from the Feishu authorization service: check that this machine can reach open.feishu.cn (proxy / VPN / firewall), then retry",
		access: "Access policy",
		requireMention: "Require @mention in group chats",
		requireMentionHint: "When off, any group message triggers the bot",
		dmMode: "Direct messages",
		open: "Open",
		allowlist: "Allowlist only",
		disabled: "Disabled",
		groupAllowlist: "Group allowlist",
		dmAllowlist: "User allowlist",
		onePerLine: "One ID per line",
		reactEmoji: "Emoji reaction",
		reactEmojiHint: "Leave empty to disable (default THUMBSUP)",
		display: "Card display",
		transcriptView: "Work details",
		transcriptViewHint: "The DSH WebUI's four levels: Compact counts tool calls only, Standard gives each call one summary line (reasoning first line only), Detailed (default) adds arguments and result previews, Verbose shows the whole reasoning untruncated. The four switches below can only remove detail from the level, never add.",
		transcriptViewCompact: "Compact",
		transcriptViewStandard: "Standard",
		transcriptViewDetailed: "Detailed (default)",
		transcriptViewVerbose: "Verbose",
		showReasoning: "Show reasoning",
		showReasoningHint: "Show the model reasoning preview on step cards",
		showToolCalls: "Show tool calls",
		showToolCallsHint: "When off, step cards show no tool details and tool-only steps post no card",
		showToolArgs: "Show arguments",
		showToolArgsHint: "Show each tool call's argument JSON",
		showToolResults: "Show results",
		showToolResultsHint: "Show each tool call's result preview",
		reasoningPreviewChars: "Reasoning preview length (chars)",
		reasoningPreviewCharsHint: "The folded reasoning head at the detailed level keeps this many characters (default 200, range 80-4000); the verbose level shows the whole chain and ignores it.",
		resultPreviewChars: "Tool result preview length (chars)",
		resultPreviewCharsHint: "Character cap for one tool result preview (default 1500, range 200-6000). The verbose level shows up to 4x, capped at 6000 because a card near 30 KB is refused whole.",
		argsPreviewChars: "Tool arguments length (chars)",
		argsPreviewCharsHint: "Character cap for one tool call's arguments block (default 2000, range 200-6000). The verbose level shows up to 4x, capped at 6000.",
		requiresToolCalls: "Enable \"Show tool calls\" first",
		cardImages: "Media in card text",
		cardImagesHint: "A Feishu card can only render media it uploaded itself: this decides what happens to `![alt](path)`, `[clip](path)` and `[voice](path)` references in the model's text. Images and MP4 video are inlined, audio becomes an Opus player (needs ffmpeg). Whichever mode you pick, a card is never rejected over media syntax.",
		cardImagesWorkspace: "Workspace only (default): upload and show inline",
		cardImagesText: "Never upload: show the path as text",
		cardImagesAny: "Any readable path: upload media outside the workspace too",
		produceCardDelivery: "Deliver (default)",
		produceCardSummary: "Count only",
		produceCardOff: "Ignore",
		cardMediaLimit: "Media per card",
		cardMediaLimitHint: "How many media one card may inline, counted per group: images on the one hand, video and audio together on the other, 1-30, default 12; anything past it stays a readable path. Feishu itself allows far more (200 elements/components per card, and a video with a cover spends three, so about 66 videos) — this number is here to keep a message readable.",
		cardImageMaxMb: "Image inline limit (MB)",
		cardImageMaxMbHint: "An image larger than this is not uploaded — its path stays as text. Range 1-10, default 10: Feishu's image upload API caps at 10 MB, so a larger value could never take effect.",
		cardVideoMaxMb: "Video inline limit (MB)",
		cardVideoMaxMbHint: "A video larger than this is not uploaded — its path stays as text. Range 1-30, default 15; Feishu's file API caps at 30 MB. Bigger files only cost wait: the upload happens on the card-write path (warming and concurrency help, but a large file is still slow).",
		cardAudioMaxMb: "Audio inline limit (MB)",
		cardAudioMaxMbHint: "Audio larger than this is not uploaded — its path stays as text. Range 1-30, default 15; Feishu's file API caps at 30 MB. Non-Opus audio is transcoded first, so ffmpeg has to be available.",
		deliverDocMaxMb: "Document auto-send limit (MB)",
		deliverDocMaxMbHint: "A pdf / doc / docx / ppt / pptx / xls / xlsx declared by `present` under this size is pushed as a Feishu file message by itself. Larger documents — and every other file (source code, archives, …) — become a tappable row on the Turn Complete card: one tap opens a confirmation, and only that sends. Range 1-30, default 30 (Feishu's file API cap).",
		produceCard: "Produced files",
		produceCardHint: "Files a turn wrote with write/edit but never declared through `present`: source code, tests and scratch scripts are NEVER delivered (this is a chat, not a file browser) - only images/video/audio and pdf/office documents count as artifacts. \"Deliver\" (default) sends those through exactly the same path as `present`: media inline on the card, documents under the size limit as file messages, the rest as a tappable row. \"Count only\" adds one line (\"N file(s) produced this turn\"). \"Ignore\" stays silent.",
		locale: "Plugin language",
		localeAuto: "Follow Harness",
		localeZh: "中文",
		localeEn: "English",
		save: "Save and reconnect",
		saving: "Saving...",
		saved: "Saved",
		saveFailed: "Save failed",
		loadFailed: "Unable to read status",
		removeSecret: "Remove stored secret",
		removing: "Removing...",
		removed: "Secret removed",
		removeFailed: "Remove failed"
	}
};
const name = "dsh-feishu";
const inject = [
	"slots",
	"locale",
	"remote",
	"remote.credentials",
	"configForms"
];
function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, dictionaries), "dsh-feishu: client dictionaries");
	ctx.effect(() => {
		const style = document.createElement("style");
		style.dataset.plugin = NS;
		style.textContent = CLIENT_CSS;
		document.head.appendChild(style);
		return () => style.remove();
	}, "dsh-feishu: client styles");
	const t = ctx.locale.bind(NS);
	const card = new LarkSettingsCardController(ctx.configForms.get(LARK_SETTINGS_NAMESPACE), ctx, t);
	ctx.effect(() => () => {
		card.dispose();
	}, "dsh-feishu: settings form subscription");
	const status = new LarkChannelStatusController(t, { onProvisionCompleted: () => {
		card.rereadCredential();
	} });
	ctx.effect(() => () => {
		status.dispose();
	}, "dsh-feishu: channel status lifetime");
	ctx.effect(() => ctx.remote.$on("credentials/reference-updated", (ref) => {
		card.refreshCredential(ref);
	}), "dsh-feishu: credential invalidations");
	ctx.effect(() => ctx.configForms.whileServed([LARK_SETTINGS_NAMESPACE], () => {
		const off = [];
		off.push(ctx.slots.inject("settings.section", () => ctx.slots.register({
			name: "settings.section",
			id: "lark",
			order: 45,
			label: () => t("nav"),
			locale: NS,
			inject: () => card.inject()
		}, LarkSettingsCard)));
		for (const [slot, component] of [
			["plugins.detail.badge", LarkConnectionBadge],
			["plugins.detail.actions", LarkConnectionAction],
			["plugins.detail.section", LarkChannelSection]
		]) off.push(ctx.slots.inject(slot, () => ctx.slots.register({
			name: slot,
			id: LARK_ENTRY_ID,
			order: 60,
			label: () => t("nav"),
			locale: NS,
			inject: () => status.face()
		}, component)));
		return () => {
			for (const dispose of off) dispose();
		};
	}), "dsh-feishu: settings page and plugin detail");
}

//#endregion
exports.apply = apply;
exports.inject = inject;
exports.name = name;
return module.exports; } });
//# sourceMappingURL=client.js.map