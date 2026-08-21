import type { Theme } from "@earendil-works/pi-coding-agent";

export const FOOTER_CONTRIBUTION_EVENT = "vessup:footer:contribution";

export type FooterUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
};

export type FooterContribution = {
	sessionId: string;
	key: string;
	remove?: boolean;
	topRight?: (theme: Theme) => string | undefined;
	status?: {
		text: string;
		selected?: boolean;
	};
	usage?: FooterUsage;
	onBranchChange?: () => void;
};

export function parseFooterContribution(value: unknown): FooterContribution | undefined {
	if (!value || typeof value !== "object") return undefined;
	const event = value as Record<string, unknown>;
	if (typeof event.sessionId !== "string" || typeof event.key !== "string" || !event.key) return undefined;
	if (event.remove !== undefined && typeof event.remove !== "boolean") return undefined;
	if (event.topRight !== undefined && typeof event.topRight !== "function") return undefined;
	if (event.onBranchChange !== undefined && typeof event.onBranchChange !== "function") return undefined;
	if (event.status !== undefined) {
		if (!event.status || typeof event.status !== "object") return undefined;
		const status = event.status as Record<string, unknown>;
		if (typeof status.text !== "string") return undefined;
		if (status.selected !== undefined && typeof status.selected !== "boolean") return undefined;
	}
	if (event.usage !== undefined && (!event.usage || typeof event.usage !== "object")) return undefined;
	return value as FooterContribution;
}
