// Browser-only overlay for Tape Runner (Aug 9, 2026).
//
// Renders ONLY when the page runs standalone in a normal browser
// tab — i.e. `embed !== 1` AND the Flutter WebView's GameToFlutter
// channel is absent. Inside the app this component returns null on
// every render, so the in-app experience is byte-for-byte what it
// was before this file existed.
//
// What it adds for browser players:
//   - A game-over card (score + run stats) fed by the bridge's
//     standalone CustomEvent fallback.
//   - Score submission to the SEPARATE web leaderboard
//     (submitRunnerWebScore — Turnstile-gated, cookie identity,
//     country-flag avatar stamped server-side from the IP).
//   - A weekly / all-time leaderboard panel, also reachable
//     pre-game via a small trophy pill.
//   - "Play again" via the existing window.tapeRunner.restart().

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { GameOverMessage, GameToFlutterMessage } from './game/bridge';
import {
  fetchWebLeaderboard,
  flagEmoji,
  getSavedNickname,
  getWid,
  saveNickname,
  submitWebScore,
  TURNSTILE_SITE_KEY,
  type SubmitWebScoreResult,
  type WebLeaderboardData,
} from './game/webLeaderboard';

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id?: string) => void;
    };
  }
}

const ACCENT = '#b87333';
const CARD_BG = 'rgba(12, 12, 14, 0.96)';
const HAIRLINE = 'rgba(255, 255, 255, 0.12)';

type SubmitState = 'idle' | 'sending' | 'done' | 'error';

