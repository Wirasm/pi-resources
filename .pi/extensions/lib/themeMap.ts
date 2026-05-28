// @ts-nocheck
/**
 * themeMap.ts — Per-extension default theme assignments
 *
 * Themes live in .pi/themes/ and are mapped by extension filename (no extension).
 * Each extension calls applyExtensionDefaults(import.meta.url, ctx) in its
 * session_start hook to automatically load its designated theme and title.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

export const THEME_MAP: Record<string, string> = {
	"agent-chain": "midnight-ocean",
	"agent-team": "dracula",
	"coms": "ocean-breeze",
	"coms-net": "ocean-breeze",
	"cross-agent": "ocean-breeze",
	"damage-control": "gruvbox",
	"minimal": "synthwave",
	"pi-pi": "rose-pine",
	"pure-focus": "everforest",
	"purpose-gate": "tokyo-night",
	"session-replay": "catppuccin-mocha",
	"subagent-widget": "cyberpunk",
	"system-select": "catppuccin-mocha",
	"theme-cycler": "synthwave",
	"tilldone": "everforest",
	"tool-counter": "synthwave",
	"tool-counter-widget": "synthwave",
};

function extensionName(fileUrl: string): string {
	const filePath = fileUrl.startsWith("file://") ? fileURLToPath(fileUrl) : fileUrl;
	return basename(filePath).replace(/\.[^.]+$/, "");
}

function primaryExtensionName(): string | null {
	const argv = process.argv;
	for (let i = 0; i < argv.length - 1; i++) {
		if (argv[i] === "-e" || argv[i] === "--extension") {
			return basename(argv[i + 1]).replace(/\.[^.]+$/, "");
		}
	}
	return null;
}

export function applyExtensionTheme(fileUrl: string, ctx: ExtensionContext): boolean {
	if (!ctx.hasUI) return false;
	const name = extensionName(fileUrl);
	const primaryExt = primaryExtensionName();
	if (primaryExt && primaryExt !== name) return true;

	const themeName = THEME_MAP[name] ?? "synthwave";
	const result = ctx.ui.setTheme(themeName);
	if (!result.success && themeName !== "synthwave") return ctx.ui.setTheme("synthwave").success;
	return result.success;
}

function applyExtensionTitle(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const name = primaryExtensionName();
	if (!name) return;
	setTimeout(() => ctx.ui.setTitle(`π - ${name}`), 150);
}

export function applyExtensionDefaults(fileUrl: string, ctx: ExtensionContext): void {
	applyExtensionTheme(fileUrl, ctx);
	applyExtensionTitle(ctx);
}
