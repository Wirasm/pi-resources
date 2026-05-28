// @ts-nocheck
/**
 * coms-net — HTTP/SSE Pi Agent Communication Network (client)
 *
 * Usage:
 *   bun scripts/coms-net-server.ts
 *   pi -e .pi/extensions/coms-net.ts --name planner --project default
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { applyExtensionDefaults } from "./lib/themeMap.ts";

const COMS_NET_DIR = path.join(os.homedir(), ".pi", "coms-net");
const HEARTBEAT_MS = Number(process.env.PI_COMS_NET_HEARTBEAT_MS) || 10_000;
const MESSAGE_TIMEOUT_MS = Number(process.env.PI_COMS_NET_MESSAGE_TTL_MS) || 1_800_000;
const MAX_HOPS = Number(process.env.PI_COMS_NET_MAX_HOPS) || 5;
const HTTP_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const PALETTE = ["#72F1B8", "#36F9F6", "#FF7EDB", "#FEDE5D", "#C792EA", "#FF8B39", "#4D9DE0", "#FFAA8B"];

type AgentStatus = "online" | "stale" | "offline";
type MessageStatus = "queued" | "delivered" | "complete" | "error" | "timeout";
type AgentCard = { session_id: string; name: string; purpose: string; model: string; color: string; cwd: string; project: string; explicit: boolean; started_at: string; context_used_pct: number; queue_depth: number; status: AgentStatus };
type InboundContext = { msg_id: string; hops: number; sender_session: string; sender_name: string; sender_cwd: string; response_schema?: object | null; fulfilled: boolean };
type PendingReply = { resolve: (v: any) => void; promise: Promise<any>; result?: any; created_at: number; target_name?: string; target_session?: string };

class HttpError extends Error { constructor(public status: number, public body: any, message?: string) { super(message ?? `HTTP ${status}`); } }

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid() { let t = Date.now(); let time = ""; for (let i = 0; i < 10; i++) { time = CROCKFORD[t % 32] + time; t = Math.floor(t / 32); } let out = ""; let bits = 0; let v = 0; for (const b of crypto.randomBytes(10)) { v = (v << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out += CROCKFORD[(v >> bits) & 31]; } } return (time + out).slice(0, 26); }
function nowIso() { return new Date().toISOString(); }
function safeProject(project: string) { if (!/^[a-zA-Z0-9._-]+$/.test(project)) throw new Error(`invalid coms-net project: ${project}`); return project; }
function projectDir(project: string) { return path.join(COMS_NET_DIR, "projects", safeProject(project)); }
function hexFg(hex: string, s: string) { const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16); return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`; }
function fallbackColor(id: string) { const h = crypto.createHash("sha256").update(id).digest("hex").slice(0, 8); return PALETTE[Number(BigInt("0x" + h)) % PALETTE.length]; }
function modelShort(model: string) { let m = model || ""; if (m.startsWith("claude-")) m = m.slice(7); return m.length > 16 ? m.slice(0, 16) : m; }
function parseFrontmatter(raw: string) { const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/); if (!m) return {}; const out: Record<string, string> = {}; for (const line of m[1].split(/\r?\n/)) { const i = line.indexOf(":"); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, ""); } return out; }
function findPromptPath(argv: string[]) { for (const flag of ["--system-prompt", "--append-system-prompt"]) for (let i = 0; i < argv.length - 1; i++) if (argv[i] === flag && argv[i + 1].endsWith(".md") && fs.existsSync(argv[i + 1])) return argv[i + 1]; return null; }
function readIdentityFromPrompt() { try { const p = findPromptPath(process.argv); return p ? parseFrontmatter(fs.readFileSync(p, "utf-8")) : {}; } catch { return {}; } }
function readServerJson(project: string) { try { const p = path.join(projectDir(project), "server.json"); if (!fs.existsSync(p)) return null; const parsed = JSON.parse(fs.readFileSync(p, "utf-8")); return typeof parsed?.local_url === "string" ? parsed : null; } catch { return null; } }
function readSecret(project: string) { try { const p = path.join(projectDir(project), "server.secret.json"); if (!fs.existsSync(p)) return null; if ((fs.statSync(p).mode & 0o777) !== 0o600) return null; const parsed = JSON.parse(fs.readFileSync(p, "utf-8")); return typeof parsed?.token === "string" ? parsed.token : null; } catch { return null; } }
function assistantText(message: any) { const c = message?.content; if (typeof c === "string") return c; if (!Array.isArray(c)) return ""; return c.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n"); }

export default function (pi: ExtensionAPI) {
	pi.registerFlag("name", { type: "string", description: "coms-net agent name", default: undefined });
	pi.registerFlag("purpose", { type: "string", description: "coms-net agent purpose", default: undefined });
	pi.registerFlag("project", { type: "string", description: "coms-net project", default: "default" });
	pi.registerFlag("color", { type: "string", description: "Hex color #RRGGBB", default: undefined });
	pi.registerFlag("explicit", { type: "boolean", description: "Hide from default peer lists", default: false });
	pi.registerFlag("server-url", { type: "string", description: "coms-net hub URL", default: undefined });
	pi.registerFlag("auth-token", { type: "string", description: "coms-net hub bearer token", default: undefined });

	let identity: any = null;
	let serverUrl: string | null = null;
	let authToken: string | null = null;
	let ssePath: string | null = null;
	let currentCtx: ExtensionContext | null = null;
	let sseAbort: AbortController | null = null;
	let heartbeatTimer: any = null;
	let reconnectTimer: any = null;
	let reconnectAttempts = 0;
	let shuttingDown = false;
	let includeExplicit = false;
	let lastSnapshot = "";
	const peers = new Map<string, AgentCard>();
	const pending = new Map<string, PendingReply>();
	const inbound = new Map<string, InboundContext>();

	function safeError(err: any) { const msg = err instanceof Error ? err.message : String(err); return authToken ? msg.split(authToken).join("<redacted>") : msg; }
	function audit(event: string, extra: any = {}) { try { pi.appendEntry("coms-net-log", { event, ts: nowIso(), ...extra }); } catch {} }
	async function httpFetch(method: string, urlPath: string, body?: any, opts?: { timeoutMs?: number; signal?: AbortSignal; auth?: boolean }) {
		if (!serverUrl) throw new Error("coms-net: no server URL");
		if (opts?.auth !== false && !authToken) throw new Error("coms-net: no auth token");
		const headers: Record<string, string> = { Accept: "application/json" };
		if (opts?.auth !== false) headers.Authorization = `Bearer ${authToken}`;
		const init: any = { method, headers };
		if (body !== undefined) { headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
		let timer: any = null; const ac = new AbortController();
		if (opts?.signal) init.signal = opts.signal; else { init.signal = ac.signal; timer = setTimeout(() => ac.abort(), opts?.timeoutMs ?? HTTP_TIMEOUT_MS); timer.unref?.(); }
		let resp: Response; try { resp = await fetch(serverUrl + urlPath, init); } catch (e: any) { if (timer) clearTimeout(timer); throw new Error(`coms-net: fetch failed: ${e?.message ?? String(e)}`); }
		if (timer) clearTimeout(timer);
		const text = await resp.text(); let parsed: any = null; if (text) try { parsed = JSON.parse(text); } catch { parsed = text; }
		if (!resp.ok) throw new HttpError(resp.status, parsed, `HTTP ${resp.status} ${method} ${urlPath}`);
		return parsed;
	}
	function parser(onEvent: (event: string, data: any) => void) { const dec = new TextDecoder(); let buf = ""; return { feed(chunk: Uint8Array) { buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, "\n"); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const frame = buf.slice(0, i); buf = buf.slice(i + 2); let event = "message"; const dataLines: string[] = []; for (const line of frame.split("\n")) { if (line.startsWith("event:")) event = line.slice(6).trimStart(); else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart()); } if (dataLines.length) { const raw = dataLines.join("\n"); let data: any = raw; try { data = JSON.parse(raw); } catch {} try { onEvent(event, data); } catch {} } } } }; }
	function snapshot() { return [...peers.values()].map((p) => `${p.session_id}|${p.name}|${p.status}|${p.context_used_pct}|${p.queue_depth}|${p.model}|${p.explicit}`).sort().join("\n"); }
	function refreshWidget() { const s = snapshot(); if (s === lastSnapshot) return; lastSnapshot = s; if (currentCtx?.hasUI) installWidget(currentCtx); }
	function setPeer(a: AgentCard) { if (identity && a.session_id === identity.session_id) return; peers.set(a.session_id, a); refreshWidget(); }
	function handleSse(event: string, data: any) {
		if (!data || typeof data !== "object") return;
		if (event === "pool_snapshot") { peers.clear(); for (const a of data.agents ?? []) setPeer(a); refreshWidget(); }
		else if (event === "agent_joined") setPeer(data.agent);
		else if (event === "agent_updated") { const prev = peers.get(data.agent?.session_id); if (prev) setPeer({ ...prev, ...data.agent }); }
		else if (event === "agent_stale") { const p = peers.get(data.session_id); if (p) setPeer({ ...p, status: "stale" }); }
		else if (event === "agent_left") { if (peers.delete(data.session_id)) refreshWidget(); }
		else if (event === "prompt") handlePrompt(data);
		else if (event === "response") handleResponse(data);
		else if (event === "hello") audit("sse_hello", { server_id: data.server_id });
	}
	function handlePrompt(data: any) {
		const msg_id = data?.msg_id; if (!msg_id) return;
		const sender = data.sender ?? {}; const ctx: InboundContext = { msg_id, hops: data.hops ?? 0, sender_session: sender.session_id ?? "?", sender_name: sender.name ?? "unknown", sender_cwd: sender.cwd ?? "?", response_schema: data.response_schema ?? null, fulfilled: false };
		inbound.set(msg_id, ctx);
		pi.sendMessage({ customType: "coms-net-inbound", display: true, details: ctx, content: `[inbound coms-net message from ${ctx.sender_name} @ ${ctx.sender_cwd}]\n[Reply by writing a normal assistant message. Do NOT call coms_net_send/coms_net_get/coms_net_await to answer this inbound message.]\n[msg_id=${msg_id}]\n\n${data.prompt ?? ""}` }, { deliverAs: "followUp", triggerTurn: true });
		audit("prompt_in", { msg_id, sender: ctx.sender_session, hops: ctx.hops });
	}
	function handleResponse(data: any) { const msg_id = data?.msg_id; const p = pending.get(msg_id); if (!p) return audit("orphan_response", { msg_id }); p.result = { response: data.response, error: data.error ?? null }; p.resolve(p.result); audit("response_in", { msg_id, error: p.result.error }); }
	async function openSse() { if (!serverUrl || !authToken || !ssePath || !identity || shuttingDown) return; if (sseAbort) sseAbort.abort(); const ac = new AbortController(); sseAbort = ac; let resp: Response; try { resp = await fetch(serverUrl + ssePath, { headers: { Authorization: `Bearer ${authToken}`, Accept: "text/event-stream" }, signal: ac.signal }); } catch (e) { audit("sse_connect_failed", { reason: safeError(e) }); scheduleReconnect(); return; } if (!resp.ok || !resp.body) { audit("sse_connect_http_error", { status: resp.status }); scheduleReconnect(); return; } reconnectAttempts = 0; const p = parser(handleSse); const reader = resp.body.getReader(); try { while (true) { const { done, value } = await reader.read(); if (done) break; if (value) p.feed(value); } } catch (e) { if (!ac.signal.aborted) audit("sse_disconnect", { reason: safeError(e) }); } finally { try { reader.releaseLock(); } catch {} } if (!shuttingDown && !ac.signal.aborted) scheduleReconnect(); }
	function scheduleReconnect() { if (shuttingDown || reconnectTimer) return; const backoff = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts++, RECONNECT_MAX_MS); reconnectTimer = setTimeout(async () => { reconnectTimer = null; if (shuttingDown) return; try { const reg = await register(); ssePath = reg.sse_url; void openSse(); } catch (e) { audit("reconnect_failed", { reason: safeError(e) }); scheduleReconnect(); } }, backoff); reconnectTimer.unref?.(); }
	async function register() { if (!identity) throw new Error("coms-net not initialized"); const resp = await httpFetch("POST", "/v1/agents/register", { project: identity.project, session_id: identity.session_id, name: identity.name, purpose: identity.purpose, model: currentCtx?.model?.id ?? identity.model, color: identity.color, cwd: identity.cwd, explicit: identity.explicit }); if (resp.agent?.name && resp.agent.name !== identity.name) identity.name = resp.agent.name; audit("register", { session_id: identity.session_id, name: identity.name, project: identity.project }); return resp; }
	function renderPool(width: number, theme: Theme) { const rows = [...peers.values()].filter((p) => includeExplicit || !p.explicit).sort((a, b) => a.name.localeCompare(b.name)); const top = theme.fg("dim", `┏━`) + theme.fg("border", " coms-net ") + theme.fg("dim", "━".repeat(Math.max(0, width - 13)) + "┓"); const bot = theme.fg("dim", "┗" + "━".repeat(Math.max(0, width - 2)) + "┛"); if (!rows.length) return [top, truncateToWidth(" " + theme.fg("muted", "no peers connected"), width), bot]; const out = [top]; for (const r of rows) { const pct = typeof r.context_used_pct === "number" ? r.context_used_pct : 0; const fill = Math.max(0, Math.min(12, Math.round((pct / 100) * 12))); const dot = r.status === "online" ? hexFg(r.color, "●") : r.status === "stale" ? theme.fg("warning", "~") : theme.fg("error", "✗"); const line = ` ${dot} ${theme.fg("accent", r.name.padEnd(12))} ${theme.fg("dim", modelShort(r.model).padEnd(16))} ${hexFg(r.color, "#".repeat(fill))}${theme.fg("dim", "-".repeat(12 - fill))} ${theme.fg("warning", `${pct}%`.padStart(4))} ${theme.fg("muted", r.purpose || "")}`; out.push(truncateToWidth(line, width)); } out.push(bot); return out; }
	function installWidget(ctx: ExtensionContext) { if (!ctx.hasUI) return; ctx.ui.setWidget("coms-net-pool", (_tui, theme) => ({ invalidate() {}, render(width: number) { return renderPool(width, theme); } }), { placement: "belowEditor" }); }
	function cleanupPending() { const cutoff = Date.now() - MESSAGE_TIMEOUT_MS; for (const [id, p] of pending) if (p.created_at < cutoff || p.result) pending.delete(id); }

	pi.registerMessageRenderer("coms-net-inbound", (message, _options, theme) => new Text(theme.fg("accent", "📡 inbound coms-net") + "\n" + theme.fg("muted", typeof message.content === "string" ? message.content : JSON.stringify(message.content)), 0, 0));

	pi.registerTool({ name: "coms_net_list", label: "Coms Net List", description: "List peer agents on the coms-net hub for the current project.", parameters: Type.Object({ include_explicit: Type.Optional(Type.Boolean()) }), async execute(_id, params) { if (!identity) throw new Error("coms-net not initialized"); const inc = params.include_explicit === true; const resp = await httpFetch("GET", `/v1/agents?project=${encodeURIComponent(identity.project)}&include_explicit=${inc}`); const agents = (resp.agents ?? []).filter((a: any) => a.session_id !== identity.session_id); return { content: [{ type: "text" as const, text: agents.length ? agents.map((a: any) => `${a.status === "online" ? "●" : a.status === "stale" ? "~" : "✗"} ${a.name} (${modelShort(a.model)}) ${a.context_used_pct ?? "?"}%${a.purpose ? ` — ${a.purpose}` : ""}`).join("\n") : "No peer agents found." }], details: { agents } }; }, renderCall(_args, theme) { return new Text(theme.fg("toolTitle", theme.bold("coms_net_list")), 0, 0); }, renderResult(result, _opts, theme) { const n = (result.details as any)?.agents?.length ?? 0; return new Text(theme.fg("accent", `📡 ${n} peer(s)`), 0, 0); } });
	pi.registerTool({ name: "coms_net_send", label: "Coms Net Send", description: "Send a new outbound prompt to a peer. Do not use to reply to inbound coms-net messages; reply normally.", parameters: Type.Object({ target: Type.String(), prompt: Type.String(), conversation_id: Type.Optional(Type.String()), response_schema: Type.Optional(Type.Any()) }), async execute(_id, params) { if (!identity) throw new Error("coms-net not initialized"); const activeInbound = [...inbound.values()].find((i) => !i.fulfilled); const hops = activeInbound ? activeInbound.hops + 1 : 0; if (hops >= MAX_HOPS) throw new Error(`coms-net hop limit reached (${hops})`); const resp = await httpFetch("POST", "/v1/messages", { project: identity.project, sender_session: identity.session_id, target: params.target, target_session: null, prompt: params.prompt, conversation_id: params.conversation_id ?? null, response_schema: params.response_schema ?? null, hops }); let resolveFn: any; const promise = new Promise((res) => resolveFn = res); pending.set(resp.msg_id, { resolve: resolveFn, promise, created_at: Date.now(), target_name: params.target, target_session: resp.target_session }); cleanupPending(); return { content: [{ type: "text" as const, text: `coms_net_send -> ${params.target}\nmsg_id ${resp.msg_id}` }], details: { msg_id: resp.msg_id, target: params.target, target_session: resp.target_session, hops } }; }, renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("coms_net_send ")) + theme.fg("accent", (args as any).target ?? "?"), 0, 0); }, renderResult(result, _opts, theme) { const d = result.details as any; return new Text(theme.fg("success", "→ ") + theme.fg("accent", d?.target ?? "?") + theme.fg("dim", ` msg_id ${d?.msg_id ?? "?"}`), 0, 0); } });
	pi.registerTool({ name: "coms_net_get", label: "Coms Net Get", description: "Non-blocking poll for a reply to your own coms_net_send msg_id.", parameters: Type.Object({ msg_id: Type.String() }), async execute(_id, params) { const p = pending.get(params.msg_id); if (p?.result) { pending.delete(params.msg_id); const r = p.result; return { content: [{ type: "text" as const, text: r.error ? `error: ${r.error}` : typeof r.response === "string" ? r.response : JSON.stringify(r.response, null, 2) }], details: { status: r.error ? "error" : "complete", ...r } }; } const resp = await httpFetch("GET", `/v1/messages/${encodeURIComponent(params.msg_id)}`).catch((e) => ({ status: "error", error: safeError(e) })); if (["complete", "error", "timeout"].includes(resp.status)) pending.delete(params.msg_id); return { content: [{ type: "text" as const, text: resp.error ? `${resp.status}: ${resp.error}` : resp.status === "complete" ? (typeof resp.response === "string" ? resp.response : JSON.stringify(resp.response, null, 2)) : resp.status }], details: resp }; }, renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("coms_net_get ")) + theme.fg("warning", (args as any).msg_id ?? "?"), 0, 0); }, renderResult(result, _opts, theme) { const s = (result.details as any)?.status ?? "?"; return new Text(theme.fg(s === "complete" ? "success" : s === "error" ? "error" : "warning", s), 0, 0); } });
	pi.registerTool({ name: "coms_net_await", label: "Coms Net Await", description: "Wait for a reply to your own coms_net_send msg_id.", parameters: Type.Object({ msg_id: Type.String(), timeout_ms: Type.Optional(Type.Number()) }), async execute(_id, params) { const p = pending.get(params.msg_id); const timeoutMs = params.timeout_ms && params.timeout_ms > 0 ? params.timeout_ms : MESSAGE_TIMEOUT_MS; const local = p ? p.promise : new Promise(() => {}); const server = httpFetch("GET", `/v1/messages/${encodeURIComponent(params.msg_id)}/await?timeout_ms=${Math.min(timeoutMs, MESSAGE_TIMEOUT_MS)}`, undefined, { timeoutMs: timeoutMs + 5000 }).catch((e) => ({ status: "error", error: safeError(e) })); const winner: any = await Promise.race([local, server, new Promise((res) => setTimeout(() => res({ error: "timeout" }), timeoutMs))]); pending.delete(params.msg_id); const err = winner.error ?? (winner.status === "error" || winner.status === "timeout" ? winner.error ?? winner.status : null); return { content: [{ type: "text" as const, text: err ? `coms_net_await: error — ${err}` : typeof winner.response === "string" ? winner.response : JSON.stringify(winner.response, null, 2) }], details: err ? { error: err } : { response: winner.response } }; }, renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("coms_net_await ")) + theme.fg("warning", (args as any).msg_id ?? "?"), 0, 0); }, renderResult(result, _opts, theme) { const e = (result.details as any)?.error; return new Text(theme.fg(e ? "error" : "success", e ? `✗ ${e}` : "✓ response received"), 0, 0); } });

	pi.registerCommand("coms-net", { description: "Refresh/toggle coms-net widget. Args: --all --server --reconnect", handler: async (args, ctx) => { const t = args ?? ""; if (t.includes("--all")) includeExplicit = !includeExplicit; if (t.includes("--reconnect")) { sseAbort?.abort(); const reg = await register(); ssePath = reg.sse_url; void openSse(); } if (t.includes("--server")) { const health = await httpFetch("GET", "/health", undefined, { auth: false }); ctx.ui.notify(`coms-net server ${serverUrl} id=${health.server_id}`, "info"); } try { if (identity) { const resp = await httpFetch("GET", `/v1/agents?project=${encodeURIComponent(identity.project)}&include_explicit=${includeExplicit}`); peers.clear(); for (const a of resp.agents ?? []) if (a.session_id !== identity.session_id) peers.set(a.session_id, a); lastSnapshot = ""; refreshWidget(); } } catch (e) { audit("refresh_failed", { reason: safeError(e) }); } } });

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx); currentCtx = ctx; shuttingDown = false;
		const flags: any = { name: pi.getFlag("name"), purpose: pi.getFlag("purpose"), project: pi.getFlag("project"), color: pi.getFlag("color"), explicit: pi.getFlag("explicit"), serverUrl: pi.getFlag("server-url"), authToken: pi.getFlag("auth-token") };
		const project = safeProject(flags.project || process.env.PI_COMS_NET_PROJECT || "default");
		serverUrl = (flags.serverUrl || process.env.PI_COMS_NET_SERVER_URL || readServerJson(project)?.local_url || "").replace(/\/+$/, "") || null;
		authToken = flags.authToken || process.env.PI_COMS_NET_AUTH_TOKEN || readSecret(project);
		const sid = ulid(); const fm = readIdentityFromPrompt(); const color = /^#[0-9a-fA-F]{6}$/.test(flags.color || "") ? flags.color : /^#[0-9a-fA-F]{6}$/.test(fm.color || "") ? fm.color : fallbackColor(sid);
		identity = { session_id: sid, name: flags.name || fm.name || `agent-${sid.slice(-6)}`, purpose: flags.purpose || fm.description || "", color, project, explicit: flags.explicit === true, cwd: ctx.cwd || process.cwd(), model: ctx.model?.id ?? "unknown", started_at: nowIso() };
		if (!serverUrl || !authToken) { if (ctx.hasUI) ctx.ui.notify(`📡 coms-net inactive: ${!serverUrl ? "no server URL" : "no auth token"}. Start: bun scripts/coms-net-server.ts`, "warning"); audit("boot_skipped", { no_server_url: !serverUrl, no_auth_token: !authToken, project }); return; }
		try { await httpFetch("GET", "/health", undefined, { auth: false }); const reg = await register(); ssePath = reg.sse_url; if (ctx.hasUI) { ctx.ui.setStatus("coms-net", `📡 ${identity.name}@${identity.project}`); installWidget(ctx); } void openSse(); heartbeatTimer = setInterval(() => { if (!identity || shuttingDown) return; httpFetch("POST", `/v1/agents/${encodeURIComponent(identity.session_id)}/heartbeat`, { project: identity.project, context_used_pct: Math.round(currentCtx?.getContextUsage()?.percent ?? 0), queue_depth: inbound.size, model: currentCtx?.model?.id ?? identity.model, status: "online" }, { timeoutMs: 5000 }).catch((e) => audit("heartbeat_failed", { reason: safeError(e) })); }, HEARTBEAT_MS); heartbeatTimer.unref?.(); } catch (e) { if (ctx.hasUI) ctx.ui.notify(`📡 coms-net boot failed: ${safeError(e)}`, "error"); audit("boot_failed", { reason: safeError(e) }); }
	});

	pi.on("agent_end", async (event) => {
		if (!identity) return;
		const ctx = [...inbound.values()].find((i) => !i.fulfilled); if (!ctx) return;
		const last = [...(event.messages ?? [])].reverse().find((m: any) => m.role === "assistant"); const text = assistantText(last); if (!text) return;
		let response: any = text; let error: string | null = null; if (ctx.response_schema) { try { response = JSON.parse(text); } catch { response = null; error = "response not valid JSON"; } }
		try { await httpFetch("POST", `/v1/messages/${encodeURIComponent(ctx.msg_id)}/response`, { project: identity.project, responder_session: identity.session_id, response, error }); ctx.fulfilled = true; inbound.delete(ctx.msg_id); audit("response_out", { msg_id: ctx.msg_id, error }); } catch (e) { audit("response_out_failed", { msg_id: ctx.msg_id, reason: safeError(e) }); }
	});

	async function cleanShutdown() { if (shuttingDown) return; shuttingDown = true; if (heartbeatTimer) clearInterval(heartbeatTimer); if (reconnectTimer) clearTimeout(reconnectTimer); sseAbort?.abort(); if (identity && serverUrl && authToken) { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 2000); try { await httpFetch("DELETE", `/v1/agents/${encodeURIComponent(identity.session_id)}?project=${encodeURIComponent(identity.project)}`, undefined, { signal: ac.signal }); } catch {} finally { clearTimeout(t); } } if (currentCtx?.hasUI) { try { currentCtx.ui.setWidget("coms-net-pool", undefined); } catch {}; try { currentCtx.ui.setStatus("coms-net", undefined); } catch {}; } }
	pi.on("session_shutdown", async () => { await cleanShutdown(); });
}