export default function WebOverlay() {
  // Standalone detection happens once, client-side. Defaults to
  // false so the server render + the in-app WebView both produce
  // nothing.
  const [standalone, setStandalone] = useState(false);
  const [wid, setWid] = useState('');

  const [over, setOver] = useState<GameOverMessage | null>(null);
  const [nickname, setNickname] = useState('');
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [submitResult, setSubmitResult] =
    useState<SubmitWebScoreResult | null>(null);
  const [submitError, setSubmitError] = useState('');

  const [board, setBoard] = useState<WebLeaderboardData | null>(null);
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [tab, setTab] = useState<'weekly' | 'allTime'>('weekly');

  // ── Turnstile (explicit render, same pattern as FeedbackForm) ──
  const tsRef = useRef<HTMLDivElement | null>(null);
  const tsWidgetId = useRef<string | null>(null);
  const [tsToken, setTsToken] = useState('');

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('embed') === '1' || window.GameToFlutter) return;
    // Post-hydration client-only detection — the sync setState here
    // is deliberate (SSR + the in-app WebView must render null, so
    // this can't be a lazy useState initializer without a hydration
    // mismatch). One extra render on mount is fine.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStandalone(true);
    setWid(getWid());
    setNickname(getSavedNickname());
  }, []);

  // Bridge fallback events → game-over card.
  useEffect(() => {
    if (!standalone) return;
    const onMessage = (ev: Event) => {
      const msg = (ev as CustomEvent<GameToFlutterMessage>).detail;
      if (!msg || msg.type !== 'gameOver') return;
      setOver(msg);
      setSubmitState('idle');
      setSubmitResult(null);
      setSubmitError('');
      setBoardOpen(false);
    };
    window.addEventListener('tape-runner-web-message', onMessage);
    return () =>
      window.removeEventListener('tape-runner-web-message', onMessage);
  }, [standalone]);

  // Mount the Turnstile widget the first time the game-over card
  // opens (its container div only exists inside the card).
  useEffect(() => {
    if (!standalone || !over) return;
    let cancelled = false;
    const SCRIPT_ID = 'cf-turnstile-script';
    const render = () => {
      if (cancelled || !window.turnstile || !tsRef.current) return;
      if (tsWidgetId.current) return;
      tsWidgetId.current = window.turnstile.render(tsRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        theme: 'dark',
        // Stealth — invisible for real players, interactive
        // challenge only when Cloudflare suspects a bot.
        appearance: 'interaction-only',
        callback: (t: string) => setTsToken(t),
        'error-callback': () => setTsToken(''),
        'expired-callback': () => setTsToken(''),
      });
    };
    if (window.turnstile) {
      render();
    } else if (!document.getElementById(SCRIPT_ID)) {
      const s = document.createElement('script');
      s.id = SCRIPT_ID;
      s.src =
        'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.defer = true;
      s.onload = render;
      document.head.appendChild(s);
    } else {
      const iv = setInterval(() => {
        if (window.turnstile) {
          clearInterval(iv);
          render();
        }
      }, 200);
      setTimeout(() => clearInterval(iv), 10000);
    }
    return () => {
      cancelled = true;
    };
  }, [standalone, over]);

  const resetTurnstile = useCallback(() => {
    try {
      window.turnstile?.reset(tsWidgetId.current ?? undefined);
    } catch {
      /* no-op */
    }
    setTsToken('');
  }, []);

  const loadBoard = useCallback(async () => {
    setBoardLoading(true);
    const data = await fetchWebLeaderboard(wid);
    setBoard(data);
    setBoardLoading(false);
  }, [wid]);

  const openBoard = useCallback(() => {
    setBoardOpen(true);
    void loadBoard();
  }, [loadBoard]);

  const onSubmit = useCallback(async () => {
    if (!over || submitState === 'sending') return;
    const nick = nickname.trim() || 'Guest';
    saveNickname(nick);
    setSubmitState('sending');
    setSubmitError('');
    const result = await submitWebScore({
      wid,
      nickname: nick,
      turnstileToken: tsToken,
      score: over.score,
      distance: over.distance,
      duration: over.duration,
      bottlesCollected: over.bottlesCollected,
      watersUsed: over.watersUsed,
      peakCombo: over.peakCombo,
      reason: over.reason,
    });
    resetTurnstile();
    if (result.ok) {
      setSubmitResult(result);
      setSubmitState('done');
      void loadBoard();
    } else {
      setSubmitError(result.error || 'Something went wrong.');
      setSubmitState('error');
    }
  }, [over, submitState, nickname, wid, tsToken, resetTurnstile, loadBoard]);

  const onPlayAgain = useCallback(() => {
    setOver(null);
    setSubmitState('idle');
    setSubmitResult(null);
    setSubmitError('');
    setBoardOpen(false);
    resetTurnstile();
    window.tapeRunner?.restart();
  }, [resetTurnstile]);

  if (!standalone) return null;

  return (
    <>
      {/* Pre-game trophy pill */}
      {!over && !boardOpen && (
        <button
          onClick={openBoard}
          style={{
            position: 'absolute',
            bottom: 16,
            left: 16,
            zIndex: 20,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'rgba(0,0,0,0.55)',
            border: `1px solid ${HAIRLINE}`,
            color: '#fff',
            padding: '8px 14px',
            borderRadius: 100,
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          }}
        >
          <span aria-hidden>{'\u{1F3C6}'}</span> Leaderboard
        </button>
      )}

      {/* Pre-game leaderboard panel */}
      {!over && boardOpen && (
        <Scrim>
          <Card>
            <CardTitle>Leaderboard</CardTitle>
            <Tabs tab={tab} setTab={setTab} />
            <BoardList
              board={board}
              loading={boardLoading}
              tab={tab}
              wid={wid}
            />
            <GhostButton onClick={() => setBoardOpen(false)}>
              Close
            </GhostButton>
          </Card>
        </Scrim>
      )}

      {/* Game-over card */}
      {over && (
        <Scrim>
          <Card>
            <CardTitle>{over.headline || 'GAME OVER'}</CardTitle>
            {over.subtitle ? (
              <p
                style={{
                  margin: '0 0 10px',
                  color: 'rgba(255,255,255,0.65)',
                  fontSize: 13,
                  textAlign: 'center',
                }}
              >
                {over.subtitle}
              </p>
            ) : null}

            <div
              style={{
                textAlign: 'center',
                margin: '6px 0 2px',
                fontSize: 44,
                fontWeight: 800,
                color: ACCENT,
                lineHeight: 1,
              }}
            >
              {Math.round(over.score).toLocaleString()}
            </div>
            <div
              style={{
                textAlign: 'center',
                color: 'rgba(255,255,255,0.55)',
                fontSize: 12,
                marginBottom: 14,
              }}
            >
              {Math.round(over.distance)}m · {over.bottlesCollected}{' '}
              bottles · x{Math.max(1, over.peakCombo)} combo
            </div>

            {submitState !== 'done' && (
              <>
                <input
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  maxLength={24}
                  placeholder="Your name on the board"
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    background: 'rgba(255,255,255,0.06)',
                    border: `1px solid ${HAIRLINE}`,
                    borderRadius: 10,
                    color: '#fff',
                    padding: '11px 12px',
                    fontSize: 14,
                    outline: 'none',
                    marginBottom: 10,
                  }}
                />
                {/* Turnstile mounts here — invisible unless a
                    challenge is required. */}
                <div ref={tsRef} style={{ marginBottom: 4 }} />
                {submitError ? (
                  <p
                    style={{
                      color: '#ff6b5e',
                      fontSize: 12,
                      margin: '0 0 8px',
                      textAlign: 'center',
                    }}
                  >
                    {submitError}
                  </p>
                ) : null}
                <PrimaryButton
                  disabled={!tsToken || submitState === 'sending'}
                  onClick={() => void onSubmit()}
                >
                  {submitState === 'sending'
                    ? 'Submitting…'
                    : !tsToken
                      ? 'Checking…'
                      : 'Join the leaderboard'}
                </PrimaryButton>
              </>
            )}

            {submitState === 'done' && submitResult && (
              <>
                <div
                  style={{
                    textAlign: 'center',
                    margin: '2px 0 10px',
                    fontSize: 14,
                    fontWeight: 700,
                    color: '#fff',
                  }}
                >
                  {submitResult.newAllTimeBest
                    ? 'New personal best! '
                    : ''}
                  #{submitResult.weeklyRank} this week · #
                  {submitResult.allTimeRank} all time
                </div>
                <Tabs tab={tab} setTab={setTab} />
                <BoardList
                  board={board}
                  loading={boardLoading}
                  tab={tab}
                  wid={wid}
                />
              </>
            )}

            <PrimaryButton onClick={onPlayAgain} outline>
              Play again
            </PrimaryButton>
            {submitState !== 'done' && (
              <GhostButton onClick={() => setOver(null)}>
                Skip
              </GhostButton>
            )}
          </Card>
        </Scrim>
      )}
    </>
  );
}

