// @ts-nocheck
/**
 * coms-net Bun HTTP/SSE hub server.
 *
 * Usage:
 *   bun scripts/coms-net-server.ts
 *
 * Registry:
 *   ~/.pi/coms-net/projects/<project>/server.json
 *   ~/.pi/coms-net/projects/<project>/server.secret.json (loopback auto-token only)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOST = process.env.PI_COMS_NET_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PI_COMS_NET_PORT ?? 0);
const PROJECT = safeProject(process.env.PI_COMS_NET_PROJECT ?? "default");
const PUBLIC_URL = process.env.PI_COMS_NET_PUBLIC_URL;
const REG_ROOT = path.join(os.homedir(), ".pi", "coms-net");
const ENV_TOKEN = process.env.PI_COMS_NET_AUTH_TOKEN;

const MAX_HOPS = Number(process.env.PI_COMS_NET_MAX_HOPS ?? 5);
const MESSAGE_TTL_MS = Number(process.env.PI_COMS_NET_MESSAGE_TTL_MS ?? 1_800_000);
const MAX_INBOX = Number(process.env.PI_COMS_NET_MAX_INBOX ?? 100);
const HEARTBEAT_MS = Number(process.env.PI_COMS_NET_HEARTBEAT_MS ?? 10_000);
const STALE_AFTER_MS = Number(process.env.PI_COMS_NET_STALE_AFTER_MS ?? 30_000);
const OFFLINE_AFTER_MS = Number(process.env.PI_COMS_NET_OFFLINE_AFTER_MS ?? 60_000);
const SCAN_MS = 5_000;
const KEEPALIVE_MS = 15_000;

let TOKEN = ENV_TOKEN ?? "";
let TOKEN_FILE_OWNED_BY_US = false;
let shuttingDown = false;

type AgentStatus = "online" | "stale" | "offline";
type MessageStatus = "queued" | "delivered" | "complete" | "error" | "timeout";

type AgentCard = {
	session_id: string;
	name: string;
	purpose: string;
	model: string;
	provider?: string;
	color: string;
	cwd: string;
	project: string;
	explicit: boolean;
	started_at: string;
	context_used_pct: number;
	queue_depth: number;
	status: AgentStatus;
};

type RegistryEntry = AgentCard & { registered_at: string; last_seen_at: string };
type ComsMessage = {
	msg_id: string;
	project: string;
	sender_session: string;
	target_session: string;
	prompt: string;
	conversation_id: string | null;
	response_schema: object | null;
	hops: number;
	status: MessageStatus;
	response: any;
	error: string | null;
	created_at: string;
	delivered_at?: string;
	completed_at?: string;
	expires_at: string;
};
type Awaiter = { resolve: (m: ComsMessage) => void; timer: ReturnType<typeof setTimeout> };
type SseWriter = { session_id: string; enqueue: (frame: string) => void; close: () => void; lastId: number };
type ProjectState = {
	agents: Map<string, RegistryEntry>;
	nameIndex: Map<string, Set<string>>;
	messages: Map<string, ComsMessage>;
	streams: Map<string, SseWriter>;
	awaiters: Map<string, Set<Awaiter>>;
};

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const state = { server_id: ulid(), started_at: nowIso(), projects: new Map<string, ProjectState>() };
const timers: Array<ReturnType<typeof setInterval>> = [];

function safeProject(project: string): string {
	if (!/^[a-zA-Z0-9._-]+$/.test(project)) throw new Error(`invalid project name: ${project}`);
	return project;
}
function nowIso() { return new Date().toISOString(); }
function isLoopback(host: string) { return host === "127.0.0.1" || host === "::1" || host === "localhost"; }
function timingEqual(a: string, b: string) {
	const ab = Buffer.from(a); const bb = Buffer.from(b);
	return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function authed(req: Request) {
	const h = req.headers.get("authorization") ?? "";
	return !!TOKEN && h.startsWith("Bearer ") && timingEqual(h.slice(7), TOKEN);
}
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
function errorJson(error: string, status = 400, details?: any) { return json({ ok: false, error, ...(details === undefined ? {} : { details }) }, status); }
function unauthorized() { return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="coms-net"' } }); }
function projectDir(project: string) { return path.join(REG_ROOT, "projects", safeProject(project)); }
function mkdirp(dir: string) { fs.mkdirSync(dir, { recursive: true }); }
function atomicWrite(file: string, content: string, mode?: number) { mkdirp(path.dirname(file)); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, content); if (mode) fs.chmodSync(tmp, mode); fs.renameSync(tmp, file); }

function ulid() {
	let t = Date.now(); let time = "";
	for (let i = 0; i < 10; i++) { time = CROCKFORD[t % 32] + time; t = Math.floor(t / 32); }
	let out = ""; let bits = 0; let value = 0;
	for (const byte of crypto.randomBytes(10)) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; out += CROCKFORD[(value >> bits) & 31]; } }
	return (time + out).slice(0, 26);
}
function sseFrame(event: string, data: unknown, id?: number) { return [`event: ${event}`, id === undefined ? undefined : `id: ${id}`, `data: ${JSON.stringify(data)}`].filter(Boolean).join("\n") + "\n\n"; }
function pstate(project: string): ProjectState {
	project = safeProject(project);
	let p = state.projects.get(project);
	if (!p) { p = { agents: new Map(), nameIndex: new Map(), messages: new Map(), streams: new Map(), awaiters: new Map() }; state.projects.set(project, p); }
	return p;
}
function card(e: RegistryEntry): AgentCard { const { last_seen_at, registered_at, ...c } = e; return c; }
function indexAdd(p: ProjectState, name: string, sid: string) { const set = p.nameIndex.get(name) ?? new Set(); set.add(sid); p.nameIndex.set(name, set); }
function indexRemove(p: ProjectState, name: string, sid: string) { const set = p.nameIndex.get(name); if (!set) return; set.delete(sid); if (!set.size) p.nameIndex.delete(name); }
function uniqueName(p: ProjectState, desired: string) { const names = new Set([...p.agents.values()].map((a) => a.name)); if (!names.has(desired)) return desired; let i = 2; while (names.has(`${desired}${i}`)) i++; return `${desired}${i}`; }
function send(p: ProjectState, sid: string, event: string, data: unknown) { const w = p.streams.get(sid); if (!w) return false; try { w.enqueue(sseFrame(event, data, ++w.lastId)); return true; } catch { return false; } }
function broadcast(p: ProjectState, event: string, data: unknown, except?: string) { for (const [sid] of p.streams) if (sid !== except) send(p, sid, event, data); }
function releaseAwaiters(p: ProjectState, msgId: string) { const set = p.awaiters.get(msgId); if (!set) return; const msg = p.messages.get(msgId); for (const a of set) { clearTimeout(a.timer); if (msg) a.resolve(msg); } p.awaiters.delete(msgId); }
function inboxDepth(p: ProjectState, target: string) { let n = 0; for (const m of p.messages.values()) if (m.target_session === target && (m.status === "queued" || m.status === "delivered")) n++; return n; }
function log(kind: string, detail: string) { if (process.env.PI_COMS_NET_LOG_QUIET === "1") return; console.log(`${new Date().toISOString().slice(11, 19)} ${kind.padEnd(10)} ${detail}`); }

async function handleHealth() { return json({ ok: true, version: 1, server_id: state.server_id, started_at: state.started_at }); }
async function handleRegister(req: Request) {
	let body: any; try { body = await req.json(); } catch { return errorJson("invalid_json", 400); }
	if (!body?.session_id || !body?.project || !body?.name) return errorJson("invalid_request", 400);
	const project = safeProject(body.project); const p = pstate(project); const existing = p.agents.get(body.session_id);
	const resolvedName = existing ? (body.name !== existing.name ? uniqueName(p, body.name) : existing.name) : uniqueName(p, body.name || "agent");
	if (existing && existing.name !== resolvedName) indexRemove(p, existing.name, body.session_id);
	const entry: RegistryEntry = {
		session_id: body.session_id, name: resolvedName, purpose: body.purpose ?? "", model: body.model ?? "unknown", provider: body.provider,
		color: body.color ?? "#888888", cwd: body.cwd ?? "", project, explicit: body.explicit === true, started_at: existing?.started_at ?? nowIso(),
		context_used_pct: existing?.context_used_pct ?? 0, queue_depth: existing?.queue_depth ?? 0, status: "online", registered_at: existing?.registered_at ?? nowIso(), last_seen_at: nowIso(),
	};
	p.agents.set(entry.session_id, entry); indexAdd(p, entry.name, entry.session_id);
	broadcast(p, "agent_joined", { project, agent: card(entry) }, entry.session_id);
	log(existing ? "reregister" : "register", `${entry.name}@${project}`);
	return json({ ok: true, agent: card(entry), heartbeat_interval_ms: HEARTBEAT_MS, sse_url: `/v1/events?project=${encodeURIComponent(project)}&session_id=${encodeURIComponent(entry.session_id)}` });
}
function deliverQueued(p: ProjectState, project: string, target: RegistryEntry) {
	for (const msg of p.messages.values()) {
		if (msg.target_session !== target.session_id || msg.status !== "queued") continue;
		const sender = p.agents.get(msg.sender_session);
		send(p, target.session_id, "prompt", { msg_id: msg.msg_id, project, sender: { session_id: sender?.session_id ?? msg.sender_session, name: sender?.name ?? "unknown", cwd: sender?.cwd ?? "" }, prompt: msg.prompt, conversation_id: msg.conversation_id, response_schema: msg.response_schema, hops: msg.hops });
		msg.status = "delivered"; msg.delivered_at = nowIso(); send(p, msg.sender_session, "message_status", { msg_id: msg.msg_id, status: "delivered" });
	}
}
function handleEvents(req: Request, url: URL) {
	const project = safeProject(url.searchParams.get("project") ?? "default"); const sid = url.searchParams.get("session_id") ?? ""; if (!sid) return errorJson("missing_session_id", 400);
	const p = pstate(project); const entry = p.agents.get(sid); if (!entry) return errorJson("agent_not_found", 404);
	const enc = new TextEncoder(); let writer: SseWriter | null = null;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			writer = { session_id: sid, lastId: 0, enqueue(frame) { if (!closed) controller.enqueue(enc.encode(frame)); }, close() { if (!closed) { closed = true; try { controller.close(); } catch {} } } };
			const old = p.streams.get(sid); if (old) old.close(); p.streams.set(sid, writer);
			writer.enqueue(sseFrame("hello", { server_time: nowIso(), server_id: state.server_id }, ++writer.lastId));
			writer.enqueue(sseFrame("pool_snapshot", { project, agents: [...p.agents.values()].filter((a) => a.session_id !== sid && !a.explicit).map(card) }, ++writer.lastId));
			deliverQueued(p, project, entry);
			log("sse-open", entry.name);
			const onAbort = () => { if (closed) return; closed = true; if (p.streams.get(sid) === writer) p.streams.delete(sid); log("sse-close", entry.name); };
			req.signal.addEventListener("abort", onAbort);
		},
		cancel() { if (p.streams.get(sid) === writer) p.streams.delete(sid); },
	});
	return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
async function handleHeartbeat(req: Request, sid: string) {
	let body: any; try { body = await req.json(); } catch { return errorJson("invalid_json", 400); }
	const project = safeProject(body?.project ?? "default"); const p = state.projects.get(project); const entry = p?.agents.get(sid); if (!p || !entry) return errorJson("agent_not_found", 404);
	const before = `${entry.context_used_pct}|${entry.queue_depth}|${entry.model}|${entry.status}`;
	if (typeof body.context_used_pct === "number") entry.context_used_pct = body.context_used_pct;
	if (typeof body.queue_depth === "number") entry.queue_depth = body.queue_depth;
	if (typeof body.model === "string") entry.model = body.model;
	entry.status = body.status === "stale" || body.status === "offline" ? body.status : "online"; entry.last_seen_at = nowIso();
	const after = `${entry.context_used_pct}|${entry.queue_depth}|${entry.model}|${entry.status}`;
	if (before !== after) broadcast(p, "agent_updated", { project, agent: { session_id: sid, name: entry.name, context_used_pct: entry.context_used_pct, queue_depth: entry.queue_depth, model: entry.model, status: entry.status } }, sid);
	return json({ ok: true });
}
function handleList(url: URL) { const project = safeProject(url.searchParams.get("project") ?? "default"); const inc = (url.searchParams.get("include_explicit") ?? "false") === "true"; const p = state.projects.get(project); return json({ agents: p ? [...p.agents.values()].filter((a) => inc || !a.explicit).map(card) : [] }); }
async function handleSend(req: Request) {
	let body: any; try { body = await req.json(); } catch { return errorJson("invalid_json", 400); }
	if (!body?.sender_session || typeof body.prompt !== "string") return errorJson("invalid_request", 400);
	const project = safeProject(body.project ?? "default"); const p = state.projects.get(project); if (!p) return errorJson("agent_not_found", 404);
	const sender = p.agents.get(body.sender_session); if (!sender) return errorJson("sender_not_registered", 404);
	const hops = typeof body.hops === "number" ? body.hops : 0; if (hops >= MAX_HOPS) return errorJson("hop_limit_exceeded", 409, { hops, max_hops: MAX_HOPS });
	let target: RegistryEntry | undefined;
	if (body.target_session) target = p.agents.get(body.target_session);
	else if (p.agents.has(body.target)) target = p.agents.get(body.target);
	else { const bag = p.nameIndex.get((body.target ?? "").trim()); if (!bag?.size) return errorJson("target_not_found", 404, { target: body.target }); if (bag.size > 1) return errorJson("ambiguous_target", 409, { target: body.target, candidates: [...bag] }); target = p.agents.get([...bag][0]); }
	if (!target) return errorJson("target_not_found", 404);
	if (inboxDepth(p, target.session_id) >= MAX_INBOX) return errorJson("inbox_full", 429, { max_inbox: MAX_INBOX });
	const msg: ComsMessage = { msg_id: ulid(), project, sender_session: sender.session_id, target_session: target.session_id, prompt: body.prompt, conversation_id: typeof body.conversation_id === "string" ? body.conversation_id : null, response_schema: body.response_schema && typeof body.response_schema === "object" ? body.response_schema : null, hops, status: "queued", response: null, error: null, created_at: nowIso(), expires_at: new Date(Date.now() + MESSAGE_TTL_MS).toISOString() };
	p.messages.set(msg.msg_id, msg); send(p, sender.session_id, "message_status", { msg_id: msg.msg_id, status: "queued" });
	if (p.streams.has(target.session_id)) deliverQueued(p, project, target);
	log("message", `${sender.name} -> ${target.name} ${msg.status}`);
	return json({ ok: true, msg_id: msg.msg_id, status: msg.status, target_session: target.session_id });
}
function findMessage(msgId: string) { for (const p of state.projects.values()) { const m = p.messages.get(msgId); if (m) return { p, m }; } return null; }
function handleGet(msgId: string) { const found = findMessage(msgId); if (!found) return errorJson("message_not_found", 404); const { m } = found; return json({ msg_id: m.msg_id, status: m.status, response: m.response, error: m.error }); }
function handleAwait(req: Request, url: URL, msgId: string) {
	const found = findMessage(msgId); if (!found) return errorJson("message_not_found", 404); const { p, m } = found;
	if (["complete", "error", "timeout"].includes(m.status)) return json({ msg_id: m.msg_id, status: m.status, response: m.response, error: m.error });
	const timeoutMs = Math.min(Number(url.searchParams.get("timeout_ms") || 30_000), MESSAGE_TTL_MS);
	return new Response(new ReadableStream({ start(controller) { const enc = new TextEncoder(); const finalize = (msg: ComsMessage) => { try { controller.enqueue(enc.encode(JSON.stringify({ msg_id: msg.msg_id, status: msg.status, response: msg.response, error: msg.error }))); controller.close(); } catch {} };
		const set = p.awaiters.get(msgId) ?? new Set(); p.awaiters.set(msgId, set); const awaiter: Awaiter = { resolve: finalize, timer: setTimeout(() => { set.delete(awaiter); if (!set.size) p.awaiters.delete(msgId); finalize({ ...m, status: "timeout", response: null, error: "timeout" }); }, timeoutMs) }; set.add(awaiter); req.signal.addEventListener("abort", () => { clearTimeout(awaiter.timer); set.delete(awaiter); if (!set.size) p.awaiters.delete(msgId); }); } }), { headers: { "content-type": "application/json" } });
}
async function handleResponse(req: Request, msgId: string) {
	let body: any; try { body = await req.json(); } catch { return errorJson("invalid_json", 400); }
	const found = findMessage(msgId); if (!found) return errorJson("message_not_found", 404); const { p, m } = found;
	if (body.responder_session !== m.target_session) return errorJson("not_target", 403);
	if (["complete", "error", "timeout"].includes(m.status)) return errorJson("already_terminal", 409, { status: m.status });
	m.status = body.error ? "error" : "complete"; m.response = body.response ?? null; m.error = body.error ? String(body.error) : null; m.completed_at = nowIso();
	const responder = p.agents.get(body.responder_session); send(p, m.sender_session, "response", { msg_id: m.msg_id, project: m.project, responder: { session_id: body.responder_session, name: responder?.name ?? "unknown" }, response: m.response, error: m.error, status: m.status });
	send(p, m.sender_session, "message_status", { msg_id: m.msg_id, status: m.status }); releaseAwaiters(p, msgId); log("response", `${responder?.name ?? "unknown"} -> ${m.sender_session}`); return json({ ok: true });
}
function handleDelete(url: URL, sid: string) { const project = safeProject(url.searchParams.get("project") ?? "default"); const p = state.projects.get(project); const entry = p?.agents.get(sid); if (!p || !entry) return errorJson("agent_not_found", 404); p.streams.get(sid)?.close(); p.streams.delete(sid); p.agents.delete(sid); indexRemove(p, entry.name, sid); broadcast(p, "agent_left", { project, session_id: sid, name: entry.name, reason: "shutdown" }, sid); return json({ ok: true }); }

async function router(req: Request) {
	const url = new URL(req.url); const pathname = url.pathname; const method = req.method.toUpperCase();
	if (pathname === "/health" && method === "GET") return handleHealth();
	if (!pathname.startsWith("/v1/")) return errorJson("not_found", 404);
	if (!authed(req)) return unauthorized();
	if (pathname === "/v1/agents/register" && method === "POST") return handleRegister(req);
	if (pathname === "/v1/events" && method === "GET") return handleEvents(req, url);
	if (pathname === "/v1/agents" && method === "GET") return handleList(url);
	if (pathname === "/v1/messages" && method === "POST") return handleSend(req);
	let m = pathname.match(/^\/v1\/agents\/([^/]+)(?:\/(heartbeat))?$/); if (m) { const sid = decodeURIComponent(m[1]); if (m[2] === "heartbeat" && method === "POST") return handleHeartbeat(req, sid); if (!m[2] && method === "DELETE") return handleDelete(url, sid); }
	m = pathname.match(/^\/v1\/messages\/([^/]+)(?:\/(await|response))?$/); if (m) { const id = decodeURIComponent(m[1]); if (!m[2] && method === "GET") return handleGet(id); if (m[2] === "await" && method === "GET") return handleAwait(req, url, id); if (m[2] === "response" && method === "POST") return handleResponse(req, id); }
	return errorJson("not_found", 404);
}

function scan() { const now = Date.now(); for (const [project, p] of state.projects) { for (const [sid, a] of [...p.agents]) { const dt = now - Date.parse(a.last_seen_at); if (dt > OFFLINE_AFTER_MS) { p.agents.delete(sid); indexRemove(p, a.name, sid); p.streams.get(sid)?.close(); p.streams.delete(sid); broadcast(p, "agent_left", { project, session_id: sid, name: a.name, reason: "stale" }, sid); } else if (dt > STALE_AFTER_MS && a.status !== "stale") { a.status = "stale"; broadcast(p, "agent_stale", { project, session_id: sid, name: a.name, last_seen_at: a.last_seen_at }, sid); } }
	for (const [id, msg] of [...p.messages]) { const expired = Date.now() > Date.parse(msg.expires_at); if ((msg.status === "queued" || msg.status === "delivered") && expired) { msg.status = "timeout"; msg.error = "expired"; msg.completed_at = nowIso(); releaseAwaiters(p, id); send(p, msg.sender_session, "message_status", { msg_id: id, status: "timeout" }); } else if ((msg.status === "complete" || msg.status === "error" || msg.status === "timeout") && msg.completed_at && Date.now() - Date.parse(msg.completed_at) > MESSAGE_TTL_MS) p.messages.delete(id); } } }
function keepalive() { const frame = `: ping ${nowIso()}\n\n`; for (const p of state.projects.values()) for (const w of p.streams.values()) try { w.enqueue(frame); } catch {} }

export function main() {
	if (!TOKEN) { if (!isLoopback(HOST)) { console.error(`coms-net: refusing to bind ${HOST} without PI_COMS_NET_AUTH_TOKEN`); process.exit(1); } TOKEN = crypto.randomBytes(32).toString("hex"); TOKEN_FILE_OWNED_BY_US = true; }
	const dir = projectDir(PROJECT); mkdirp(dir);
	const server = (globalThis as any).Bun.serve({ hostname: HOST, port: PORT, fetch: router, idleTimeout: 0 });
	const localHost = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST; const localUrl = `http://${localHost}:${server.port}`; const publicUrl = PUBLIC_URL ?? localUrl;
	const serverJsonPath = path.join(dir, "server.json"); const secretPath = path.join(dir, "server.secret.json");
	atomicWrite(serverJsonPath, JSON.stringify({ version: 1, project: PROJECT, pid: process.pid, host: HOST, port: server.port, local_url: localUrl, public_url: publicUrl, started_at: state.started_at, server_id: state.server_id }, null, 2));
	if (TOKEN_FILE_OWNED_BY_US) atomicWrite(secretPath, JSON.stringify({ token: TOKEN }, null, 2), 0o600);
	console.log(`coms-net: listening on ${localUrl}`); console.log(`          project=${PROJECT}`); console.log(`          server.json=${serverJsonPath}`); console.log(TOKEN_FILE_OWNED_BY_US ? `          server.secret.json=${secretPath} (chmod 0600)` : "          using token from PI_COMS_NET_AUTH_TOKEN");
	timers.push(setInterval(scan, SCAN_MS), setInterval(keepalive, KEEPALIVE_MS)); for (const t of timers) t.unref?.();
	let unlinked = false; const unlink = () => { if (unlinked) return; unlinked = true; try { fs.unlinkSync(serverJsonPath); } catch {}; if (TOKEN_FILE_OWNED_BY_US) try { fs.unlinkSync(secretPath); } catch {}; };
	const shutdown = (sig: string) => { if (shuttingDown) return; shuttingDown = true; unlink(); console.log(`coms-net: ${sig} shutting down`); for (const p of state.projects.values()) for (const w of p.streams.values()) w.close(); for (const t of timers) clearInterval(t); server.stop?.(true); setTimeout(() => process.exit(0), 50).unref?.(); };
	process.on("SIGINT", () => shutdown("SIGINT")); process.on("SIGTERM", () => shutdown("SIGTERM")); process.on("exit", unlink);
}

if (import.meta.main) main();
