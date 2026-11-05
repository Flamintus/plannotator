/**
 * Bun adapter for the review loop of a screen (packages/shared/review-loop.ts):
 * builds the loop from what the CLI that launched the server knows, and turns
 * a request to one of its paths into a Response. The Pi mirror lives in
 * apps/pi-extension/server/review-loop.ts.
 */

import { inboxAgentName } from "@plannotator/core/inbox-types";
import { resolveExperimental } from "@plannotator/shared/config";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { HOST_CONTROL_DISABLED_CODE } from "@plannotator/shared/host-control";
import type { HostMessage } from "@plannotator/shared/host-messages";
import type { ReviewTarget } from "@plannotator/shared/review-journal";
import { createReviewLoop, isReviewLoopPath, reviewLoopSessionOf, type ReviewLoop, type ReviewLoopCarrier } from "@plannotator/shared/review-loop";
import { cameThroughTailscale } from "@plannotator/shared/tailnet-audience";
import type { ExternalAnnotationEvent } from "@plannotator/shared/external-annotation";
import { loadConfig } from "./config";

export type { ReviewLoop } from "@plannotator/shared/review-loop";

/**
 * What the host that launched this review tells the server, for the review
 * loop: the agent session (`PLANNOTATOR_SESSION_TAG`, `claude-code:<id>`) its
 * sends go to, and the id it gave the review (`PLANNOTATOR_HOST_REVIEW_ID`).
 * Set by the CLI; absent, the loop is off.
 */
export interface ReviewLoopLaunch {
  hostSession?: string;
  reviewId?: string;
  /**
   * The CLI publishes each decision as it comes and keeps the server up after
   * the person ends the review, so it can be reopened in its tab (`ended`).
   */
  reopen?: boolean;
}

export function createServerReviewLoop(input: {
  launch: ReviewLoopLaunch | undefined;
  target: ReviewTarget | null;
  root: string;
  /** The AI runtime's carrier (the pull bridge's sends), read each time. */
  carrier: () => ReviewLoopCarrier | null;
  broadcast: (event: ExternalAnnotationEvent<never>) => void;
  hostToken: string | undefined;
  getServerPort: () => number | undefined;
  /** A session published over the tailnet keeps today's single decision. */
  tailnetPublished?: boolean;
  messages?: readonly HostMessage[];
  /** The server takes decisions again; used only when the launch says the CLI keeps the server up (`reopen`). */
  onReopen?: () => void;
  /** A page is open on the review. */
  pageOpen?: () => boolean;
}): ReviewLoop {
  const to = reviewLoopSessionOf(input.launch?.hostSession);
  return createReviewLoop({
    dataDir: getPlannotatorDataDir(),
    enabled: input.launch !== undefined && input.tailnetPublished !== true && resolveExperimental(loadConfig(), "persistent-comments"),
    target: input.target,
    to,
    ...(input.launch?.reviewId ? { reviewId: input.launch.reviewId } : {}),
    root: input.root,
    carrier: input.carrier,
    broadcast: input.broadcast,
    hostToken: () => input.hostToken,
    getServerPort: input.getServerPort,
    ...(input.messages !== undefined ? { messages: input.messages } : {}),
    ...(input.launch?.reopen === true && input.onReopen ? { onReopen: input.onReopen } : {}),
    ...(input.pageOpen ? { pageOpen: input.pageOpen } : {}),
    agentName: inboxAgentName,
  });
}

/** The response for a review loop path, or null when the request is not one. */
export async function handleReviewLoopRequest(req: Request, url: URL, loop: ReviewLoop): Promise<Response | null> {
  if (!isReviewLoopPath(url.pathname)) return null;
  // The host's paths answer this machine only, as host control does.
  if (url.pathname.startsWith("/api/host/") && cameThroughTailscale(req.headers)) {
    return Response.json({ error: "Not found", code: HOST_CONTROL_DISABLED_CODE }, { status: 404 });
  }
  let body: unknown;
  if (req.method === "POST") body = await req.json().catch(() => undefined);
  const answer = await loop.handle({
    method: req.method,
    pathname: url.pathname,
    host: req.headers.get("host"),
    origin: req.headers.get("origin"),
    authorization: req.headers.get("authorization"),
    body,
  });
  return answer ? Response.json(answer.body, { status: answer.status }) : null;
}
