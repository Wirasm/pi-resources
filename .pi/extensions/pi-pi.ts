// @ts-nocheck
/**
 * Pi Pi — Meta-agent that builds Pi resources
 *
 * A team of read-only Pi domain experts research documentation in parallel via
 * `query_experts`. The primary agent keeps normal writer tools and synthesizes
 * expert findings into actual files.
 *
 * Expert definitions are loaded from:
 *   pi-pi/agents/*.md
 *   .pi/agents/pi-pi/*.md
 *
 * Usage:
 *   pi -e .pi/extensions/pi-pi.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, type AutocompleteItem, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyExtensionDefaults } from "./lib/themeMap.ts";

interface ExpertDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
	file: string;
}

interface ExpertState {
	def: ExpertDef;
	status: "idle" | "researching" | "done" | "error";
	question: string;
	elapsed: number;
	lastLine: string;
	queryCount: number;
	sessionFile: string | null;
	process?: ChildProcessWithoutNullStreams;
	timer?: ReturnType<typeof setInterval>;
}

type QueryResult = { output: string; exitCode: number; elapsed: number };

const DOCS_ROOT = "/Users/rasmus/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs";

const EXPERT_COLORS: Record<string, { bg: string; br: string }> = {
	"agent-expert": { bg: "\x1b[48;2;20;30;75m", br: "\x1b[38;2;70;110;210m" },
	"cli-expert": { bg: "\x1b[48;2;60;80;20m", br: "\x1b[38;2;160;210;55m" },
	"config-expert": { bg: "\x1b[48;2;18;65;30m", br: "\x1b[38;2;55;175;90m" },
	"ext-expert": { bg: "\x1b[48;2;80;18;28m", br: "\x1b[38;2;210;65;85m" },
	"keybinding-expert": { bg: "\x1b[48;2;50;22;85m", br: "\x1b[38;2;145;80;220m" },
	"prompt-expert": { bg: "\x1b[48;2;80;55;12m", br: "\x1b[38;2;215;150;40m" },
	"skill-expert": { bg: "\x1b[48;2;12;65;75m", br: "\x1b[38;2;40;175;195m" },
	"theme-expert": { bg: "\x1b[48;2;80;18;62m", br: "\x1b[38;2;210;55;160m" },
	"tui-expert": { bg: "\x1b[48;2;28;42;80m", br: "\x1b[38;2;85;120;210m" },
};
const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";

function displayName(name: string): string {
	return name.split(/[-_\s]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function slug(name: string): string {
	return name.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "expert";
}

function parseScalar(v: string): string {
	let out = v.trim();
	if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) out = out.slice(1, -1);
	return out;
}

function parseExpertFile(filePath: string): ExpertDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
		if (!match) return null;
		const fm: Record<string, string> = {};
		for (const line of match[1].split(/\r?\n/)) {
			const idx = line.indexOf(":");
			if (idx > 0) fm[line.slice(0, idx).trim()] = parseScalar(line.slice(idx + 1));
		}
		if (!fm.name) return null;
		return {
			name: fm.name,
			description: fm.description || "",
			tools: fm.tools || "read,grep,find,ls,bash",
			systemPrompt: match[2].trim(),
			file: filePath,
		};
	} catch {
		return null;
	}
}

function assistantText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

function readOptional(file: string): string | null {
	try { return readFileSync(file, "utf-8"); } catch { return null; }
}

export default function (pi: ExtensionAPI) {
	const experts = new Map<string, ExpertState>();
	let gridCols = 3;
	let currentCtx: ExtensionContext | null = null;
	let sessionDir = "";

	function loadExperts(cwd: string): void {
		sessionDir = join(cwd, ".pi", "pi-pi-sessions");
		mkdirSync(sessionDir, { recursive: true });

		const dirs = [join(cwd, "pi-pi", "agents"), join(cwd, ".pi", "agents", "pi-pi")];
		experts.clear();
		for (const dir of dirs) {
			if (!existsSync(dir)) continue;
			try {
				for (const file of readdirSync(dir)) {
					if (!file.endsWith(".md") || file === "pi-orchestrator.md") continue;
					const def = parseExpertFile(resolve(dir, file));
					if (!def) continue;
					const key = def.name.toLowerCase();
					if (experts.has(key)) continue;
					const sessionFile = join(sessionDir, `${slug(def.name)}.jsonl`);
					experts.set(key, {
						def,
						status: "idle",
						question: "",
						elapsed: 0,
						lastLine: "",
						queryCount: 0,
						sessionFile: existsSync(sessionFile) ? sessionFile : null,
					});
				}
			} catch {}
		}
	}

	function renderCard(state: ExpertState, colWidth: number, theme: any): string[] {
		const w = Math.max(14, colWidth - 2);
		const trunc = (s: string, max: number) => truncateToWidth(s || "", Math.max(0, max));
		const statusColor = state.status === "idle" ? "dim" : state.status === "researching" ? "accent" : state.status === "done" ? "success" : "error";
		const statusIcon = state.status === "idle" ? "○" : state.status === "researching" ? "◉" : state.status === "done" ? "✓" : "✗";
		const nameRaw = trunc(displayName(state.def.name), w - 1);
		const statusRaw = `${statusIcon} ${state.status}${state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}s` : ""}${state.queryCount ? ` (${state.queryCount})` : ""}`;
		const statusShown = trunc(statusRaw, w - 1);
		const workShown = trunc(state.question || state.def.description || "no description", w - 1);
		const lastShown = trunc(state.lastLine || "—", w - 1);
		const colors = EXPERT_COLORS[state.def.name] || { bg: "", br: "" };
		const bg = colors.bg;
		const br = colors.br;
		const bord = (s: string) => bg + br + s + BG_RESET + FG_RESET;
		const top = "┌" + "─".repeat(w) + "┐";
		const bot = "└" + "─".repeat(w) + "┘";
		const border = (content: string, visible: number) => bord("│") + bg + content + bg + " ".repeat(Math.max(0, w - visible)) + BG_RESET + bord("│");
		return [
			bord(top),
			border(" " + theme.fg("accent", theme.bold(nameRaw)), 1 + visibleWidth(nameRaw)),
			border(" " + theme.fg(statusColor, statusShown), 1 + visibleWidth(statusShown)),
			border(" " + theme.fg("muted", workShown), 1 + visibleWidth(workShown)),
			border(" " + theme.fg("dim", lastShown), 1 + visibleWidth(lastShown)),
			bord(bot),
		];
	}

	function refreshWidget(): void {
		const ctx = currentCtx;
		if (!ctx?.hasUI) return;
		ctx.ui.setWidget("pi-pi-grid", (_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				if (experts.size === 0) return ["", theme.fg("dim", "  No experts found. Add .md files to pi-pi/agents/.")];
				const cols = Math.max(1, Math.min(gridCols, experts.size));
				const gap = 1;
				const colWidth = Math.max(16, Math.floor((width - gap * (cols - 1)) / cols));
				const all = [...experts.values()];
				const lines: string[] = [""];
				for (let i = 0; i < all.length; i += cols) {
					const cards = all.slice(i, i + cols).map((e) => renderCard(e, colWidth, theme));
					while (cards.length < cols) cards.push(Array(6).fill(" ".repeat(colWidth)));
					for (let line = 0; line < cards[0].length; line++) lines.push(cards.map((card) => card[line] || "").join(" ".repeat(gap)));
				}
				return lines.map((line) => truncateToWidth(line, width));
			},
		}), { placement: "belowEditor" });
	}

	function queryExpert(expertName: string, question: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<QueryResult> {
		const state = experts.get(expertName.toLowerCase());
		if (!state) return Promise.resolve({ output: `Expert "${expertName}" not found. Available: ${[...experts.values()].map((s) => s.def.name).join(", ")}`, exitCode: 1, elapsed: 0 });
		if (state.status === "researching") return Promise.resolve({ output: `Expert "${displayName(state.def.name)}" is already researching.`, exitCode: 1, elapsed: 0 });

		state.status = "researching";
		state.question = question;
		state.elapsed = 0;
		state.lastLine = "";
		state.queryCount++;
		refreshWidget();

		const startTime = Date.now();
		state.timer = setInterval(() => { state.elapsed = Date.now() - startTime; refreshWidget(); }, 1000);
		try { (state.timer as any).unref?.(); } catch {}

		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const sessionFile = join(sessionDir, `${slug(state.def.name)}.jsonl`);
		const prompt = `${question}\n\nLocal Pi docs root: ${DOCS_ROOT}\nFirst read the relevant local docs from that directory before answering. If docs are missing, use pi --help or the local package docs as fallback.`;
		const args = [
			"--mode", "json",
			"-p",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--tools", state.def.tools,
			"--thinking", "off",
			"--append-system-prompt", state.def.systemPrompt,
			"--session", sessionFile,
		];
		if (model) args.push("--model", model);
		if (state.sessionFile || existsSync(sessionFile)) args.push("-c");
		args.push(prompt);

		const textChunks: string[] = [];
		let finalAssistantText = "";
		let stderr = "";
		let buffer = "";

		return new Promise((resolvePromise) => {
			const finish = (exitCode: number, output: string) => {
				if (state.timer) clearInterval(state.timer);
				state.timer = undefined;
				state.process = undefined;
				state.elapsed = Date.now() - startTime;
				state.status = exitCode === 0 ? "done" : "error";
				if (exitCode === 0) state.sessionFile = sessionFile;
				state.lastLine = output.split("\n").filter((l) => l.trim()).pop() || state.status;
				refreshWidget();
				if (ctx.hasUI) ctx.ui.notify(`${displayName(state.def.name)} ${state.status} in ${Math.round(state.elapsed / 1000)}s`, state.status === "done" ? "info" : "error");
				resolvePromise({ output, exitCode, elapsed: state.elapsed });
			};
			const handleEvent = (event: any) => {
				if (event.type === "message_update") {
					const delta = event.assistantMessageEvent;
					const text = delta?.type === "text_delta" ? delta.delta : delta?.text ?? "";
					if (text) {
						textChunks.push(text);
						state.lastLine = textChunks.join("").split("\n").filter((l) => l.trim()).pop() || "researching...";
						refreshWidget();
					}
				} else if (event.type === "message_end" && event.message?.role === "assistant") {
					finalAssistantText = assistantText(event.message) || finalAssistantText;
				} else if (event.type === "agent_end") {
					const last = [...(event.messages || [])].reverse().find((m: any) => m.role === "assistant");
					if (last) finalAssistantText = assistantText(last) || finalAssistantText;
				}
			};

			let proc: ChildProcessWithoutNullStreams;
			try { proc = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"], cwd: ctx.cwd, env: { ...process.env } }); }
			catch (err: any) { finish(1, `Error spawning expert: ${err?.message ?? String(err)}`); return; }
			state.process = proc;
			const abort = () => { try { proc.kill("SIGTERM"); } catch {}; setTimeout(() => { try { if (!proc.killed) proc.kill("SIGKILL"); } catch {} }, 1500).unref?.(); };
			if (signal?.aborted) abort();
			signal?.addEventListener("abort", abort, { once: true });
			proc.stdout.setEncoding("utf-8");
			proc.stdout.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) if (line.trim()) { try { handleEvent(JSON.parse(line)); } catch {} }
			});
			proc.stderr.setEncoding("utf-8");
			proc.stderr.on("data", (chunk: string) => { stderr += chunk; });
			proc.on("error", (err) => finish(1, `Error spawning expert: ${err.message}`));
			proc.on("close", (code) => {
				signal?.removeEventListener("abort", abort);
				if (buffer.trim()) { try { handleEvent(JSON.parse(buffer)); } catch {} }
				const output = finalAssistantText || textChunks.join("") || (stderr.trim() ? `No assistant output. stderr:\n${stderr.trim()}` : "");
				finish(code ?? 1, output);
			});
		});
	}

	pi.registerTool({
		name: "query_experts",
		label: "Query Experts",
		description: "Query one or more Pi domain experts in parallel. Experts are read-only researchers; the primary agent writes files after synthesizing their findings.",
		parameters: Type.Object({
			queries: Type.Array(Type.Object({
				expert: Type.String({ description: "Expert name, e.g. ext-expert, tui-expert, skill-expert." }),
				question: Type.String({ description: "Specific research question with context about what you need to build." }),
			}), { description: "Expert queries to run concurrently." }),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const queries = (params as any).queries as Array<{ expert: string; question: string }>;
			if (!queries?.length) return { content: [{ type: "text" as const, text: "No queries provided." }], details: { results: [], status: "error" } };
			onUpdate?.({ content: [{ type: "text", text: `Querying ${queries.length} experts in parallel...` }], details: { queries, status: "researching", results: [] } });
			const settled = await Promise.allSettled(queries.map(async (q) => {
				const result = await queryExpert(q.expert, q.question, ctx, signal);
				const status = result.exitCode === 0 ? "done" : "error";
				return { ...q, status, elapsed: result.elapsed, exitCode: result.exitCode, output: result.output.length > 12000 ? result.output.slice(0, 12000) + "\n\n... [truncated]" : result.output, fullOutput: result.output };
			}));
			const results = settled.map((s, i) => s.status === "fulfilled" ? s.value : { ...queries[i], status: "error", elapsed: 0, exitCode: 1, output: `Error: ${(s.reason as any)?.message || s.reason}`, fullOutput: "" });
			const sections = results.map((r) => `## [${r.status === "done" ? "✓" : "✗"}] ${displayName(r.expert)} (${Math.round(r.elapsed / 1000)}s)\n\n${r.output}`);
			return { content: [{ type: "text" as const, text: sections.join("\n\n---\n\n") }], details: { results, status: results.every((r) => r.status === "done") ? "done" : "partial" } };
		},
		renderCall(args, theme) {
			const queries = (args as any).queries || [];
			const names = queries.map((q: any) => displayName(q.expert || "?")).join(", ");
			return new Text(theme.fg("toolTitle", theme.bold("query_experts ")) + theme.fg("accent", `${queries.length} parallel`) + theme.fg("dim", " — ") + theme.fg("muted", names), 0, 0);
		},
		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details?.results) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (options.isPartial || details.status === "researching") return new Text(theme.fg("accent", `◉ ${details.queries?.length || "?"} experts`) + theme.fg("dim", " researching..."), 0, 0);
			const lines = (details.results as any[]).map((r) => theme.fg(r.status === "done" ? "success" : "error", `${r.status === "done" ? "✓" : "✗"} ${displayName(r.expert)}`) + theme.fg("dim", ` ${Math.round((r.elapsed || 0) / 1000)}s`));
			const header = lines.join(theme.fg("dim", " · "));
			if (options.expanded) {
				const expanded = (details.results as any[]).map((r) => theme.fg("accent", `── ${displayName(r.expert)} ──`) + "\n" + theme.fg("muted", (r.fullOutput || r.output || "").slice(0, 4000)));
				return new Text(header + "\n\n" + expanded.join("\n\n"), 0, 0);
			}
			return new Text(header, 0, 0);
		},
	});

	pi.registerCommand("experts", {
		description: "List available Pi Pi experts and status",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			const lines = [...experts.values()].map((s) => `${s.def.name} (${s.status}, queries: ${s.queryCount}): ${s.def.description}`).join("\n");
			ctx.ui.notify(lines || "No experts loaded", "info");
		},
	});

	pi.registerCommand("experts-grid", {
		description: "Set expert grid columns: /experts-grid <1-5>",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = ["1", "2", "3", "4", "5"].map((n) => ({ value: n, label: `${n} columns` }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length ? filtered : items;
		},
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const n = Number.parseInt(args.trim(), 10);
			if (n >= 1 && n <= 5) { gridCols = n; refreshWidget(); ctx.ui.notify(`Grid set to ${gridCols} columns`, "info"); }
			else ctx.ui.notify("Usage: /experts-grid <1-5>", "error");
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const expertCatalog = [...experts.values()].map((s) => `### ${displayName(s.def.name)}\nQuery as: \`${s.def.name}\`\n${s.def.description}`).join("\n\n");
		const expertNames = [...experts.values()].map((s) => displayName(s.def.name)).join(", ") || "none";
		const paths = [join(ctx.cwd, "pi-pi", "agents", "pi-orchestrator.md"), join(ctx.cwd, ".pi", "agents", "pi-pi", "pi-orchestrator.md")];
		let template = paths.map(readOptional).find(Boolean) || "";
		const match = template.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
		if (match) template = match[2].trim();
		if (!template) template = "You are Pi Pi. Query experts first with query_experts, then build Pi resources with your writer tools.";
		const systemPrompt = template.replaceAll("{{EXPERT_COUNT}}", String(experts.size)).replaceAll("{{EXPERT_NAMES}}", expertNames).replaceAll("{{EXPERT_CATALOG}}", expertCatalog || "No experts loaded.");
		return { systemPrompt: `${event.systemPrompt}\n\n${systemPrompt}` };
	});

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		currentCtx = ctx;
		loadExperts(ctx.cwd);
		pi.setActiveTools(["query_experts", "read", "write", "edit", "bash", "grep", "find", "ls"]);
		if (ctx.hasUI) {
			refreshWidget();
			const expertNames = [...experts.values()].map((s) => displayName(s.def.name)).join(", ");
			ctx.ui.setStatus("pi-pi", `Pi Pi (${experts.size} experts)`);
			ctx.ui.notify(`Pi Pi loaded — ${experts.size} experts${expertNames ? `: ${expertNames}` : ""}\n/experts list · /experts-grid <1-5>`, "info");
			ctx.ui.setFooter((_tui, theme) => ({
				dispose() {},
				invalidate() {},
				render(width: number): string[] {
					const model = ctx.model?.id || "no-model";
					const pct = ctx.getContextUsage()?.percent ?? 0;
					const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
					const bar = "#".repeat(filled) + "-".repeat(10 - filled);
					const active = [...experts.values()].filter((e) => e.status === "researching").length;
					const done = [...experts.values()].filter((e) => e.status === "done").length;
					const left = theme.fg("dim", ` ${model}`) + theme.fg("muted", " · ") + theme.fg("accent", "Pi Pi");
					const mid = active ? theme.fg("accent", ` ◉ ${active} researching`) : done ? theme.fg("success", ` ✓ ${done} done`) : "";
					const right = theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
					const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(mid) - visibleWidth(right)));
					return [truncateToWidth(left + mid + pad + right, width)];
				},
			}));
		}
	});

	pi.on("session_shutdown", async () => {
		for (const s of experts.values()) {
			if (s.timer) clearInterval(s.timer);
			if (s.process && !s.process.killed) { try { s.process.kill("SIGTERM"); } catch {} }
		}
		if (currentCtx?.hasUI) {
			try { currentCtx.ui.setWidget("pi-pi-grid", undefined); } catch {}
			try { currentCtx.ui.setStatus("pi-pi", undefined); } catch {}
			try { currentCtx.ui.setFooter(undefined); } catch {}
		}
	});
}
