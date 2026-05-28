// @ts-nocheck
/**
 * Agent Team — Dispatcher-only orchestrator with grid dashboard
 *
 * Primary Pi agent is restricted to dispatch_agent. Specialist agents run as
 * separate `pi --mode json -p` child processes and keep per-agent session files
 * under .pi/agent-sessions/ for cross-invocation memory.
 *
 * Agent definitions:
 *   agents/*.md, .claude/agents/*.md, .pi/agents/*.md
 *
 * Team definitions:
 *   .pi/agents/teams.yaml
 *
 * Usage:
 *   pi -e .pi/extensions/agent-team.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, type AutocompleteItem, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
	file: string;
}

interface AgentState {
	def: AgentDef;
	status: "idle" | "running" | "done" | "error";
	task: string;
	toolCount: number;
	elapsed: number;
	lastWork: string;
	contextPct: number;
	sessionFile: string | null;
	runCount: number;
	process?: ChildProcessWithoutNullStreams;
	timer?: ReturnType<typeof setInterval>;
}

type DispatchResult = { output: string; exitCode: number; elapsed: number };

function displayName(name: string): string {
	return name
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

function slug(name: string): string {
	return name.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

function parseScalar(v: string): string {
	let out = v.trim();
	if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
		out = out.slice(1, -1);
	}
	return out;
}

function parseTeamsYaml(raw: string): Record<string, string[]> {
	const teams: Record<string, string[]> = {};
	let current: string | null = null;
	for (const rawLine of raw.split("\n")) {
		const line = rawLine.replace(/\s+#.*$/, "").trimEnd();
		if (!line.trim()) continue;

		const teamMatch = line.match(/^([^\s][^:]*):\s*$/);
		if (teamMatch) {
			current = parseScalar(teamMatch[1]);
			teams[current] = [];
			continue;
		}

		const itemMatch = line.match(/^\s*-\s+(.+)$/);
		if (itemMatch && current) {
			teams[current].push(parseScalar(itemMatch[1]));
		}
	}
	return teams;
}

function parseAgentFile(filePath: string): AgentDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
		if (!match) return null;

		const frontmatter: Record<string, string> = {};
		for (const line of match[1].split(/\r?\n/)) {
			const idx = line.indexOf(":");
			if (idx <= 0) continue;
			frontmatter[line.slice(0, idx).trim()] = parseScalar(line.slice(idx + 1));
		}

		if (!frontmatter.name) return null;
		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools: frontmatter.tools || "read,grep,find,ls",
			systemPrompt: match[2].trim(),
			file: filePath,
		};
	} catch {
		return null;
	}
}

function scanAgentDirs(cwd: string): AgentDef[] {
	const dirs = [join(cwd, "agents"), join(cwd, ".claude", "agents"), join(cwd, ".pi", "agents")];
	const agents: AgentDef[] = [];
	const seen = new Set<string>();

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".md")) continue;
				const def = parseAgentFile(resolve(dir, file));
				const key = def?.name.toLowerCase();
				if (def && key && !seen.has(key)) {
					seen.add(key);
					agents.push(def);
				}
			}
		} catch {
			// Ignore unreadable dirs.
		}
	}
	return agents;
}

function assistantText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b && b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	const agentStates = new Map<string, AgentState>();
	let allAgentDefs: AgentDef[] = [];
	let teams: Record<string, string[]> = {};
	let activeTeamName = "";
	let gridCols = 2;
	let currentCtx: ExtensionContext | null = null;
	let sessionDir = "";
	let contextWindow = 0;

	function loadAgents(cwd: string): void {
		sessionDir = join(cwd, ".pi", "agent-sessions");
		mkdirSync(sessionDir, { recursive: true });

		allAgentDefs = scanAgentDirs(cwd);
		const teamsPath = join(cwd, ".pi", "agents", "teams.yaml");
		if (existsSync(teamsPath)) {
			try {
				teams = parseTeamsYaml(readFileSync(teamsPath, "utf-8"));
			} catch {
				teams = {};
			}
		} else {
			teams = {};
		}

		if (Object.keys(teams).length === 0) {
			teams = { all: allAgentDefs.map((d) => d.name) };
		}
	}

	function activateTeam(teamName: string): void {
		// Stop showing stale running states from a previous team, but do not delete
		// session files: specialists keep memory across invocations by design.
		for (const s of agentStates.values()) {
			if (s.timer) clearInterval(s.timer);
		}

		activeTeamName = teamName;
		const members = teams[teamName] || [];
		const defsByName = new Map(allAgentDefs.map((d) => [d.name.toLowerCase(), d]));

		agentStates.clear();
		for (const member of members) {
			const def = defsByName.get(member.toLowerCase());
			if (!def) continue;
			const sessionFile = join(sessionDir, `${slug(def.name)}.jsonl`);
			agentStates.set(def.name.toLowerCase(), {
				def,
				status: "idle",
				task: "",
				toolCount: 0,
				elapsed: 0,
				lastWork: "",
				contextPct: 0,
				sessionFile: existsSync(sessionFile) ? sessionFile : null,
				runCount: 0,
			});
		}

		const size = agentStates.size;
		gridCols = Math.max(1, size <= 3 ? size : size === 4 ? 2 : 3);
	}

	function renderCard(state: AgentState, colWidth: number, theme: any): string[] {
		const w = Math.max(12, colWidth - 2);
		const trunc = (s: string, max: number) => truncateToWidth(s || "", Math.max(0, max));

		const statusColor = state.status === "idle" ? "dim" : state.status === "running" ? "accent" : state.status === "done" ? "success" : "error";
		const statusIcon = state.status === "idle" ? "○" : state.status === "running" ? "●" : state.status === "done" ? "✓" : "✗";

		const nameRaw = trunc(displayName(state.def.name), w - 1);
		const nameStr = theme.fg("accent", theme.bold(nameRaw));

		const statusRaw = `${statusIcon} ${state.status}${state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}s` : ""}${state.toolCount ? ` · ${state.toolCount} tools` : ""}`;
		const statusShown = trunc(statusRaw, w - 1);

		const pct = Math.max(0, Math.min(100, state.contextPct || 0));
		const filled = Math.max(0, Math.min(5, Math.ceil(pct / 20)));
		const ctxRaw = `[${"#".repeat(filled)}${"-".repeat(5 - filled)}] ${Math.ceil(pct)}%`;
		const ctxShown = trunc(ctxRaw, w - 1);

		const workRaw = state.task ? state.lastWork || state.task : state.def.description;
		const workShown = trunc(workRaw || "no description", w - 1);

		const top = "┌" + "─".repeat(w) + "┐";
		const bot = "└" + "─".repeat(w) + "┘";
		const border = (content: string, visible: number) =>
			theme.fg("dim", "│") + content + " ".repeat(Math.max(0, w - visible)) + theme.fg("dim", "│");

		return [
			theme.fg("dim", top),
			border(" " + nameStr, 1 + visibleWidth(nameRaw)),
			border(" " + theme.fg(statusColor, statusShown), 1 + visibleWidth(statusShown)),
			border(" " + theme.fg("dim", ctxShown), 1 + visibleWidth(ctxShown)),
			border(" " + theme.fg("muted", workShown), 1 + visibleWidth(workShown)),
			theme.fg("dim", bot),
		];
	}

	function installOrRefreshWidget(): void {
		const ctx = currentCtx;
		if (!ctx?.hasUI) return;
		ctx.ui.setWidget(
			"agent-team",
			(_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] {
					if (agentStates.size === 0) return [theme.fg("dim", "No active agents. Add .md files to agents/ or define .pi/agents/teams.yaml.")];

					const cols = Math.max(1, Math.min(gridCols, agentStates.size));
					const gap = 1;
					const colWidth = Math.max(14, Math.floor((width - gap * (cols - 1)) / cols));
					const agents = [...agentStates.values()];
					const lines: string[] = [];

					for (let i = 0; i < agents.length; i += cols) {
						const rowAgents = agents.slice(i, i + cols);
						const cards = rowAgents.map((a) => renderCard(a, colWidth, theme));
						while (cards.length < cols) cards.push(Array(6).fill(" ".repeat(colWidth)));
						for (let line = 0; line < cards[0].length; line++) {
							lines.push(cards.map((card) => card[line] || "").join(" ".repeat(gap)));
						}
					}
					return lines.map((line) => truncateToWidth(line, width));
				},
			}),
			{ placement: "belowEditor" },
		);
	}

	function markWidgetChanged(): void {
		installOrRefreshWidget();
	}

	function dispatchAgent(agentName: string, task: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<DispatchResult> {
		const state = agentStates.get(agentName.toLowerCase());
		if (!state) {
			return Promise.resolve({
				output: `Agent "${agentName}" not found. Available: ${[...agentStates.values()].map((s) => s.def.name).join(", ")}`,
				exitCode: 1,
				elapsed: 0,
			});
		}
		if (state.status === "running") {
			return Promise.resolve({ output: `Agent "${displayName(state.def.name)}" is already running.`, exitCode: 1, elapsed: 0 });
		}

		state.status = "running";
		state.task = task;
		state.toolCount = 0;
		state.elapsed = 0;
		state.lastWork = "";
		state.runCount++;
		markWidgetChanged();

		const startTime = Date.now();
		state.timer = setInterval(() => {
			state.elapsed = Date.now() - startTime;
			markWidgetChanged();
		}, 1000);
		try { (state.timer as any).unref?.(); } catch {}

		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const agentSessionFile = join(sessionDir, `${slug(state.def.name)}.jsonl`);
		const args = [
			"--mode", "json",
			"-p",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--thinking", "off",
			"--tools", state.def.tools,
			"--append-system-prompt", state.def.systemPrompt,
			"--session", agentSessionFile,
		];
		if (model) args.push("--model", model);
		if (state.sessionFile || existsSync(agentSessionFile)) args.push("-c");
		args.push(task);

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
				if (exitCode === 0) state.sessionFile = agentSessionFile;
				state.lastWork = (output.split("\n").filter((l) => l.trim()).pop() || state.status).slice(0, 240);
				markWidgetChanged();
				if (ctx.hasUI) {
					ctx.ui.notify(`${displayName(state.def.name)} ${state.status} in ${Math.round(state.elapsed / 1000)}s`, state.status === "done" ? "info" : "error");
				}
				resolvePromise({ output, exitCode, elapsed: state.elapsed });
			};

			const handleEvent = (event: any) => {
				if (event.type === "message_update") {
					const delta = event.assistantMessageEvent;
					const text = delta?.type === "text_delta" ? delta.delta : delta?.text ?? "";
					if (text) {
						textChunks.push(text);
						state.lastWork = textChunks.join("").split("\n").filter((l) => l.trim()).pop() || "working...";
						markWidgetChanged();
					}
				} else if (event.type === "tool_execution_start") {
					state.toolCount++;
					state.lastWork = `using ${event.toolName || "tool"}`;
					markWidgetChanged();
				} else if (event.type === "message_end") {
					if (event.message?.role === "assistant") finalAssistantText = assistantText(event.message) || finalAssistantText;
					if (event.message?.usage && contextWindow > 0) {
						state.contextPct = ((event.message.usage.input || 0) / contextWindow) * 100;
						markWidgetChanged();
					}
				} else if (event.type === "agent_end") {
					const last = [...(event.messages || [])].reverse().find((m: any) => m.role === "assistant");
					if (last) finalAssistantText = assistantText(last) || finalAssistantText;
					if (last?.usage && contextWindow > 0) {
						state.contextPct = ((last.usage.input || 0) / contextWindow) * 100;
						markWidgetChanged();
					}
				}
			};

			let proc: ChildProcessWithoutNullStreams;
			try {
				proc = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"], cwd: ctx.cwd, env: { ...process.env } });
			} catch (err: any) {
				finish(1, `Error spawning agent: ${err?.message ?? String(err)}`);
				return;
			}
			state.process = proc;

			const abort = () => {
				try { proc.kill("SIGTERM"); } catch {}
				setTimeout(() => { try { if (!proc.killed) proc.kill("SIGKILL"); } catch {} }, 1500).unref?.();
			};
			if (signal?.aborted) abort();
			signal?.addEventListener("abort", abort, { once: true });

			proc.stdout.setEncoding("utf-8");
			proc.stdout.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try { handleEvent(JSON.parse(line)); } catch {}
				}
			});

			proc.stderr.setEncoding("utf-8");
			proc.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});

			proc.on("error", (err) => finish(1, `Error spawning agent: ${err.message}`));
			proc.on("close", (code) => {
				signal?.removeEventListener("abort", abort);
				if (buffer.trim()) {
					try { handleEvent(JSON.parse(buffer)); } catch {}
				}
				const output = finalAssistantText || textChunks.join("") || (stderr.trim() ? `No assistant output. stderr:\n${stderr.trim()}` : "");
				finish(code ?? 1, output);
			});
		});
	}

	pi.registerTool({
		name: "dispatch_agent",
		label: "Dispatch Agent",
		description: "Dispatch a focused task to a specialist agent from the active team. The specialist runs in its own persistent Pi session and returns its final answer.",
		parameters: Type.Object({
			agent: Type.String({ description: "Exact agent name from the active team, case-insensitive." }),
			task: Type.String({ description: "Focused task description for the specialist agent." }),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { agent, task } = params as { agent: string; task: string };
			onUpdate?.({ content: [{ type: "text", text: `Dispatching to ${agent}...` }], details: { agent, task, status: "dispatching" } });
			const result = await dispatchAgent(agent, task, ctx, signal);
			const status = result.exitCode === 0 ? "done" : "error";
			const truncated = result.output.length > 8000 ? `${result.output.slice(0, 8000)}\n\n... [truncated]` : result.output;
			return {
				content: [{ type: "text" as const, text: `[${agent}] ${status} in ${Math.round(result.elapsed / 1000)}s\n\n${truncated}` }],
				details: { agent, task, status, elapsed: result.elapsed, exitCode: result.exitCode, fullOutput: result.output },
			};
		},
		renderCall(args, theme) {
			const agentName = (args as any).agent || "?";
			const task = (args as any).task || "";
			const preview = task.length > 60 ? task.slice(0, 57) + "..." : task;
			return new Text(theme.fg("toolTitle", theme.bold("dispatch_agent ")) + theme.fg("accent", agentName) + theme.fg("dim", " — ") + theme.fg("muted", preview), 0, 0);
		},
		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (options.isPartial || details.status === "dispatching") return new Text(theme.fg("accent", `● ${details.agent || "?"}`) + theme.fg("dim", " working..."), 0, 0);
			const icon = details.status === "done" ? "✓" : "✗";
			const color = details.status === "done" ? "success" : "error";
			const elapsed = typeof details.elapsed === "number" ? Math.round(details.elapsed / 1000) : 0;
			const header = theme.fg(color, `${icon} ${details.agent}`) + theme.fg("dim", ` ${elapsed}s`);
			if (options.expanded && details.fullOutput) {
				const output = details.fullOutput.length > 4000 ? details.fullOutput.slice(0, 4000) + "\n... [truncated]" : details.fullOutput;
				return new Text(header + "\n" + theme.fg("muted", output), 0, 0);
			}
			return new Text(header, 0, 0);
		},
	});

	pi.registerCommand("agents-team", {
		description: "Select active specialist team",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			const teamNames = Object.keys(teams);
			if (teamNames.length === 0) return ctx.ui.notify("No teams available", "warning");
			const options = teamNames.map((name) => `${name} — ${(teams[name] || []).map(displayName).join(", ")}`);
			const choice = await ctx.ui.select("Select Team", options);
			if (choice === undefined) return;
			const name = teamNames[options.indexOf(choice)];
			activateTeam(name);
			installOrRefreshWidget();
			ctx.ui.setStatus("agent-team", `Team: ${name} (${agentStates.size})`);
		},
	});

	pi.registerCommand("agents-list", {
		description: "List active team agents",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			const names = [...agentStates.values()].map((s) => `${s.def.name} (${s.status}, ${s.sessionFile ? "resumed" : "new"}, runs: ${s.runCount}): ${s.def.description}`).join("\n");
			ctx.ui.notify(names || "No agents loaded", "info");
		},
	});

	pi.registerCommand("agents-grid", {
		description: "Set grid columns: /agents-grid <1-6>",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = ["1", "2", "3", "4", "5", "6"].map((n) => ({ value: n, label: `${n} columns` }));
			return items.filter((i) => i.value.startsWith(prefix)) || items;
		},
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const n = Number.parseInt(args.trim(), 10);
			if (n >= 1 && n <= 6) {
				gridCols = n;
				installOrRefreshWidget();
				ctx.ui.notify(`Grid set to ${gridCols} columns`, "info");
			} else {
				ctx.ui.notify("Usage: /agents-grid <1-6>", "error");
			}
		},
	});

	pi.on("before_agent_start", async (event) => {
		const agentCatalog = [...agentStates.values()]
			.map((s) => `### ${displayName(s.def.name)}\nDispatch as: \`${s.def.name}\`\n${s.def.description}\nTools: ${s.def.tools}`)
			.join("\n\n");
		const teamMembers = [...agentStates.values()].map((s) => displayName(s.def.name)).join(", ") || "none";
		return {
			systemPrompt: `${event.systemPrompt}\n\n# Agent Team Dispatcher Mode\n\nYou are a dispatcher agent. You coordinate specialist agents to accomplish tasks. You do NOT have direct access to the codebase. You MUST delegate all codebase work through the dispatch_agent tool.\n\n## Active Team: ${activeTeamName || "none"}\nMembers: ${teamMembers}\n\nYou can ONLY dispatch to agents listed below.\n\n## Rules\n- Use dispatch_agent for codebase inspection, implementation, tests, review, and shell work.\n- Break user requests into clear focused sub-tasks.\n- Choose the right agent for each sub-task.\n- Review results and dispatch follow-up agents if needed.\n- Summarize the final outcome for the user.\n\n## Agents\n\n${agentCatalog || "No agents loaded."}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		contextWindow = ctx.model?.contextWindow || 0;
		loadAgents(ctx.cwd);

		const teamNames = Object.keys(teams);
		if (teamNames.length > 0) {
			let selected = teamNames[0];
			if (ctx.hasUI && teamNames.length > 1) {
				const options = teamNames.map((name) => `${name} — ${(teams[name] || []).map(displayName).join(", ")}`);
				const choice = await ctx.ui.select("Select Agent Team", options);
				if (choice !== undefined) selected = teamNames[options.indexOf(choice)];
			}
			activateTeam(selected);
		}

		pi.setActiveTools(["dispatch_agent"]);
		if (ctx.hasUI) {
			ctx.ui.setStatus("agent-team", `Team: ${activeTeamName} (${agentStates.size})`);
			installOrRefreshWidget();
			const members = [...agentStates.values()].map((s) => displayName(s.def.name)).join(", ");
			ctx.ui.notify(`Team: ${activeTeamName || "none"}${members ? ` (${members})` : ""}\n/agents-team select · /agents-list list · /agents-grid <1-6>`, "info");
			ctx.ui.setFooter((_tui, theme) => ({
				dispose() {},
				invalidate() {},
				render(width: number): string[] {
					const model = ctx.model?.id || "no-model";
					const pct = ctx.getContextUsage()?.percent ?? 0;
					const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
					const bar = "#".repeat(filled) + "-".repeat(10 - filled);
					const left = theme.fg("dim", ` ${model}`) + theme.fg("muted", " · ") + theme.fg("accent", activeTeamName || "no-team");
					const right = theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
					const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					return [truncateToWidth(left + pad + right, width)];
				},
			}));
		}
	});

	pi.on("session_shutdown", async () => {
		for (const s of agentStates.values()) {
			if (s.timer) clearInterval(s.timer);
			if (s.process && !s.process.killed) {
				try { s.process.kill("SIGTERM"); } catch {}
			}
		}
		if (currentCtx?.hasUI) {
			try { currentCtx.ui.setWidget("agent-team", undefined); } catch {}
			try { currentCtx.ui.setStatus("agent-team", undefined); } catch {}
			try { currentCtx.ui.setFooter(undefined); } catch {}
		}
	});
}
