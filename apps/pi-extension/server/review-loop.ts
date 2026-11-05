/**
 * node:http adapter for the review loop of a screen
 * (packages/shared/review-loop.ts, vendored to generated/review-loop.ts).
 * Mirrors packages/server/review-loop.ts.
 *
 * Pi opens its reviews in-process and tags no agent session for the loop, so
 * the loop stays off here (its paths answer as a Bun server with no host that
 * carries sends); the paths are served so both runtimes answer the same API.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig, resolveExperimental } from "../generated/config.ts";
import { getPlannotatorDataDir } from "../generated/data-dir.ts";
import type { ExternalAnnotationEvent } from "../generated/external-annotation.ts";
import type { HostMessage } from "../generated/host-messages.ts";
import type { ReviewTarget } from "../generated/review-journal.ts";
import { createReviewLoop, isReviewLoopPath, reviewLoopSessionOf, type ReviewLoop, type ReviewLoopCarrier } from "../generated/review-loop.ts";
import { json, readBody } from "./helpers.ts";

export type { ReviewLoop } from "../generated/review-loop.ts";

export function createPiReviewLoop(input: {
	/** The agent session the sends go to (`<host>:<session id>`); Pi names none today. */
	hostSession?: string;
	reviewId?: string;
	target: ReviewTarget | null;
	root: string;
	carrier: () => ReviewLoopCarrier | null;
	broadcast: (event: ExternalAnnotationEvent<never>) => void;
	hostToken: string | undefined;
	getServerPort: () => number | undefined;
	messages?: readonly HostMessage[];
}): ReviewLoop {
	return createReviewLoop({
		dataDir: getPlannotatorDataDir(),
		enabled: resolveExperimental(loadConfig(), "persistent-comments"),
		target: input.target,
		to: reviewLoopSessionOf(input.hostSession),
		...(input.reviewId ? { reviewId: input.reviewId } : {}),
		root: input.root,
		carrier: input.carrier,
		broadcast: input.broadcast,
		hostToken: () => input.hostToken,
		getServerPort: input.getServerPort,
		...(input.messages !== undefined ? { messages: input.messages } : {}),
	});
}

/** Answers a review loop path and returns true, or returns false when the request is not one. */
export async function handleReviewLoop(req: IncomingMessage, res: ServerResponse, url: URL, loop: ReviewLoop): Promise<boolean> {
	if (!isReviewLoopPath(url.pathname)) return false;
	const header = (name: string): string | null => {
		const value = req.headers[name];
		return typeof value === "string" ? value : Array.isArray(value) ? (value[0] ?? null) : null;
	};
	let body: unknown;
	if (req.method === "POST") {
		try {
			body = JSON.parse(await readBody(req));
		} catch {
			body = undefined;
		}
	}
	const answer = await loop.handle({
		method: req.method ?? "GET",
		pathname: url.pathname,
		host: header("host"),
		origin: header("origin"),
		authorization: header("authorization"),
		body,
	});
	if (!answer) return false;
	json(res, answer.body, answer.status);
	return true;
}
