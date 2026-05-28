// @ts-nocheck
/**
 * Subagent Widget — background child-process Pi agents with live widgets
 *
 * Commands:
 *   /sub <task>                 spawn a background subagent
 *   /subcont <id> <prompt>      continue a finished subagent session
 *   /subrm <id>                 remove/kill one subagent
 *   /subclear                   remove/kill all subagents
 *
 * Tools:
 *   subagent_create / subagent_continue / subagent_remove / subagent_list
 *
 * Sessions are project-local under .pi/subagent-sessions/.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { applyExtensionDefaults } from "./lib/themeMap.ts";

interface SubState {
	id: number;
	status: "running" | "done" | "error" | "killed";
	task: string;
	textChunks: string[];
	finalText: string;
	toolCount: number;
	elapsed: number;
	sessionFile: string;
	turnCount: number;
	proc?: ChildProcessWithoutNullStreams;
	timer?: ReturnType<typeof setInterval>;
	stderr: string;
}

function assistantText(message: any): string {
	const c = message?.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

function lastNonEmptyLine(text: string): string {
	return text.split("\n").filter((l) => l.trim()).pop() || "";
}

export default function (pi: ExtensionAPI) {
	const agents = new Map<number, SubState>();
	let nextId = 1;
	let currentCtx: ExtensionContext | null = null;

	function sessionsDir(ctx: ExtensionContext): string {
		const dir = path.join(ctx.cwd, ".pi", "subagent-sessions");
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	function makeSessionFile(ctx: ExtensionContext, id: number): string {
		return path.join(sessionsDir(ctx), `subagent-${id}.jsonl`);
	}

	function widgetLine(state: SubState, width: number, theme: any): string[] {
		const statusColor = state.status === "running" ? "accent" : state.status === "done" ? "success" : state.status === "killed" ? "warning" : "error";
		const statusIcon = state.status === "running" ? "●" : state.status === "done" ? "✓" : state.status === "killed" ? "◌" : "✗";
		const elapsed = Math.round(state.elapsed / 1000);
		const task = truncateToWidth(state.task, Math.max(10, width - 42));
		const turn = state.turnCount > 1 ? theme.fg("dim", ` · turn ${state.turnCount}`) : "";
		const header = theme.fg(statusColor, `${statusIcon} Subagent #${state.id}`) + turn + theme.fg("dim", `  ${task}  ${elapsed}s | tools ${state.toolCount}`);
		const text = state.finalText || state.textChunks.join("") || state.stderr;
		const last = lastNonEmptyLine(text);
		const body = last ? theme.fg("muted", "  " + truncateToWidth(last, Math.max(0, width - 2))) : theme.fg("dim", "  …");
		const border = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
		return [border, truncateToWidth(header, width), truncateToWidth(body, width), border];
	}

	function updateWidgets(): void {
		const ctx = currentCtx;
		if (!ctx?.hasUI) return;
		for (const [id, state] of agents) {
			ctx.ui.setWidget(`sub-${id}`, (_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] { return widgetLine(state, width, theme); },
			}), { placement: "belowEditor" });
		}
	}

	function processEvent(state: SubState, event: any): void {
		if (event.type === "message_update") {
			const delta = event.assistantMessageEvent;
			const text = delta?.type === "text_delta" ? delta.delta : delta?.text ?? "";
			if (text) state.textChunks.push(text);
			updateWidgets();
		} else if (event.type === "tool_execution_start") {
			state.toolCount++;
			updateWidgets();
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			state.finalText = assistantText(event.message) || state.finalText;
			updateWidgets();
		} else if (event.type === "agent_end") {
			const last = [...(event.messages || [])].reverse().find((m: any) => m.role === "assistant");
			if (last) state.finalText = assistantText(last) || state.finalText;
			updateWidgets();
		}
	}

	function spawnAgent(state: SubState, prompt: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const args = [
			"--mode", "json",
			"-p",
			"--session", state.sessionFile,
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--tools", "read,bash,grep,find,ls",
			"--thinking", "off",
		];
		if (model) args.push("--model", model);
		if (state.turnCount > 1 || fs.existsSync(state.sessionFile)) args.push("-c");
		args.push(prompt);

		return new Promise((resolve) => {
			const start = Date.now();
			state.timer = setInterval(() => { state.elapsed = Date.now() - start; updateWidgets(); }, 1000);
			try { (state.timer as any).unref?.(); } catch {}

			let proc: ChildProcessWithoutNullStreams;
			try {
				proc = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"], cwd: ctx.cwd, env: { ...process.env } });
			} catch (err: any) {
				state.status = "error";
				state.stderr = `Error spawning subagent: ${err?.message ?? String(err)}`;
				if (state.timer) clearInterval(state.timer);
				updateWidgets();
				resolve();
				return;
			}

			state.proc = proc;
			let buffer = "";
			const abort = () => {
				if (state.status === "running") state.status = "killed";
				try { proc.kill("SIGTERM"); } catch {}
				setTimeout(() => { try { if (!proc.killed) proc.kill("SIGKILL"); } catch {} }, 1500).unref?.();
				updateWidgets();
			};
			if (signal?.aborted) abort();
			signal?.addEventListener("abort", abort, { once: true });

			proc.stdout.setEncoding("utf-8");
			proc.stdout.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) if (line.trim()) { try { processEvent(state, JSON.parse(line)); } catch {} }
			});
			proc.stderr.setEncoding("utf-8");
			proc.stderr.on("data", (chunk: string) => {
				if (chunk.trim()) state.stderr += chunk;
				updateWidgets();
			});
			proc.on("error", (err) => {
				state.status = "error";
				state.stderr += `Error: ${err.message}`;
			});
			proc.on("close", (code) => {
				signal?.removeEventListener("abort", abort);
				if (buffer.trim()) { try { processEvent(state, JSON.parse(buffer)); } catch {} }
				if (state.timer) clearInterval(state.timer);
				state.elapsed = Date.now() - start;
				if (state.status !== "killed") state.status = code === 0 ? "done" : "error";
				state.proc = undefined;
				const result = state.finalText || state.textChunks.join("") || state.stderr;
				updateWidgets();
				if (ctx.hasUI) ctx.ui.notify(`Subagent #${state.id} ${state.status} in ${Math.round(state.elapsed / 1000)}s`, state.status === "done" ? "info" : state.status === "killed" ? "warning" : "error");
				pi.sendMessage({
					customType: "subagent-result",
					display: true,
					content: `Subagent #${state.id}${state.turnCount > 1 ? ` (turn ${state.turnCount})` : ""} finished: ${prompt}\n\n${result.slice(0, 8000)}${result.length > 8000 ? "\n\n... [truncated]" : ""}`,
					details: { id: state.id, status: state.status, elapsed: state.elapsed, sessionFile: state.sessionFile },
				}, { deliverAs: "followUp", triggerTurn: true });
				resolve();
			});
		});
	}

	function createSubagent(task: string, ctx: ExtensionContext, signal?: AbortSignal): SubState {
		currentCtx = ctx;
		const id = nextId++;
		const state: SubState = { id, status: "running", task, textChunks: [], finalText: "", toolCount: 0, elapsed: 0, sessionFile: makeSessionFile(ctx, id), turnCount: 1, stderr: "" };
		agents.set(id, state);
		updateWidgets();
		void spawnAgent(state, task, ctx, signal);
		return state;
	}

	function continueSubagent(id: number, prompt: string, ctx: ExtensionContext, signal?: AbortSignal): string {
		currentCtx = ctx;
		const state = agents.get(id);
		if (!state) return `Error: No subagent #${id} found.`;
		if (state.status === "running") return `Error: Subagent #${id} is still running.`;
		state.status = "running";
		state.task = prompt;
		state.textChunks = [];
		state.finalText = "";
		state.stderr = "";
		state.elapsed = 0;
		state.toolCount = 0;
		state.turnCount++;
		updateWidgets();
		void spawnAgent(state, prompt, ctx, signal);
		return `Subagent #${id} continuing in background.`;
	}

	function removeSubagent(id: number, ctx: ExtensionContext): string {
		const state = agents.get(id);
		if (!state) return `Error: No subagent #${id} found.`;
		if (state.proc && state.status === "running") {
			state.status = "killed";
			try { state.proc.kill("SIGTERM"); } catch {}
		}
		if (state.timer) clearInterval(state.timer);
		agents.delete(id);
		if (ctx.hasUI) ctx.ui.setWidget(`sub-${id}`, undefined);
		return `Subagent #${id} removed.`;
	}

	pi.registerMessageRenderer("subagent-result", (message, _options, theme) => new Text(theme.fg("accent", "☷ subagent result") + "\n" + theme.fg("muted", String(message.content)), 0, 0));

	pi.registerTool({
		name: "subagent_create",
		label: "Subagent Create",
		description: "Spawn a background child Pi subagent. Returns immediately; result arrives later as a follow-up message.",
		parameters: Type.Object({ task: Type.String({ description: "Task for the subagent" }) }),
		async execute(_callId, args, signal, _onUpdate, ctx) {
			const state = createSubagent(args.task, ctx, signal);
			return { content: [{ type: "text" as const, text: `Subagent #${state.id} spawned in background.` }], details: { id: state.id, sessionFile: state.sessionFile } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("subagent_create ")) + theme.fg("muted", truncateToWidth((args as any).task || "", 64)), 0, 0); },
		renderResult(result, _opts, theme) { return new Text(theme.fg("accent", `☷ subagent #${(result.details as any)?.id ?? "?"}`), 0, 0); },
	});

	pi.registerTool({
		name: "subagent_continue",
		label: "Subagent Continue",
		description: "Continue an existing finished subagent session in the background.",
		parameters: Type.Object({ id: Type.Number(), prompt: Type.String() }),
		async execute(_callId, args, signal, _onUpdate, ctx) {
			return { content: [{ type: "text" as const, text: continueSubagent(args.id, args.prompt, ctx, signal) }] };
		},
	});

	pi.registerTool({
		name: "subagent_remove",
		label: "Subagent Remove",
		description: "Remove a subagent widget; kills it if running.",
		parameters: Type.Object({ id: Type.Number() }),
		async execute(_callId, args, _signal, _onUpdate, ctx) { return { content: [{ type: "text" as const, text: removeSubagent(args.id, ctx) }] }; },
	});

	pi.registerTool({
		name: "subagent_list",
		label: "Subagent List",
		description: "List background subagents and their status.",
		parameters: Type.Object({}),
		async execute() {
			const text = agents.size ? [...agents.values()].map((s) => `#${s.id} [${s.status}] turn ${s.turnCount}: ${s.task}`).join("\n") : "No subagents.";
			return { content: [{ type: "text" as const, text }] };
		},
	});

	pi.registerCommand("sub", { description: "Spawn background subagent: /sub <task>", handler: async (args, ctx) => { const task = args.trim(); if (!task) return ctx.ui.notify("Usage: /sub <task>", "error"); createSubagent(task, ctx); } });
	pi.registerCommand("subcont", { description: "Continue subagent: /subcont <id> <prompt>", handler: async (args, ctx) => { const trimmed = args.trim(); const i = trimmed.indexOf(" "); if (i < 0) return ctx.ui.notify("Usage: /subcont <id> <prompt>", "error"); const id = Number.parseInt(trimmed.slice(0, i), 10); const prompt = trimmed.slice(i + 1).trim(); if (!Number.isFinite(id) || !prompt) return ctx.ui.notify("Usage: /subcont <id> <prompt>", "error"); ctx.ui.notify(continueSubagent(id, prompt, ctx), "info"); } });
	pi.registerCommand("subrm", { description: "Remove subagent: /subrm <id>", handler: async (args, ctx) => { const id = Number.parseInt(args.trim(), 10); if (!Number.isFinite(id)) return ctx.ui.notify("Usage: /subrm <id>", "error"); ctx.ui.notify(removeSubagent(id, ctx), "info"); } });
	pi.registerCommand("subclear", { description: "Clear all subagents", handler: async (_args, ctx) => { let n = 0; for (const id of [...agents.keys()]) { removeSubagent(id, ctx); n++; } nextId = 1; ctx.ui.notify(n ? `Cleared ${n} subagent(s).` : "No subagents to clear.", "info"); } });

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		currentCtx = ctx;
		for (const id of [...agents.keys()]) removeSubagent(id, ctx);
		agents.clear();
		nextId = 1;
		if (ctx.hasUI) ctx.ui.setStatus("subagents", "☷ subagents ready");
	});

	pi.on("session_shutdown", async () => {
		for (const state of agents.values()) {
			if (state.timer) clearInterval(state.timer);
			if (state.proc && state.status === "running") { try { state.proc.kill("SIGTERM"); } catch {} }
		}
		if (currentCtx?.hasUI) {
			for (const id of agents.keys()) { try { currentCtx.ui.setWidget(`sub-${id}`, undefined); } catch {} }
			try { currentCtx.ui.setStatus("subagents", undefined); } catch {}
		}
	});
}
