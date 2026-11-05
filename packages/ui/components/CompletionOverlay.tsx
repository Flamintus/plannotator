import { useEffect, useRef, type ReactNode } from 'react';
import { useAutoClose } from '../hooks/useAutoClose';

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const CheckIcon = () => (
  <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
  </svg>
);

const ChatBubbleIcon = () => (
  <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
    />
  </svg>
);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CompletionOverlayProps {
  /** `done`: the session finished with nothing sent (an annotate Done with
   *  no feedback). Neutral styling. `done` and `exited` (Close) send nothing,
   *  so neither shows the "response has been sent" line. */
  submitted: 'approved' | 'denied' | 'feedback' | 'done' | 'exited' | null | false;
  title: string;
  subtitle: string;
  agentLabel: string;
  /**
   * Optional destinations shown under the subtitle as ordinary links (opened
   * in a new tab by a real click, so no popup blocker applies) — e.g. the PR
   * a platform review was just posted to. Omitted or empty renders nothing.
   */
  links?: ReadonlyArray<{ href: string; label: string }>;
  /**
   * The page stays under the message, as crit's review dialog does (the
   * review loop, #1116): the message is a card over the page, and a press
   * outside it, Escape, or "Back to the page" calls this; the host then
   * unmounts the overlay. Absent: today's full-screen message, unchanged.
   */
  onDismiss?: () => void;
  /** With `onDismiss`: the review goes on in this tab (a round was sent), so it never closes the tab by itself. */
  reviewContinues?: boolean;
}

/** A press on the backdrop this soon after it opened is the rest of the click that opened it (crit's guard). */
const BACKDROP_GUARD_MS = 600;

/** The card over the page (with `onDismiss`): a press outside it or Escape takes it away. */
function OverPage({ state, onDismiss, children }: { state: string; onDismiss: () => void; children: ReactNode }) {
  const openedAt = useRef(Date.now());
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const backRef = useRef<HTMLButtonElement>(null);
  // Focus moves into the card, so no key reaches the page behind it.
  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dismissRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <div
      className="fixed inset-0 z-[100] bg-background/70 backdrop-blur-[2px] flex items-center justify-center p-4"
      data-completion-state={state}
      data-completion-over-page=""
      onClick={(event) => {
        if (event.target === event.currentTarget && Date.now() - openedAt.current > BACKDROP_GUARD_MS) onDismiss();
      }}
    >
      <div role="dialog" aria-modal="true" className="text-center space-y-6 max-w-md w-full px-8 py-8 rounded-xl border border-border bg-card shadow-xl">
        {children}
        <button
          ref={backRef}
          type="button"
          data-completion-back=""
          onClick={onDismiss}
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          Back to the page
        </button>
      </div>
    </div>
  );
}

export function CompletionOverlay({ submitted, title, subtitle, agentLabel, links, onDismiss, reviewContinues = false }: CompletionOverlayProps) {
  const { state, enableAndStart } = useAutoClose(!!submitted && !(onDismiss && reviewContinues));

  if (!submitted) return null;

  if (onDismiss) {
    return (
      <OverPage state={submitted} onDismiss={onDismiss}>
        <CompletionBody
          submitted={submitted}
          title={title}
          subtitle={subtitle}
          agentLabel={agentLabel}
          links={links}
          state={state}
          enableAndStart={enableAndStart}
          reviewContinues={reviewContinues}
        />
      </OverPage>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] bg-background flex items-center justify-center" data-completion-state={submitted}>
      <div className="text-center space-y-6 max-w-md px-8">
        <CompletionBody
          submitted={submitted}
          title={title}
          subtitle={subtitle}
          agentLabel={agentLabel}
          links={links}
          state={state}
          enableAndStart={enableAndStart}
        />
      </div>
    </div>
  );
}

/** The message: its mark, its words, and what happens to the tab now. */
function CompletionBody({
  submitted,
  title,
  subtitle,
  agentLabel,
  links,
  state,
  enableAndStart,
  reviewContinues = false,
}: Omit<CompletionOverlayProps, 'onDismiss' | 'submitted'> & {
  submitted: NonNullable<Exclude<CompletionOverlayProps['submitted'], false>>;
  state: ReturnType<typeof useAutoClose>['state'];
  enableAndStart: () => void;
}) {
  const isApproved = submitted === 'approved';
  const isDone = submitted === 'done';
  const sentNothing = isDone || submitted === 'exited';
  return (
    <>
        <div
          className={`mx-auto w-16 h-16 rounded-full flex items-center justify-center ${
            isApproved ? 'bg-success/20 text-success'
            : isDone ? 'bg-muted text-muted-foreground'
            : 'bg-accent/20 text-accent'
          }`}
        >
          {isApproved || isDone ? <CheckIcon /> : <ChatBubbleIcon />}
        </div>

        <div className="space-y-2">
          <h2 className="text-xl font-semibold text-foreground">{title}</h2>
          <p className="text-muted-foreground">{subtitle}</p>
          {links && links.length > 0 && (
            <div className="flex flex-col items-center gap-1 pt-1">
              {links.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-completion-link
                  className="text-sm font-medium text-primary underline-offset-4 hover:underline break-all"
                >
                  {link.label}
                </a>
              ))}
            </div>
          )}
        </div>

        <div className="pt-4 border-t border-border space-y-2">
          {reviewContinues ? (
            <p className="text-sm text-muted-foreground" data-completion-continues="">
              The review goes on in this tab: <span className="text-foreground font-medium">{agentLabel}</span> answers under each comment.
            </p>
          ) : state.phase === 'counting' ? (
            <>
              <p className="text-sm text-muted-foreground">
                This tab will close in <span className="text-foreground font-medium">{state.remaining}</span> second
                {state.remaining !== 1 ? 's' : ''}...
              </p>
              <p className="text-xs text-muted-foreground/60">You can change this in Settings.</p>
            </>
          ) : state.phase === 'closeFailed' ? (
            <>
              <p className="text-sm text-muted-foreground">
                Could not close this tab automatically. Please close it manually.
              </p>
              <p className="text-xs text-muted-foreground/60">
                Auto-close works when the tab is opened by {agentLabel}.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                You can close this tab and return to <span className="text-foreground font-medium">{agentLabel}</span>.
              </p>
              {state.phase === 'prompt' ? (
                <>
                  <label className="flex items-center justify-center gap-2 cursor-pointer group">
                    <input type="checkbox" checked={false} onChange={enableAndStart} className="accent-primary" />
                    <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors">
                      Auto-close this tab after 3 seconds
                    </span>
                  </label>
                  <p className="text-xs text-muted-foreground/60">You can change the delay in Settings.</p>
                </>
              ) : sentNothing ? null : (
                <p className="text-xs text-muted-foreground/60">Your response has been sent.</p>
              )}
            </>
          )}
        </div>
    </>
  );
}