// ── Small presentational helpers (inline styles — the runner page
//    doesn't use the site's Tailwind chrome) ──────────────────────

function Scrim({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.55)',
        padding: 16,
      }}
    >
      {children}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: '100%',
        maxWidth: 380,
        maxHeight: '86vh',
        overflowY: 'auto',
        background: CARD_BG,
        border: `1px solid ${HAIRLINE}`,
        borderRadius: 18,
        padding: '20px 18px 16px',
        boxShadow: '0 18px 60px rgba(0,0,0,0.6)',
      }}
    >
      {children}
    </div>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        margin: '0 0 6px',
        color: '#fff',
        fontSize: 19,
        fontWeight: 800,
        textAlign: 'center',
        letterSpacing: 0.4,
        textTransform: 'uppercase',
      }}
    >
      {children}
    </h2>
  );
}

function Tabs({
  tab,
  setTab,
}: {
  tab: 'weekly' | 'allTime';
  setTab: (t: 'weekly' | 'allTime') => void;
}) {
  const item = (key: 'weekly' | 'allTime', label: string) => (
    <button
      onClick={() => setTab(key)}
      style={{
        flex: 1,
        padding: '8px 0',
        borderRadius: 8,
        border: 'none',
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: 700,
        background: tab === key ? ACCENT : 'transparent',
        color: tab === key ? '#fff' : 'rgba(255,255,255,0.6)',
      }}
    >
      {label}
    </button>
  );
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        background: 'rgba(255,255,255,0.06)',
        borderRadius: 10,
        padding: 3,
        marginBottom: 10,
      }}
    >
      {item('weekly', 'This week')}
      {item('allTime', 'All time')}
    </div>
  );
}

function BoardList({
  board,
  loading,
  tab,
  wid,
}: {
  board: WebLeaderboardData | null;
  loading: boolean;
  tab: 'weekly' | 'allTime';
  wid: string;
}) {
  const empty = (
    <p
      style={{
        color: 'rgba(255,255,255,0.5)',
        fontSize: 13,
        textAlign: 'center',
        margin: '18px 0',
      }}
    >
      {loading ? 'Loading…' : 'No scores yet — be the first!'}
    </p>
  );
  const rows = board ? board[tab] : [];
  if (!rows.length) return empty;
  return (
    <div style={{ marginBottom: 12 }}>
      {rows.map((r, i) => {
        const mine = r.wid === wid;
        return (
          <div
            key={r.wid}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '7px 10px',
              borderRadius: 10,
              background: mine ? 'rgba(184,115,51,0.18)' : 'transparent',
              border: mine
                ? `1px solid rgba(184,115,51,0.5)`
                : '1px solid transparent',
            }}
          >
            <span
              style={{
                width: 24,
                textAlign: 'right',
                color:
                  i === 0
                    ? '#ffd54f'
                    : i === 1
                      ? '#cfd8dc'
                      : i === 2
                        ? '#d7a173'
                        : 'rgba(255,255,255,0.45)',
                fontSize: 13,
                fontWeight: 800,
                flexShrink: 0,
              }}
            >
              {i + 1}
            </span>
            <span style={{ fontSize: 16, flexShrink: 0 }} aria-hidden>
              {flagEmoji(r.countryCode)}
            </span>
            <span
              style={{
                flex: 1,
                color: '#fff',
                fontSize: 13,
                fontWeight: mine ? 800 : 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {r.nickname}
              {mine ? ' (you)' : ''}
            </span>
            <span
              style={{
                color: ACCENT,
                fontSize: 13,
                fontWeight: 800,
                flexShrink: 0,
              }}
            >
              {r.score.toLocaleString()}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
  outline,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  outline?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%',
        padding: '12px 0',
        borderRadius: 12,
        border: outline ? `1px solid ${ACCENT}` : 'none',
        background: outline ? 'transparent' : ACCENT,
        color: outline ? ACCENT : '#fff',
        fontSize: 15,
        fontWeight: 800,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        marginTop: 8,
      }}
    >
      {children}
    </button>
  );
}

function GhostButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        padding: '10px 0',
        borderRadius: 12,
        border: 'none',
        background: 'transparent',
        color: 'rgba(255,255,255,0.55)',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        marginTop: 4,
      }}
    >
      {children}
    </button>
  );
}
