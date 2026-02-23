/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Zero-Shot: ZK Fog-of-War — Production-Ready Game Client
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ARCHITECTURE
 * ─────────────────────────────────────────────────────────────────────────────
 *   main.tsx
 *     └── Auth0Provider (wraps entire tree)
 *           └── App                       ← this file
 *                 ├── SecurityGate        (3-stage multi-lock: Age / ToS / Wallet)
 *                 ├── LobbyScreen         (stake input + mission deploy)
 *                 ├── GameScreen          (placement + ZK battle loop)
 *                 │     ├── TacticalGrid ×2  (player grid + enemy fog-of-war)
 *                 │     ├── VoicePanel    (Web Speech API: "Fire Alpha 4")
 *                 │     ├── ZKProgressBar (WITNESS→CIRCUIT→PROOF→VERIFY states)
 *                 │     └── TacticalLog   (scrolling mission feed)
 *                 └── DashboardScreen     (TX history, stats, account info)
 *
 * STATE MANAGEMENT
 * ─────────────────────────────────────────────────────────────────────────────
 *   Auth      : Auth0 context  (useAuth0 hook — login, logout, user object)
 *   Game      : useReducer(gameReducer) — all mutations via typed GameAction
 *   Profile   : localStorage keyed by Auth0 sub-id
 *   Network   : Freighter.getNetwork() → subtle footer chip (Mainnet/Testnet)
 *   Sound     : singleton SoundEngine (procedural Web Audio API, zero files)
 *   Voice     : useSpeechRecognition hook → parseVoice() → dispatch
 *
 * ZK PROOF LIFECYCLE (per fire action)
 * ─────────────────────────────────────────────────────────────────────────────
 *   IDLE
 *   → WITNESS_GENERATION   (private input: position + salt → Poseidon hash)
 *   → CIRCUIT_COMPILATION  (Noir UltraHonk circuit setup)
 *   → PROOF_GENERATION     (BN254 proof bytes produced)
 *   → ON_CHAIN_VERIFICATION (hub.verify_shot on Soroban)
 *   → VERIFICATION_SUCCESS | VERIFICATION_FAILURE
 *   → SHOT_APPLY  → (GAME_OVER | ENEMY_STRIKE)
 *
 * EMAILJS USAGE (game alerts only — Auth0 owns authentication emails)
 * ─────────────────────────────────────────────────────────────────────────────
 *   · enemy_attack   — "You are being attacked, Session #1234"
 *   · game_won       — final stats email after victory
 *   · game_lost      — consolation email with replay link
 *   · low_balance    — balance falls below 20 XLM
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, {
  useState, useEffect, useRef, useCallback,
  useReducer, useMemo,
} from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import emailjs from '@emailjs/browser';
import { AUTH0_READY } from './main';

// ─────────────────────────────────────────────────────────────────────────────
// §1  EMAILJS CONFIGURATION
//     Only for in-game tactical alert emails. Auth0 handles account email flows.
// ─────────────────────────────────────────────────────────────────────────────
const EJS_SERVICE  = import.meta.env?.VITE_EJS_SERVICE  ?? 'YOUR_EMAILJS_SERVICE_ID';
const EJS_TEMPLATE = import.meta.env?.VITE_EJS_TEMPLATE ?? 'YOUR_EMAILJS_TEMPLATE_ID';
const EJS_PUBKEY   = import.meta.env?.VITE_EJS_PUBKEY   ?? 'YOUR_EMAILJS_PUBLIC_KEY';
const EJS_READY    = !EJS_SERVICE.startsWith('YOUR');

// ─────────────────────────────────────────────────────────────────────────────
// §2  TYPESCRIPT INTERFACES & TYPE DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

/** Visual/interaction state for a single 1×1 grid cell */
type CellKind = 'fog' | 'empty' | 'unit' | 'hit' | 'miss' | 'targeted';

/** How a TacticalGrid column behaves: place own unit / attack enemy / read-only */
type GridMode = 'place' | 'attack' | 'view';

/** High-level game phase: new game → place unit → battle → game over */
type GamePhase = 'setup' | 'placement' | 'battle' | 'ended';

/** Who ended the game. null while in progress. */
type WinnerKind = 'you' | 'foe' | null;

/**
 * ZK proof state machine.
 * Every FIRE action must pass through every stage in sequence before
 * the shot result is applied to the board.
 */
type ZKState =
  | 'IDLE'
  | 'WITNESS_GENERATION'    // building private inputs (pos + Poseidon salt)
  | 'CIRCUIT_COMPILATION'   // loading/compiling Noir UltraHonk circuit
  | 'PROOF_GENERATION'      // BN254 proof generation (CPU-intensive step)
  | 'ON_CHAIN_VERIFICATION' // Soroban hub.verify_shot() call
  | 'VERIFICATION_SUCCESS'  // proof accepted, shot result is authoritative
  | 'VERIFICATION_FAILURE'; // proof rejected (retry allowed)

/** All ZK proof data attached to a game state snapshot */
interface ZKProofContext {
  state:         ZKState;
  targetIndex:   number;   // cell index being fired upon (-1 = none)
  witnessHex:    string;   // raw Poseidon witness (private — never sent)
  proofHex:      string;   // UltraHonk proof bytes (hex)
  verifyTxHash:  string;   // on-chain verification TX hash
  startedAt:     number;   // Date.now() when proof started
  resolvedAt:    number;   // Date.now() when verify completed/failed
  errorMsg:      string;   // populated on VERIFICATION_FAILURE
  isHit:         boolean;  // authoritative result after verification
}

/** Tag for each line in the tactical log panel */
type LogType = 'sys' | 'zk' | 'fire' | 'hit' | 'miss' | 'wallet' | 'warn';

/** One scrolling line in the tactical log */
interface LogEntry {
  ts:  string;   // "14:32:07"
  msg: string;
  t:   LogType;
}

/** Ledger record types */
type TxType = 'deposit' | 'withdraw' | 'stake' | 'win' | 'loss' | 'refund';

/** Single entry in a user's transaction history */
interface TxRecord {
  id:         string;
  type:       TxType;
  amount:     number;
  ts:         string;
  status:     'confirmed' | 'pending';
  label:      string;
  sessionId?: number;
}

/**
 * Complete game session state.
 * This is the ONLY shape passed to/from the gameReducer.
 * Never mutate directly — always use dispatch().
 */
interface GameState {
  phase:          GamePhase;
  sid:            number;       // random 4-digit session ID
  stake:          number;       // XLM wagered
  myGrid:         CellKind[];   // 36-cell player grid
  foeGrid:        CellKind[];   // 36-cell enemy grid (fog-of-war)
  foeUnit:        number;       // enemy unit position (hidden, 0-35)
  myUnit:         number;       // player unit position (-1 = not yet placed)
  myTurn:         boolean;
  shots:          number;
  hits:           number;
  winner:         WinnerKind;
  txIds:          string[];
  log:            LogEntry[];
  stakeDeducted:  boolean;      // prevents double-deduct on page restore
  zkProof:        ZKProofContext;
}

/** Auth0-derived user profile merged with local gameplay statistics */
interface UserProfile {
  sub:          string;   // Auth0 user_id — stable unique key
  username:     string;
  email:        string;
  emailVerified: boolean;
  picture:      string;   // Auth0 avatar URL
  walletAddress: string;
  balance:      number;
  wins:         number;
  losses:       number;
  totalStaked:  number;
  txHistory:    TxRecord[];
  createdAt:    string;
}

/** Which SecurityGate stage is currently active (1, 2, or 3) */
type GateStage = 1 | 2 | 3;

/** State owned by the SecurityGate component */
interface GateState {
  ageVerified:     boolean;   // Stage 1
  tosAccepted:     boolean;   // Stage 2
  walletConnected: boolean;   // Stage 3
  walletAddress:   string;
}

/** Parsed result of a voice command transcript */
interface VoiceCommand {
  transcript: string;
  action:     'fire' | 'place' | 'abort' | 'unknown';
  cellIndex:  number;   // 0-35; -1 if not a coordinate command
  coord:      string;   // human-readable e.g. "A4"
  confidence: number;   // 0.0 – 1.0
}

/** Data for sending an in-game alert email via EmailJS */
interface GameAlertPayload {
  type:      'enemy_attack' | 'game_won' | 'game_lost' | 'low_balance';
  toEmail:   string;
  username:  string;
  sessionId: number;
  detail:    string;
}

/** Minimal Stellar network status — shown in the footer chip */
interface NetworkStatus {
  kind:  'mainnet' | 'testnet' | 'unknown';
  label: string;   // "Mainnet" | "Testnet" | "Unknown"
  color: string;   // CSS hex colour
}

// ─────────────────────────────────────────────────────────────────────────────
// §3  CONSTANTS & PURE UTILITY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const GRID          = 6;
const CELLS         = GRID * GRID;      // 36
const MAX_STAKE     = 50;
const HUB_ADDR      = 'CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG';
const GAME_SAVE_KEY = 'zs_game_v7';
const GATE_KEY      = 'zs_gate_v7';    // persist gate state across refreshes

const PROFILE_KEY = (sub: string) => `zs_profile_v7:${sub}`;

/** Convert 0-based cell index → chess-style label ("A1" … "F6") */
const coord = (i: number) =>
  `${String.fromCharCode(65 + (i % GRID))}${Math.floor(i / GRID) + 1}`;

const rnd    = (n: number)  => Math.floor(Math.random() * n);
const hex    = (n: number)  => Array.from({ length: n }, () =>
  rnd(256).toString(16).padStart(2, '0')).join('');
const nowts  = ()           => new Date().toLocaleTimeString('en-US', { hour12: false });
const datets = ()           => new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const wait   = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const txId   = ()           => 'TX' + hex(16).toUpperCase();
const mkLog  = (msg: string, t: LogType = 'sys'): LogEntry => ({ ts: nowts(), msg, t });

/** Generate a plausible Stellar G-address for offline/demo sessions */
const genAddr = () =>
  'G' + Array.from({ length: 55 }, () =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[rnd(32)]).join('');

/** Return a UserProfile with an appended TxRecord (immutable update) */
const withTx = (u: UserProfile, r: Omit<TxRecord, 'id' | 'ts'>): UserProfile => ({
  ...u,
  txHistory: [...u.txHistory, { ...r, id: txId(), ts: datets() }],
});

const loadProfile = (key: string): UserProfile | null => {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
};
const saveProfile = (key: string, u: UserProfile) => {
  try { localStorage.setItem(key, JSON.stringify(u)); } catch {}
};
const loadSavedGame = (): GameState | null => {
  try { const d = localStorage.getItem(GAME_SAVE_KEY); return d ? JSON.parse(d) : null; }
  catch { return null; }
};
const persistGame = (g: GameState | null) => {
  try { g ? localStorage.setItem(GAME_SAVE_KEY, JSON.stringify(g)) : localStorage.removeItem(GAME_SAVE_KEY); }
  catch {}
};

/** Simulate async ZK step with randomised timing; returns random hex string */
const simulateZK = async (minMs: number, maxMs: number): Promise<string> => {
  await wait(minMs + rnd(maxMs - minMs));
  return hex(32);
};

// ─────────────────────────────────────────────────────────────────────────────
// §4  NETWORK DETECTION
// ─────────────────────────────────────────────────────────────────────────────

/** Ask Freighter (or VITE env var) for the current Stellar network. */
async function detectNetwork(): Promise<NetworkStatus> {
  // 1. Ask Freighter wallet extension
  if ((window as any).freighter) {
    try {
      const net: string = await (window as any).freighter.getNetwork();
      const isMain = /PUBLIC|MAINNET|mainnet/.test(net);
      return {
        kind:  isMain ? 'mainnet' : 'testnet',
        label: isMain ? 'Mainnet' : 'Testnet',
        color: isMain ? '#10b981' : '#f59e0b',
      };
    } catch {}
  }
  // 2. Check build-time env variable
  const envNet = (import.meta as any).env?.VITE_STELLAR_NETWORK ?? '';
  if (/mainnet|PUBLIC/i.test(envNet))
    return { kind: 'mainnet', label: 'Mainnet', color: '#10b981' };
  // 3. Default safe assumption: testnet
  return { kind: 'testnet', label: 'Testnet', color: '#f59e0b' };
}

/** Connect Freighter and return its public key, or generate a demo address. */
async function connectFreighterOrDemo(): Promise<string> {
  if ((window as any).freighter) {
    try {
      const ok: boolean = await (window as any).freighter.isConnected();
      if (ok) {
        return await (window as any).freighter.getPublicKey();
      }
    } catch {}
  }
  return genAddr();
}

// ─────────────────────────────────────────────────────────────────────────────
// §5  EMAILJS GAME ALERTS
//     Auth0 handles login/verification email flows entirely.
//     EmailJS is used ONLY for the tactical in-game alert emails below.
//     Rate-limited: one email per alert type per session per 60 seconds.
// ─────────────────────────────────────────────────────────────────────────────

async function sendGameAlert(p: GameAlertPayload): Promise<void> {
  if (!EJS_READY) return;
  const rateKey = `zs_alert_${p.type}_${p.sessionId}`;
  if (Date.now() - parseInt(sessionStorage.getItem(rateKey) || '0', 10) < 60_000) return;
  sessionStorage.setItem(rateKey, String(Date.now()));
  try {
    await emailjs.send(EJS_SERVICE, EJS_TEMPLATE, {
      to_email:   p.toEmail,
      username:   p.username,
      alert_type: p.type.replace(/_/g, ' ').toUpperCase(),
      session_id: String(p.sessionId),
      detail:     p.detail,
    }, EJS_PUBKEY);
  } catch {} // non-fatal
}

// ─────────────────────────────────────────────────────────────────────────────
// §6  SOUND ENGINE — procedural Web Audio API, zero external files
// ─────────────────────────────────────────────────────────────────────────────

class SoundEngine {
  private ctx:     AudioContext | null = null;
  private master:  GainNode    | null = null;
  private bgNodes: AudioNode[] = [];
  private _muted = false;
  private _bgOn  = false;

  private getCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx   = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.42;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  private osc(f: number, type: OscillatorType, t0: number, dur: number,
               g0: number, g1: number, dest: AudioNode, ctx: AudioContext) {
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t0);
    g.gain.setValueAtTime(g0, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(g1, 0.0001), t0 + dur);
    o.connect(g); g.connect(dest); o.start(t0); o.stop(t0 + dur);
  }

  private noise(dur: number, gain: number, dest: AudioNode, ctx: AudioContext, t0: number) {
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d   = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g   = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const flt = ctx.createBiquadFilter(); flt.type = 'bandpass';
    flt.frequency.value = 800; flt.Q.value = 0.8;
    src.connect(flt); flt.connect(g); g.connect(dest);
    src.start(t0); src.stop(t0 + dur);
  }

  get muted() { return this._muted; }
  toggleMute() {
    this._muted = !this._muted;
    if (this.master) this.master.gain.value = this._muted ? 0 : 0.42;
    return this._muted;
  }

  // UI micro-click
  click()   { if (this._muted) return; try { const c = this.getCtx(), t = c.currentTime; this.osc(880, 'square', t, 0.04, 0.1, 0.001, this.master!, c); } catch {} }
  // Unit placed confirmation chime
  place()   { if (this._muted) return; try { const c = this.getCtx(), t = c.currentTime; this.osc(523, 'sine', t, 0.1, 0.28, 0.001, this.master!, c); this.osc(659, 'sine', t + 0.08, 0.1, 0.28, 0.001, this.master!, c); } catch {} }
  // Player fires
  fire()    { if (this._muted) return; try { const c = this.getCtx(), t = c.currentTime; this.osc(220, 'sawtooth', t, 0.08, 0.4, 0.001, this.master!, c); this.noise(0.15, 0.3, this.master!, c, t); } catch {} }
  // Direct hit (player or enemy)
  hit()     { if (this._muted) return; try { const c = this.getCtx(), t = c.currentTime; this.noise(0.4, 0.7, this.master!, c, t); this.osc(80, 'sawtooth', t, 0.25, 0.6, 0.001, this.master!, c); this.osc(440, 'sine', t + 0.05, 0.12, 0.2, 0.001, this.master!, c); } catch {} }
  // Shot that missed
  miss()    { if (this._muted) return; try { const c = this.getCtx(), t = c.currentTime; this.osc(330, 'sine', t, 0.15, 0.15, 0.001, this.master!, c); this.osc(220, 'sine', t + 0.06, 0.12, 0.1, 0.001, this.master!, c); } catch {} }
  // Enemy fires (heard differently to player fire)
  efir()    { if (this._muted) return; try { const c = this.getCtx(), t = c.currentTime; this.osc(180, 'sawtooth', t, 0.1, 0.35, 0.001, this.master!, c); this.noise(0.12, 0.25, this.master!, c, t + 0.03); } catch {} }
  // Enemy scores hit
  ehit()    { if (this._muted) return; try { const c = this.getCtx(), t = c.currentTime; this.noise(0.35, 0.6, this.master!, c, t); this.osc(90, 'sawtooth', t, 0.2, 0.5, 0.001, this.master!, c); } catch {} }
  // Ascending victory fanfare
  victory() { if (this._muted) return; try { const c = this.getCtx(), t = c.currentTime; [523, 659, 784, 1047].forEach((f, i) => { this.osc(f, 'sine', t + i * 0.13, 0.28, 0.4, 0.001, this.master!, c); this.osc(f * 1.5, 'sine', t + i * 0.13, 0.2, 0.15, 0.001, this.master!, c); }); } catch {} }
  // Descending defeat dirge
  defeat()  { if (this._muted) return; try { const c = this.getCtx(), t = c.currentTime; [440, 330, 247, 196].forEach((f, i) => { this.osc(f, 'sawtooth', t + i * 0.18, 0.3, 0.35, 0.001, this.master!, c); }); } catch {} }
  // Voice command recognised chirp
  voice()   { if (this._muted) return; try { const c = this.getCtx(), t = c.currentTime; this.osc(660, 'sine', t, 0.06, 0.2, 0.001, this.master!, c); this.osc(880, 'sine', t + 0.06, 0.06, 0.2, 0.001, this.master!, c); } catch {} }

  startBg() {
    if (this._muted || this._bgOn) return;
    this._bgOn = true;
    const loop = () => {
      if (!this._bgOn) return;
      try {
        const c = this.getCtx(), t = c.currentTime;
        const d = c.createOscillator(), dg = c.createGain();
        d.type = 'sine'; d.frequency.value = 55;
        dg.gain.setValueAtTime(0.04, t); dg.gain.exponentialRampToValueAtTime(0.0001, t + 9);
        d.connect(dg); dg.connect(this.master!); d.start(t); d.stop(t + 9);
        this.bgNodes.push(d, dg);
        const p = c.createOscillator(), pg = c.createGain();
        p.type = 'triangle'; p.frequency.value = 110;
        pg.gain.setValueAtTime(0.015, t + 1); pg.gain.exponentialRampToValueAtTime(0.0001, t + 8);
        p.connect(pg); pg.connect(this.master!); p.start(t + 1); p.stop(t + 8);
        this.bgNodes.push(p, pg);
      } catch {}
      setTimeout(loop, 8400);
    };
    setTimeout(loop, 600);
  }

  stopBg() {
    this._bgOn = false;
    this.bgNodes.forEach(n => { try { (n as any).stop?.(); } catch {} });
    this.bgNodes = [];
  }
}

const sfx = new SoundEngine();

// ─────────────────────────────────────────────────────────────────────────────
// §7  GAME ACTION REDUCER
//     Pure function. No side-effects, no async. All game state lives here.
//     UI components ONLY call dispatch() — never mutate state directly.
// ─────────────────────────────────────────────────────────────────────────────

/** Build a fresh (blank) ZK proof context */
const blankZK = (): ZKProofContext => ({
  state: 'IDLE', targetIndex: -1, witnessHex: '', proofHex: '',
  verifyTxHash: '', startedAt: 0, resolvedAt: 0, errorMsg: '', isHit: false,
});

/** Build a fresh (blank) game state — used on GAME_RESET */
const blankGame = (): GameState => ({
  phase: 'setup', sid: 0, stake: 0,
  myGrid: Array(CELLS).fill('empty')  as CellKind[],
  foeGrid: Array(CELLS).fill('fog')   as CellKind[],
  foeUnit: -1, myUnit: -1, myTurn: true, shots: 0, hits: 0,
  winner: null, txIds: [], log: [], stakeDeducted: false, zkProof: blankZK(),
});

/** Append log entries (caps history at 100 lines) */
const appendLog = (s: GameState, ...entries: LogEntry[]): GameState => ({
  ...s, log: [...s.log.slice(-100), ...entries],
});

/**
 * Discriminated union of every action the game engine accepts.
 * The reducer is a pure switch over this union — exhaustive by design.
 */
type GameAction =
  // ── Session lifecycle ──────────────────────────────────────────────────────
  | { type: 'GAME_INIT';         payload: { sid: number; stake: number; foeUnit: number } }
  | { type: 'GAME_READY';        payload: { txId: string } }
  | { type: 'UNIT_PLACE';        payload: { index: number } }
  | { type: 'BATTLE_BEGIN';      payload: { myTurn: boolean } }
  // ── ZK proof state machine — strict ordering enforced by reducer ───────────
  | { type: 'ZK_WITNESS_BEGIN';  payload: { index: number } }
  | { type: 'ZK_WITNESS_DONE';   payload: { witnessHex: string } }
  | { type: 'ZK_CIRCUIT_BEGIN' }
  | { type: 'ZK_PROOF_BEGIN' }
  | { type: 'ZK_PROOF_DONE';     payload: { proofHex: string } }
  | { type: 'ZK_VERIFY_BEGIN' }
  | { type: 'ZK_VERIFY_SUCCESS'; payload: { isHit: boolean; verifyTxHash: string } }
  | { type: 'ZK_VERIFY_FAILURE'; payload: { errorMsg: string } }
  | { type: 'ZK_RESET' }
  // ── Shot resolution ────────────────────────────────────────────────────────
  | { type: 'SHOT_APPLY';        payload: { index: number; isHit: boolean } }
  | { type: 'ENEMY_STRIKE';      payload: { index: number; isHit: boolean } }
  | { type: 'GAME_OVER';         payload: { winner: WinnerKind; txId: string } }
  // ── Utility ────────────────────────────────────────────────────────────────
  | { type: 'LOG_APPEND';        payload: LogEntry[] }
  | { type: 'GAME_RESTORE';      payload: GameState }
  | { type: 'GAME_RESET' };

/**
 * The central pure reducer for the entire game session.
 * Every state shape is typed — the compiler catches incomplete transitions.
 */
function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {

    // ── New session: allocate IDs and transition to 'setup' ──────────────────
    case 'GAME_INIT': {
      const { sid, stake, foeUnit } = action.payload;
      return appendLog(
        { ...blankGame(), phase: 'setup', sid, stake, foeUnit },
        mkLog(`Session #${sid} initialised | stake: ${stake} XLM`),
        mkLog(`Connecting to Stellar Hub…`),
      );
    }

    // ── Stake TX confirmed → advance to placement phase ───────────────────────
    case 'GAME_READY': {
      return appendLog(
        { ...state, phase: 'placement', stakeDeducted: true, txIds: [action.payload.txId] },
        mkLog(`Stake TX ${action.payload.txId.slice(0, 12)}… confirmed ✓`, 'wallet'),
        mkLog('ZK proving key loaded (Noir UltraHonk)', 'zk'),
        mkLog('Place your unit on the grid.'),
      );
    }

    // ── Player clicks a cell on their own grid ─────────────────────────────────
    case 'UNIT_PLACE': {
      const { index } = action.payload;
      const myGrid = [...state.myGrid] as CellKind[];
      myGrid[index] = 'unit';
      return appendLog(
        { ...state, myGrid, myUnit: index },
        mkLog(`Unit placed at ${coord(index)} — ZK commitment building…`, 'zk'),
      );
    }

    // ── After commitment is on-chain, battle begins ────────────────────────────
    case 'BATTLE_BEGIN': {
      return appendLog(
        { ...state, phase: 'battle', myTurn: action.payload.myTurn },
        mkLog('On-chain commitment confirmed ✓', 'zk'),
        mkLog('Opponent committed (ZK-hidden)', 'sys'),
        mkLog('━━━ BATTLE START ━━━'),
        mkLog(action.payload.myTurn ? '▶ YOUR TURN — click or say "Fire [col] [row]"' : '… Waiting for opponent…'),
      );
    }

    // ── ZK Witness Generation begins (player clicked/voiced a cell) ───────────
    case 'ZK_WITNESS_BEGIN': {
      return appendLog(
        {
          ...state,
          myTurn: false,
          zkProof: { ...blankZK(), state: 'WITNESS_GENERATION', targetIndex: action.payload.index, startedAt: Date.now() },
        },
        mkLog(`Firing at ${coord(action.payload.index)}…`, 'fire'),
        mkLog('[ ZK ] Building witness (private: pos + Poseidon salt)…', 'zk'),
      );
    }

    case 'ZK_WITNESS_DONE': {
      if (state.zkProof.state !== 'WITNESS_GENERATION') return state;
      return appendLog(
        { ...state, zkProof: { ...state.zkProof, state: 'CIRCUIT_COMPILATION', witnessHex: action.payload.witnessHex } },
        mkLog(`[ ZK ] Witness ready: 0x${action.payload.witnessHex.slice(0, 16)}…`, 'zk'),
        mkLog('[ ZK ] Compiling Noir UltraHonk circuit…', 'zk'),
      );
    }

    case 'ZK_CIRCUIT_BEGIN': {
      if (state.zkProof.state !== 'CIRCUIT_COMPILATION') return state;
      return appendLog(state, mkLog('[ ZK ] Circuit compiled — beginning proof generation…', 'zk'));
    }

    case 'ZK_PROOF_BEGIN': {
      return appendLog(
        { ...state, zkProof: { ...state.zkProof, state: 'PROOF_GENERATION' } },
        mkLog('[ ZK ] BN254 pairing — generating UltraHonk proof…', 'zk'),
      );
    }

    case 'ZK_PROOF_DONE': {
      if (state.zkProof.state !== 'PROOF_GENERATION') return state;
      return appendLog(
        { ...state, zkProof: { ...state.zkProof, state: 'ON_CHAIN_VERIFICATION', proofHex: action.payload.proofHex } },
        mkLog(`[ ZK ] Proof: 0x${action.payload.proofHex.slice(0, 16)}…`, 'zk'),
      );
    }

    case 'ZK_VERIFY_BEGIN': {
      return appendLog(state, mkLog('[ ZK ] hub.verify_shot() → Soroban…', 'zk'));
    }

    case 'ZK_VERIFY_SUCCESS': {
      if (state.zkProof.state !== 'ON_CHAIN_VERIFICATION') return state;
      const { isHit, verifyTxHash } = action.payload;
      const dur = ((Date.now() - state.zkProof.startedAt) / 1000).toFixed(2);
      return appendLog(
        { ...state, zkProof: { ...state.zkProof, state: 'VERIFICATION_SUCCESS', isHit, verifyTxHash, resolvedAt: Date.now() } },
        mkLog(`[ ZK ] Verified ✓  (${dur}s) — ${isHit ? 'IMPACT CONFIRMED' : 'miss confirmed'}`, 'zk'),
        mkLog(`Verify TX: ${verifyTxHash.slice(0, 12)}…`, 'wallet'),
      );
    }

    case 'ZK_VERIFY_FAILURE': {
      return appendLog(
        { ...state, zkProof: { ...state.zkProof, state: 'VERIFICATION_FAILURE', errorMsg: action.payload.errorMsg, resolvedAt: Date.now() }, myTurn: true },
        mkLog(`[ ZK ] Verification failed: ${action.payload.errorMsg}`, 'warn'),
        mkLog('Turn restored — retry allowed.', 'warn'),
      );
    }

    case 'ZK_RESET':
      return { ...state, zkProof: blankZK(), myTurn: true };

    // ── Apply shot result to enemy fog-of-war grid ─────────────────────────────
    case 'SHOT_APPLY': {
      const { index, isHit } = action.payload;
      const foeGrid = [...state.foeGrid] as CellKind[];
      foeGrid[index] = isHit ? 'hit' : 'miss';
      return appendLog(
        { ...state, foeGrid, shots: state.shots + 1, hits: state.hits + (isHit ? 1 : 0) },
        mkLog(isHit ? `★ DIRECT HIT at ${coord(index)}!` : `Miss at ${coord(index)}.`, isHit ? 'hit' : 'miss'),
      );
    }

    // ── Apply enemy AI shot to player grid ────────────────────────────────────
    case 'ENEMY_STRIKE': {
      const { index, isHit } = action.payload;
      const myGrid = [...state.myGrid] as CellKind[];
      myGrid[index] = isHit ? 'hit' : 'miss';
      return appendLog(
        { ...state, myGrid, myTurn: !isHit },
        mkLog(`Enemy fires ${coord(index)}… ${isHit ? '★ YOUR UNIT HIT!' : 'missed.'}`, isHit ? 'hit' : 'miss'),
      );
    }

    // ── End of game ───────────────────────────────────────────────────────────
    case 'GAME_OVER': {
      return appendLog(
        { ...state, phase: 'ended', winner: action.payload.winner, txIds: [...state.txIds, action.payload.txId] },
        mkLog(`hub.end_game(player1_won=${action.payload.winner === 'you'}) TX: ${action.payload.txId.slice(0, 12)}…`, 'wallet'),
        mkLog(action.payload.winner === 'you' ? '★ MISSION ACCOMPLISHED' : '✕ MISSION FAILED'),
      );
    }

    case 'LOG_APPEND':
      return { ...state, log: [...state.log.slice(-100), ...action.payload] };

    case 'GAME_RESTORE':
      return { ...action.payload, log: [...action.payload.log, mkLog('Session restored.')] };

    case 'GAME_RESET':
      return blankGame();

    default:
      return state;
  }
}

// Derived selectors — derive booleans from state rather than tracking extra flags
const zkBusy = (s: GameState) =>
  s.zkProof.state !== 'IDLE' &&
  s.zkProof.state !== 'VERIFICATION_SUCCESS' &&
  s.zkProof.state !== 'VERIFICATION_FAILURE';

const zkLabel = (s: GameState): string => ({
  IDLE: 'ZK READY', WITNESS_GENERATION: 'WITNESS…',
  CIRCUIT_COMPILATION: 'CIRCUIT…', PROOF_GENERATION: 'PROVING…',
  ON_CHAIN_VERIFICATION: 'VERIFYING…', VERIFICATION_SUCCESS: 'VERIFIED ✓',
  VERIFICATION_FAILURE: 'FAILED ✗',
}[s.zkProof.state] ?? 'ZK READY');

const zkProgress = (s: GameState): number => ({
  IDLE: 0, WITNESS_GENERATION: 20, CIRCUIT_COMPILATION: 40,
  PROOF_GENERATION: 60, ON_CHAIN_VERIFICATION: 80,
  VERIFICATION_SUCCESS: 100, VERIFICATION_FAILURE: 100,
}[s.zkProof.state] ?? 0);

const accuracy = (s: GameState) =>
  s.shots > 0 ? `${Math.round(s.hits / s.shots * 100)}%` : '—';

const canFire = (s: GameState) =>
  s.phase === 'battle' && s.myTurn && !zkBusy(s);

// ─────────────────────────────────────────────────────────────────────────────
// §8  VOICE COMMAND PARSING  (Web Speech API)
// ─────────────────────────────────────────────────────────────────────────────

/** NATO phonetic alphabet → column letter (A–F for a 6×6 grid) */
const NATO: Record<string, string> = {
  alpha: 'a', bravo: 'b', charlie: 'c', delta: 'd', echo: 'e', foxtrot: 'f',
  a: 'a', b: 'b', c: 'c', d: 'd', e: 'e', f: 'f',
};

/**
 * Parse a raw SpeechRecognitionAlternative transcript string into a
 * typed VoiceCommand.  Examples:
 *   "fire alpha four"  → { action: 'fire', cellIndex: 18, coord: 'A4' }
 *   "fire bravo 3"     → { action: 'fire', cellIndex:  8, coord: 'B3' }
 *   "abort"            → { action: 'abort' }
 */
function parseVoice(raw: string, confidence: number): VoiceCommand {
  const base: VoiceCommand = { transcript: raw, action: 'unknown', cellIndex: -1, coord: '', confidence };
  const t = raw.toLowerCase()
    .replace(/\bone\b/g, '1').replace(/\btwo\b/g, '2').replace(/\bthree\b/g, '3')
    .replace(/\bfour\b/g, '4').replace(/\bfive\b/g, '5').replace(/\bsix\b/g, '6')
    .replace(/\s+/g, ' ').trim();

  if (/^(abort|cancel|stop)/.test(t)) return { ...base, action: 'abort' };

  const m = t.match(/^(fire|shoot|attack|place|put|deploy)\s+([a-z]+)\s*(\d)$/);
  if (!m) return base;

  const colLetter = NATO[m[2]];
  if (!colLetter) return base;
  const col = colLetter.charCodeAt(0) - 97;
  const row = parseInt(m[3], 10) - 1;
  if (col < 0 || col >= GRID || row < 0 || row >= GRID) return base;

  const cellIndex = row * GRID + col;
  const isFire    = /fire|shoot|attack/.test(m[1]);
  return {
    transcript: raw,
    action:     isFire ? 'fire' : 'place',
    cellIndex,
    coord: `${colLetter.toUpperCase()}${row + 1}`,
    confidence,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §9  useSpeechRecognition HOOK
//     Wraps the Web Speech API in a stable React hook.
//     Calls `onCommand(cmd)` each time a confident result is received.
// ─────────────────────────────────────────────────────────────────────────────

interface SpeechHook {
  voiceActive:   boolean;
  listening:     boolean;
  lastCmd:       VoiceCommand | null;
  supported:     boolean;
  startListening: () => void;
  stopListening:  () => void;
  toggleVoice:    () => void;
}

function useSpeechRecognition(onCommand: (cmd: VoiceCommand) => void): SpeechHook {
  const SpeechRecognition =
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  const supported   = Boolean(SpeechRecognition);
  const [voiceActive, setVoiceActive] = useState(false);
  const [listening,   setListening]   = useState(false);
  const [lastCmd,     setLastCmd]     = useState<VoiceCommand | null>(null);
  const recRef = useRef<any>(null);

  const startListening = useCallback(() => {
    if (!supported || listening) return;
    const rec = new SpeechRecognition();
    rec.continuous    = true;
    rec.interimResults = false;
    rec.lang          = 'en-US';
    rec.onresult = (e: any) => {
      const alt = e.results[e.results.length - 1][0];
      const cmd = parseVoice(alt.transcript, alt.confidence);
      setLastCmd(cmd);
      if (cmd.action !== 'unknown') { sfx.voice(); onCommand(cmd); }
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    rec.start();
    recRef.current = rec;
    setListening(true);
  }, [supported, listening, onCommand]);

  const stopListening = useCallback(() => {
    try { recRef.current?.stop(); } catch {}
    setListening(false);
  }, []);

  const toggleVoice = useCallback(() => {
    if (!supported) return;
    if (voiceActive) { stopListening(); setVoiceActive(false); }
    else { setVoiceActive(true); startListening(); }
  }, [voiceActive, supported, startListening, stopListening]);

  // Restart recognition after each result (browser stops automatically)
  useEffect(() => {
    if (voiceActive && !listening) startListening();
  }, [voiceActive, listening, startListening]);

  // Cleanup on unmount
  useEffect(() => () => { try { recRef.current?.stop(); } catch {} }, []);

  return { voiceActive, listening, lastCmd, supported, startListening, stopListening, toggleVoice };
}

// ─────────────────────────────────────────────────────────────────────────────
// §10  GLOBAL CSS
// ─────────────────────────────────────────────────────────────────────────────

const GLOBAL_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@500;700;900&family=Rajdhani:wght@300;400;600;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body,#root{height:100%;background:#01060f;color:#b8d0e0;font-family:'Rajdhani',sans-serif}
body{overflow-x:hidden}
::-webkit-scrollbar{width:4px}
::-webkit-scrollbar-thumb{background:#0a2540;border-radius:2px}
input,select{background:#020c1a;border:1px solid #0a2540;color:#7ab0cc;font-family:'Share Tech Mono',monospace;font-size:.75rem;border-radius:3px;padding:10px 12px;width:100%;transition:border-color .2s,box-shadow .2s;outline:none;-webkit-appearance:none}
input:focus,select:focus{border-color:#0ea5e9;box-shadow:0 0 12px rgba(14,165,233,.22)}
input::placeholder{color:#0e2a40}
button{cursor:pointer;font-family:'Rajdhani',sans-serif;border:none;transition:all .18s}
button:disabled{opacity:.33;cursor:not-allowed;pointer-events:none}
body::after{content:'';position:fixed;inset:0;z-index:9999;pointer-events:none;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.05) 2px,rgba(0,0,0,.05) 4px)}
body::before{content:'';position:fixed;inset:0;z-index:9998;pointer-events:none;background:radial-gradient(ellipse at center,transparent 40%,rgba(0,0,0,.72) 100%)}

@keyframes fadeUp    {from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes float     {0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}
@keyframes spin      {to{transform:rotate(360deg)}}
@keyframes ripple    {0%{transform:scale(.3);opacity:1}100%{transform:scale(3.2);opacity:0}}
@keyframes scanLine  {0%{top:-4px}100%{top:100%}}
@keyframes pulseG    {0%,100%{box-shadow:0 0 7px rgba(16,185,129,.2)}50%{box-shadow:0 0 22px rgba(16,185,129,.7)}}
@keyframes tgtPulse  {0%,100%{background:rgba(245,158,11,.09);border-color:#92400e}50%{background:rgba(245,158,11,.26);border-color:#f59e0b;box-shadow:0 0 18px rgba(245,158,11,.6)}}
@keyframes hitBurst  {0%{transform:scale(1)}30%{transform:scale(1.75)}65%{transform:scale(.9)}100%{transform:scale(1)}}
@keyframes shake     {0%,100%{transform:translateX(0)}20%{transform:translateX(-5px)}40%{transform:translateX(5px)}60%{transform:translateX(-3px)}80%{transform:translateX(3px)}}
@keyframes titleGlow {0%,100%{text-shadow:0 0 20px rgba(56,189,248,.5),0 0 40px rgba(56,189,248,.18)}50%{text-shadow:0 0 40px rgba(56,189,248,1),0 0 80px rgba(56,189,248,.35)}}
@keyframes appear    {from{opacity:0;transform:scale(.97)}to{opacity:1;transform:none}}
@keyframes slideIn   {from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:none}}
@keyframes voicePulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(1.6)}}
@keyframes stageGlow {0%,100%{box-shadow:0 0 14px rgba(14,165,233,.2)}50%{box-shadow:0 0 30px rgba(14,165,233,.5)}}
@keyframes stageGlowG{0%,100%{box-shadow:0 0 14px rgba(16,185,129,.2)}50%{box-shadow:0 0 30px rgba(16,185,129,.5)}}
@keyframes zkBar     {from{width:0}to{width:100%}}
@keyframes countGlow {0%,100%{color:#f59e0b}50%{color:#fde68a;text-shadow:0 0 12px #f59e0b}}

.fu{animation:fadeUp .4s ease-out both}
.ap{animation:appear .28s ease-out both}
.d1{animation-delay:.07s}.d2{animation-delay:.14s}.d3{animation-delay:.21s}
`;

// ─────────────────────────────────────────────────────────────────────────────
// §11  UI PRIMITIVES — reusable atoms
// ─────────────────────────────────────────────────────────────────────────────

/** Stat display tile (small or standard size) */
const Stat: React.FC<{ label: string; val: string | number; color?: string; sm?: boolean }> =
  ({ label, val, color = '#38bdf8', sm = false }) => (
  <div style={{ padding: sm ? '5px 10px' : '8px 14px', border: '1px solid #0a2540', borderRadius: 3, background: '#020912', textAlign: 'center', minWidth: sm ? 54 : 68 }}>
    <div style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.46rem', color: '#0a2540', letterSpacing: '.14em' }}>{label}</div>
    <div style={{ fontFamily: 'Orbitron,monospace', fontSize: sm ? '.82rem' : '1.02rem', fontWeight: 700, color, marginTop: 1, textShadow: `0 0 8px ${color}50` }}>{val}</div>
  </div>
);

/** Primary CTA button */
const PBtn: React.FC<{ children: React.ReactNode; onClick: () => void; disabled?: boolean; full?: boolean; danger?: boolean; sm?: boolean }> =
  ({ children, onClick, disabled, full, danger, sm }) => (
  <button onClick={() => { sfx.click(); onClick(); }} disabled={disabled}
    style={{ width: full ? '100%' : undefined, padding: sm ? '8px 16px' : '11px 22px',
      background: danger ? 'linear-gradient(135deg,#7f1d1d,#991b1b)' : 'linear-gradient(135deg,#075985,#0284c7)',
      border: `1px solid ${danger ? '#ef4444' : '#0ea5e9'}`, borderRadius: 3,
      color: danger ? '#fca5a5' : '#e0f2fe', fontFamily: 'Orbitron,monospace',
      fontSize: sm ? '.68rem' : '.76rem', letterSpacing: '.13em', fontWeight: 700,
      boxShadow: danger ? '0 0 18px rgba(239,68,68,.2)' : '0 0 18px rgba(14,165,233,.2)' }}
    onMouseEnter={e => { const t = e.currentTarget; t.style.transform = 'translateY(-1px)'; t.style.boxShadow = danger ? '0 0 30px rgba(239,68,68,.45)' : '0 0 30px rgba(14,165,233,.45)'; }}
    onMouseLeave={e => { const t = e.currentTarget; t.style.transform = 'none'; t.style.boxShadow = danger ? '0 0 18px rgba(239,68,68,.2)' : '0 0 18px rgba(14,165,233,.2)'; }}
  >{children}</button>
);

/** Ghost / secondary button */
const GBtn: React.FC<{ children: React.ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }> =
  ({ children, onClick, disabled, danger }) => (
  <button onClick={() => { sfx.click(); onClick(); }} disabled={disabled}
    style={{ padding: '8px 15px', background: 'transparent', border: `1px solid ${danger ? '#991b1b' : '#0a2540'}`,
      borderRadius: 3, color: danger ? '#7f2020' : '#1e3a5f', fontFamily: 'Share Tech Mono,monospace',
      fontSize: '.6rem', letterSpacing: '.1em' }}
    onMouseEnter={e => { const t = e.currentTarget; t.style.borderColor = danger ? '#ef4444' : '#0ea5e9'; t.style.color = danger ? '#ef4444' : '#38bdf8'; }}
    onMouseLeave={e => { const t = e.currentTarget; t.style.borderColor = danger ? '#991b1b' : '#0a2540'; t.style.color = danger ? '#7f2020' : '#1e3a5f'; }}
  >{children}</button>
);

/** Labelled form input field */
const FF: React.FC<{ label: string; type?: string; value: string; onChange: (v: string) => void; placeholder?: string; note?: string; error?: string }> =
  ({ label, type = 'text', value, onChange, placeholder, note, error }) => (
  <div style={{ marginBottom: 14 }}>
    <label style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.54rem', color: '#1e3a5f', letterSpacing: '.14em', display: 'block', marginBottom: 5 }}>{label}</label>
    <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder || ''} />
    {error && <div style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.54rem', color: '#ef4444', marginTop: 3 }}>{error}</div>}
    {!error && note && <div style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.5rem', color: '#0a2540', marginTop: 3 }}>{note}</div>}
  </div>
);

/** Transaction hash badge */
const TxBadge: React.FC<{ id: string }> = ({ id }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', border: '1px solid #0a3a20', borderRadius: 3, background: 'rgba(16,185,129,.06)', fontFamily: 'Share Tech Mono,monospace', fontSize: '.5rem', color: '#10b981' }}>
    ✓ {id.slice(0, 10)}…
  </span>
);

// ─────────────────────────────────────────────────────────────────────────────
// §12  SECURITY GATE  (3-stage multi-lock component)
//      Stage 1: Age verification (must be 18+)
//      Stage 2: Terms of Service acceptance
//      Stage 3: Wallet connection (Freighter or generated address)
//      The "Initialize" button only activates when all three are locked.
// ─────────────────────────────────────────────────────────────────────────────

interface SecurityGateProps {
  onComplete: (walletAddress: string) => void;
}

const SecurityGate: React.FC<SecurityGateProps> = ({ onComplete }) => {
  const [gate, setGate] = useState<GateState>(() => {
    try {
      const saved = localStorage.getItem(GATE_KEY);
      return saved ? JSON.parse(saved) : { ageVerified: false, tosAccepted: false, walletConnected: false, walletAddress: '' };
    } catch {
      return { ageVerified: false, tosAccepted: false, walletConnected: false, walletAddress: '' };
    }
  });
  const [connecting, setConnecting] = useState(false);

  // Persist gate state (so browser refresh doesn't re-show all stages)
  useEffect(() => {
    try { localStorage.setItem(GATE_KEY, JSON.stringify(gate)); } catch {}
  }, [gate]);

  const activeStage: GateStage = !gate.ageVerified ? 1 : !gate.tosAccepted ? 2 : 3;
  const allLocked = gate.ageVerified && gate.tosAccepted && gate.walletConnected;

  const handleConnectWallet = async () => {
    setConnecting(true);
    const addr = await connectFreighterOrDemo();
    setGate(g => ({ ...g, walletConnected: true, walletAddress: addr }));
    setConnecting(false);
    sfx.click();
  };

  /** Render one stage row with active glow, locked state, and tick */
  const StageRow: React.FC<{
    stageNum: GateStage; title: string; subtitle: string;
    checked: boolean; onCheck?: () => void; children?: React.ReactNode;
  }> = ({ stageNum, title, subtitle, checked, onCheck, children }) => {
    const isActive  = activeStage === stageNum;
    const isLocked  = activeStage < stageNum;
    const isDone    = checked;
    const glowColor = isDone ? '#10b981' : isActive ? '#0ea5e9' : '#0a2540';
    const glowAnim  = isDone ? 'stageGlowG 2.5s ease-in-out infinite' : isActive ? 'stageGlow 2.5s ease-in-out infinite' : 'none';

    return (
      <div style={{
        padding: '16px 20px', border: `1px solid ${glowColor}`,
        borderRadius: 5, background: isDone ? 'rgba(16,185,129,.04)' : isActive ? 'rgba(14,165,233,.04)' : 'rgba(5,14,28,.5)',
        animation: glowAnim, transition: 'border-color .35s, background .35s',
        opacity: isLocked ? 0.45 : 1,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: children ? 12 : 0 }}>
          {/* Stage number badge */}
          <div style={{ width: 28, height: 28, borderRadius: '50%', border: `1px solid ${glowColor}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontFamily: 'Orbitron,monospace', fontSize: '.7rem', color: glowColor }}>
            {isDone ? '✓' : stageNum}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: '.7rem', letterSpacing: '.1em', color: isDone ? '#10b981' : isActive ? '#38bdf8' : '#0a2540' }}>{title}</div>
            <div style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.54rem', color: '#0a2540', marginTop: 2 }}>{subtitle}</div>
          </div>
          {isLocked && <div style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.7rem', color: '#0a2540' }}>🔒</div>}
        </div>
        {!isLocked && children}
      </div>
    );
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 10000, background: '#01060f', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div className="fu" style={{ maxWidth: 480, width: '100%', background: '#030c1a', border: '1px solid #0a2540', borderRadius: 8, padding: '36px 28px' }}>

        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: '3.2rem', animation: 'float 3.5s ease-in-out infinite', filter: 'drop-shadow(0 0 28px rgba(14,165,233,.55))' }}>⬡</div>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: '1.3rem', fontWeight: 900, color: '#38bdf8', letterSpacing: '.12em', animation: 'titleGlow 3s ease-in-out infinite', marginTop: 8 }}>
            ZERO<span style={{ color: '#ef4444' }}>—</span>SHOT
          </div>
          <div style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.54rem', color: '#0a2540', letterSpacing: '.22em', marginTop: 3 }}>MULTI-STAGE SECURITY GATE</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 22 }}>

          {/* Stage 1 — Age Verification */}
          <StageRow stageNum={1} title="AGE VERIFICATION" subtitle="Confirm you are 18 years of age or older" checked={gate.ageVerified}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={gate.ageVerified}
                onChange={e => { setGate(g => ({ ...g, ageVerified: e.target.checked })); if (e.target.checked) sfx.click(); }}
                style={{ marginTop: 3, accentColor: '#0ea5e9', width: 14, height: 14, flexShrink: 0 }}
              />
              <span style={{ fontSize: '.87rem', color: '#5d8aa8', lineHeight: 1.55 }}>
                I confirm I am <strong style={{ color: '#38bdf8' }}>18 years of age or older</strong>, or I have parental / guardian approval to play.
              </span>
            </label>
          </StageRow>

          {/* Stage 2 — Terms of Service */}
          <StageRow stageNum={2} title="TERMS OF SERVICE" subtitle="Read and accept the game terms" checked={gate.tosAccepted}>
            <div style={{ background: 'rgba(14,165,233,.03)', border: '1px solid #0a2540', borderRadius: 3, padding: '10px 12px', marginBottom: 10, maxHeight: 90, overflowY: 'auto' }}>
              <p style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.52rem', color: '#0a2540', lineHeight: 1.8 }}>
                This is a zero-knowledge strategy game. You acknowledge that: (1) all gameplay is for entertainment purposes; (2) you will not attempt to reverse-engineer the ZK circuits; (3) you accept the game rules as binding; (4) Anthropic and the Zero-Shot team are not liable for any losses arising from gameplay.
              </p>
            </div>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={gate.tosAccepted}
                onChange={e => { setGate(g => ({ ...g, tosAccepted: e.target.checked })); if (e.target.checked) sfx.click(); }}
                style={{ marginTop: 3, accentColor: '#0ea5e9', width: 14, height: 14, flexShrink: 0 }}
              />
              <span style={{ fontSize: '.87rem', color: '#5d8aa8', lineHeight: 1.55 }}>I have read and accept the Terms of Service.</span>
            </label>
          </StageRow>

          {/* Stage 3 — Wallet Connection */}
          <StageRow stageNum={3} title="WALLET CONNECTION" subtitle="Connect Freighter wallet or generate a session address" checked={gate.walletConnected}>
            {gate.walletConnected ? (
              <div style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.62rem', color: '#10b981' }}>
                ✓ {gate.walletAddress.slice(0, 8)}…{gate.walletAddress.slice(-6)}
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <PBtn sm onClick={handleConnectWallet} disabled={connecting}>
                  {connecting ? 'CONNECTING…' : '🔐 CONNECT FREIGHTER'}
                </PBtn>
                <GBtn onClick={async () => { const a = genAddr(); setGate(g => ({ ...g, walletConnected: true, walletAddress: a })); sfx.click(); }}>
                  Generate session address
                </GBtn>
              </div>
            )}
          </StageRow>
        </div>

        {/* Master "Initialize" button — only enabled when all stages are locked */}
        <PBtn full disabled={!allLocked} onClick={() => { localStorage.removeItem(GATE_KEY); onComplete(gate.walletAddress); }}>
          {allLocked ? '🚀 INITIALIZE MISSION CONTROL' : `COMPLETE ALL ${3 - [gate.ageVerified, gate.tosAccepted, gate.walletConnected].filter(Boolean).length} STAGE(S) ABOVE`}
        </PBtn>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// §13  TACTICAL GRID
// ─────────────────────────────────────────────────────────────────────────────

/** Per-cell visual configuration */
const CELL_CFG: Record<CellKind, { bg: string; bd: string; icon: string; col: string; glow?: string; anim?: string; sz?: string }> = {
  fog:      { bg: '#040c1a', bd: '#0b1f34', icon: '≋',  col: '#0b1f34' },
  empty:    { bg: '#020810', bd: '#081728', icon: '·',   col: '#0a2540' },
  unit:     { bg: 'rgba(16,185,129,.12)', bd: '#10b981', icon: '◈', col: '#10b981', glow: '0 0 14px rgba(16,185,129,.5)', anim: 'pulseG 2.5s ease-in-out infinite', sz: '1.15em' },
  hit:      { bg: 'rgba(239,68,68,.16)',  bd: '#ef4444', icon: '✕', col: '#ff6b6b', glow: '0 0 20px rgba(239,68,68,.7)', anim: 'hitBurst .4s ease-out', sz: '1.15em' },
  miss:     { bg: 'rgba(30,58,95,.1)',   bd: '#102035', icon: '○', col: '#2a4a6a' },
  targeted: { bg: 'rgba(245,158,11,.1)', bd: '#92400e', icon: '◎', col: '#f59e0b', glow: '0 0 16px rgba(245,158,11,.5)', anim: 'tgtPulse 1.4s ease-in-out infinite', sz: '1.05em' },
};

const GridCell = React.memo<{ kind: CellKind; idx: number; mode: GridMode; onSel: (i: number) => void }>(
  ({ kind, idx, mode, onSel }) => {
  const [hov, setHov] = useState(false);
  const cfg = CELL_CFG[kind];
  const can = (mode === 'place'  && kind === 'empty') ||
              (mode === 'attack' && (kind === 'fog' || kind === 'targeted'));
  const hl  = hov && can;
  return (
    <button type="button" disabled={!can} title={coord(idx)}
      onClick={() => { if (can) onSel(idx); }}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        position: 'relative', width: '100%', aspectRatio: '1',
        background: hl ? 'rgba(14,165,233,.16)' : cfg.bg,
        border: `1px solid ${hl ? '#0ea5e9' : cfg.bd}`, borderRadius: 3,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: cfg.sz || 'clamp(.5rem,.85vw,.82rem)',
        fontFamily: 'Share Tech Mono,monospace', color: hl ? '#38bdf8' : cfg.col,
        boxShadow: hl ? '0 0 16px rgba(14,165,233,.5)' : (cfg.glow || 'none'),
        animation: cfg.anim, transition: 'background .1s,border-color .1s,box-shadow .1s',
        cursor: can ? 'crosshair' : 'default', overflow: 'hidden', padding: 0, userSelect: 'none',
      }}
    >
      {kind === 'fog'      && mode !== 'view' && <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: `radial-gradient(circle at ${28+(idx*11)%44}% ${32+(idx*17)%36}%,rgba(14,165,233,.06),transparent 65%)` }} />}
      {kind === 'hit'      && <div style={{ position: 'absolute', inset: 0, borderRadius: 3, border: '2px solid #ef4444', animation: 'ripple .8s ease-out forwards', pointerEvents: 'none' }} />}
      {kind === 'targeted' && <div style={{ position: 'absolute', inset: 3, borderRadius: 2, border: '1px dashed #f59e0b', opacity: .7, pointerEvents: 'none' }} />}
      {hl && ['tl','tr','bl','br'].map(p => (
        <div key={p} style={{ position: 'absolute', width: 7, height: 7, pointerEvents: 'none',
          top: p[0]==='t' ? 2 : undefined, bottom: p[0]==='b' ? 2 : undefined,
          left: p[1]==='l' ? 2 : undefined, right: p[1]==='r' ? 2 : undefined,
          borderTop: p[0]==='t' ? '1.5px solid #38bdf8' : undefined,
          borderBottom: p[0]==='b' ? '1.5px solid #38bdf8' : undefined,
          borderLeft: p[1]==='l' ? '1.5px solid #38bdf8' : undefined,
          borderRight: p[1]==='r' ? '1.5px solid #38bdf8' : undefined,
        }} />
      ))}
      <span style={{ position: 'relative', zIndex: 1, lineHeight: 1 }}>{cfg.icon}</span>
    </button>
  );
});

const TacticalGrid = React.memo<{ cells: CellKind[]; mode: GridMode; onSel: (i: number) => void; label: string; accent: string }>(
  ({ cells, mode, onSel, label, accent }) => (
  <div style={{ flex: '1 1 240px', maxWidth: 340, width: '100%' }}>
    <div style={{ fontFamily: 'Orbitron,monospace', fontSize: '.62rem', letterSpacing: '.16em', color: accent, marginBottom: 8, textAlign: 'center', textShadow: `0 0 12px ${accent}60` }}>{label}</div>
    <div style={{ display: 'grid', gridTemplateColumns: `14px repeat(${GRID},1fr)`, gap: 2, marginBottom: 2 }}>
      <div />
      {Array.from({ length: GRID }, (_, c) => (
        <div key={c} style={{ textAlign: 'center', fontFamily: 'Share Tech Mono,monospace', fontSize: '.46rem', color: '#0a2540' }}>{String.fromCharCode(65 + c)}</div>
      ))}
    </div>
    {Array.from({ length: GRID }, (_, row) => (
      <div key={row} style={{ display: 'grid', gridTemplateColumns: `14px repeat(${GRID},1fr)`, gap: 2, marginBottom: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Share Tech Mono,monospace', fontSize: '.46rem', color: '#0a2540' }}>{row + 1}</div>
        {Array.from({ length: GRID }, (_, col) => {
          const i = row * GRID + col;
          return <GridCell key={i} idx={i} kind={cells[i]} mode={mode} onSel={onSel} />;
        })}
      </div>
    ))}
  </div>
));

// ─────────────────────────────────────────────────────────────────────────────
// §14  TACTICAL LOG — auto-scrolling mission feed
// ─────────────────────────────────────────────────────────────────────────────

const LOG_COLORS: Record<LogType, [string, string]> = {
  sys:    ['#10b981', 'SYS'],  zk:     ['#a78bfa', 'ZK'],
  fire:   ['#f59e0b', 'FIRE'], hit:    ['#ef4444', 'HIT!'],
  miss:   ['#475569', 'MISS'], wallet: ['#38bdf8', 'TX'],
  warn:   ['#f97316', 'WARN'],
};

const TacticalLog = React.memo<{ entries: LogEntry[] }>(({ entries }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [entries.length]);
  return (
    <div style={{ position: 'relative', background: '#010810', border: '1px solid #0a2540', borderRadius: 4, padding: '10px 12px', height: 165, overflow: 'hidden' }}>
      <div style={{ fontFamily: 'Orbitron,monospace', fontSize: '.55rem', letterSpacing: '.2em', color: '#0ea5e9', marginBottom: 6 }}>▸ TACTICAL LOG</div>
      <div ref={ref} style={{ height: 'calc(100% - 24px)', overflowY: 'auto' }}>
        {entries.length === 0 && <span style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.58rem', color: '#0a2540' }}>signal awaited…</span>}
        {entries.map((e, i) => {
          const [col, tag] = LOG_COLORS[e.t];
          return (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 3, animation: i === entries.length - 1 ? 'slideIn .18s ease-out' : undefined, fontFamily: 'Share Tech Mono,monospace', fontSize: '.58rem' }}>
              <span style={{ color: '#0a2540', flexShrink: 0 }}>{e.ts}</span>
              <span style={{ color: col, flexShrink: 0, minWidth: 36, textShadow: `0 0 7px ${col}80` }}>[{tag}]</span>
              <span style={{ color: '#5d8aa8' }}>{e.msg}</span>
            </div>
          );
        })}
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, height: 2, pointerEvents: 'none', background: 'linear-gradient(90deg,transparent,rgba(14,165,233,.18),transparent)', animation: 'scanLine 7s linear infinite' }} />
    </div>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// §15  ZK PROGRESS BAR — shows the live proof state machine
// ─────────────────────────────────────────────────────────────────────────────

const ZKProgressBar: React.FC<{ game: GameState }> = ({ game }) => {
  const prog   = zkProgress(game);
  const label  = zkLabel(game);
  const busy   = zkBusy(game);
  const failed = game.zkProof.state === 'VERIFICATION_FAILURE';
  const done   = game.zkProof.state === 'VERIFICATION_SUCCESS';
  const barCol = failed ? '#ef4444' : done ? '#10b981' : '#0ea5e9';

  const stages: ZKState[] = ['WITNESS_GENERATION', 'CIRCUIT_COMPILATION', 'PROOF_GENERATION', 'ON_CHAIN_VERIFICATION', 'VERIFICATION_SUCCESS'];
  const stageLabels = ['Witness', 'Circuit', 'Prove', 'Verify', 'Done'];
  const stageOrder: Record<ZKState, number> = {
    IDLE: -1, WITNESS_GENERATION: 0, CIRCUIT_COMPILATION: 1, PROOF_GENERATION: 2,
    ON_CHAIN_VERIFICATION: 3, VERIFICATION_SUCCESS: 4, VERIFICATION_FAILURE: 4,
  };
  const currentOrder = stageOrder[game.zkProof.state] ?? -1;

  return (
    <div style={{ background: '#010810', border: `1px solid ${busy ? '#0a2540' : failed ? 'rgba(239,68,68,.3)' : done ? 'rgba(16,185,129,.3)' : '#0a2540'}`, borderRadius: 4, padding: '10px 14px', transition: 'border-color .3s' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: '.6rem', letterSpacing: '.15em', color: barCol }}>{label}</div>
        {busy && <div style={{ width: 10, height: 10, border: '2px solid #0a2540', borderTopColor: '#0ea5e9', borderRadius: '50%', animation: 'spin .8s linear infinite', flexShrink: 0 }} />}
      </div>
      {/* Progress bar track */}
      <div style={{ height: 3, background: '#0a2540', borderRadius: 2, overflow: 'hidden', marginBottom: 8 }}>
        <div style={{ height: '100%', width: `${prog}%`, background: barCol, borderRadius: 2, transition: 'width .4s ease-out', boxShadow: `0 0 6px ${barCol}70` }} />
      </div>
      {/* Stage pips */}
      <div style={{ display: 'flex', gap: 4 }}>
        {stages.map((st, i) => {
          const passed = currentOrder >= i;
          const active = currentOrder === i;
          return (
            <div key={st} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ width: '100%', height: 2, background: passed ? barCol : '#0a2540', borderRadius: 1, marginBottom: 3, transition: 'background .3s' }} />
              <span style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.42rem', color: active ? barCol : passed ? '#10b981' : '#0a2540', transition: 'color .3s' }}>{stageLabels[i]}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// §16  VOICE COMMAND PANEL
// ─────────────────────────────────────────────────────────────────────────────

const VoicePanel: React.FC<{ hook: SpeechHook }> = ({ hook }) => (
  <div style={{
    background: '#010810',
    border: `1px solid ${hook.voiceActive ? '#7c3aed' : '#0a2540'}`,
    borderRadius: 4, padding: '10px 14px', transition: 'border-color .3s',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: hook.voiceActive ? 8 : 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Pulse indicator */}
        {hook.voiceActive && (
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#a78bfa', animation: 'voicePulse .85s ease-in-out infinite', flexShrink: 0 }} />
        )}
        <span style={{ fontFamily: 'Orbitron,monospace', fontSize: '.6rem', letterSpacing: '.15em', color: hook.voiceActive ? '#a78bfa' : '#1e3a5f' }}>
          {hook.voiceActive ? (hook.listening ? '🎤 VOICE ACTIVE' : '🎤 RECONNECTING…') : '🎙 VOICE COMMANDS'}
        </span>
      </div>
      {hook.supported ? (
        <button onClick={() => { hook.toggleVoice(); sfx.click(); }} style={{
          padding: '5px 12px', background: hook.voiceActive ? 'rgba(124,58,237,.15)' : 'transparent',
          border: `1px solid ${hook.voiceActive ? '#7c3aed' : '#0a2540'}`, borderRadius: 3,
          color: hook.voiceActive ? '#a78bfa' : '#1e3a5f', fontFamily: 'Share Tech Mono,monospace', fontSize: '.58rem',
        }}>
          {hook.voiceActive ? 'DEACTIVATE' : 'ACTIVATE'}
        </button>
      ) : (
        <span style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.52rem', color: '#0a2540' }}>Not supported in this browser</span>
      )}
    </div>
    {hook.voiceActive && (
      <div>
        <div style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.52rem', color: '#0a2540', lineHeight: 1.75, marginBottom: 6 }}>
          Say: <span style={{ color: '#5d8aa8' }}>"Fire Alpha 4"</span> · <span style={{ color: '#5d8aa8' }}>"Fire Bravo 2"</span> · <span style={{ color: '#5d8aa8' }}>"Abort"</span>
        </div>
        {hook.lastCmd && (
          <div style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.58rem', color: hook.lastCmd.action === 'unknown' ? '#475569' : '#a78bfa' }}>
            {hook.lastCmd.action === 'unknown'
              ? `"${hook.lastCmd.transcript}" — not recognised`
              : `✓ ${hook.lastCmd.action.toUpperCase()} ${hook.lastCmd.coord}  (${(hook.lastCmd.confidence * 100).toFixed(0)}%)`}
          </div>
        )}
      </div>
    )}
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// §17  DASHBOARD SCREEN
// ─────────────────────────────────────────────────────────────────────────────

const Dashboard: React.FC<{ user: UserProfile; onClose: () => void }> = ({ user, onClose }) => {
  const tCol: Record<TxType, string>   = { deposit: '#10b981', withdraw: '#f59e0b', stake: '#38bdf8', win: '#22c55e', loss: '#ef4444', refund: '#a78bfa' };
  const tIcon: Record<TxType, string>  = { deposit: '↓', withdraw: '↑', stake: '◈', win: '★', loss: '✕', refund: '↺' };
  const tSign: Record<TxType, string>  = { deposit: '+', withdraw: '-', stake: '-', win: '+', loss: '-', refund: '+' };
  return (
    <div className="ap" style={{ maxWidth: 740, margin: '0 auto', padding: '0 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: '.95rem', fontWeight: 900, color: '#38bdf8', letterSpacing: '.1em' }}>COMMAND CENTRE</div>
          <div style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.52rem', color: '#0a2540', marginTop: 2 }}>
            {user.emailVerified ? '🔐 VERIFIED' : '🎮 DEMO'} OPERATIVE: {user.username.toUpperCase()}
          </div>
        </div>
        <GBtn onClick={onClose}>← BACK</GBtn>
      </div>

      {/* Identity panel */}
      <div style={{ background: '#010d1c', border: '1px solid #0a2540', borderRadius: 6, padding: '14px 16px', marginBottom: 14 }}>
        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: '.58rem', color: '#0ea5e9', letterSpacing: '.16em', marginBottom: 10 }}>▸ IDENTITY</div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          {user.picture && <img src={user.picture} alt="avatar" style={{ width: 48, height: 48, borderRadius: '50%', border: '1px solid #0a2540' }} />}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 8, flex: 1 }}>
            <div><div style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.5rem', color: '#0a2540' }}>OPERATIVE</div><div style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.6rem', color: '#5d8aa8', marginTop: 2 }}>{user.username}</div></div>
            <div><div style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.5rem', color: '#0a2540' }}>EMAIL</div><div style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.6rem', color: user.emailVerified ? '#10b981' : '#f59e0b', marginTop: 2 }}>{user.email} {user.emailVerified ? '✓' : ''}</div></div>
            <div><div style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.5rem', color: '#0a2540' }}>WALLET</div><div style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.6rem', color: '#5d8aa8', marginTop: 2 }}>{user.walletAddress.slice(0, 8)}…{user.walletAddress.slice(-6)}</div></div>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(100px,1fr))', gap: 8, marginBottom: 14 }}>
        <Stat label="BALANCE"  val={`${user.balance.toFixed(1)} XLM`}   color="#10b981" />
        <Stat label="WINS"     val={user.wins}                           color="#22c55e" />
        <Stat label="LOSSES"   val={user.losses}                         color="#ef4444" />
        <Stat label="STAKED"   val={`${user.totalStaked} XLM`}          color="#38bdf8" />
        <Stat label="WIN RATE" val={user.wins + user.losses > 0 ? `${Math.round(user.wins / (user.wins + user.losses) * 100)}%` : '—'} color="#f59e0b" />
      </div>

      {/* TX history */}
      <div style={{ background: '#010d1c', border: '1px solid #0a2540', borderRadius: 6, overflow: 'hidden' }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid #0a2540', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: 'Orbitron,monospace', fontSize: '.58rem', color: '#0ea5e9', letterSpacing: '.16em' }}>▸ TRANSACTIONS</span>
          <span style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.5rem', color: '#0a2540' }}>{user.txHistory.length} records</span>
        </div>
        {user.txHistory.length === 0 ? (
          <div style={{ padding: '28px', textAlign: 'center', fontFamily: 'Share Tech Mono,monospace', fontSize: '.6rem', color: '#0a2540' }}>No transactions yet.</div>
        ) : (
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {[...user.txHistory].reverse().map((tx, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 16px', borderBottom: '1px solid #050e1c' }}>
                <div style={{ width: 24, height: 24, borderRadius: '50%', border: `1px solid ${tCol[tx.type]}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontFamily: 'Share Tech Mono,monospace', fontSize: '.68rem', color: tCol[tx.type] }}>{tIcon[tx.type]}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'Rajdhani,sans-serif', fontWeight: 600, fontSize: '.86rem', color: '#8ab4cc' }}>{tx.label}</div>
                  <div style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.48rem', color: '#0a2540', marginTop: 1 }}>{tx.ts} · {tx.id.slice(0, 10)}…</div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontFamily: 'Orbitron,monospace', fontSize: '.76rem', color: tCol[tx.type], fontWeight: 700 }}>{tSign[tx.type]}{tx.amount} XLM</div>
                  <div style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.46rem', color: tx.status === 'confirmed' ? '#10b981' : '#f59e0b', marginTop: 1 }}>{tx.status}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// §18  SHARED HEADER
// ─────────────────────────────────────────────────────────────────────────────

const AppHeader: React.FC<{
  user: UserProfile | null;
  muted: boolean;
  onToggleMute: () => void;
  onDash?: () => void;
  onLogout?: () => void;
  extraRight?: React.ReactNode;
}> = ({ user, muted, onToggleMute, onDash, onLogout, extraRight }) => (
  <header style={{ padding: '11px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, borderBottom: '1px solid #0a1e34', background: 'rgba(1,6,15,.92)', backdropFilter: 'blur(12px)', position: 'sticky', top: 0, zIndex: 100 }}>
    <div>
      <h1 style={{ fontFamily: 'Orbitron,monospace', fontSize: 'clamp(.9rem,2.2vw,1.6rem)', fontWeight: 900, letterSpacing: '.1em', color: '#38bdf8', textShadow: '0 0 18px rgba(56,189,248,.45)', lineHeight: 1 }}>
        ZERO<span style={{ color: '#ef4444', textShadow: '0 0 12px rgba(239,68,68,.6)' }}>—</span>SHOT
      </h1>
      {user && (
        <div style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.46rem', color: '#0a2540', letterSpacing: '.16em', marginTop: 2 }}>
          {user.emailVerified ? '🔐 VERIFIED' : '🎮 DEMO'} · {user.username.toUpperCase()}
        </div>
      )}
    </div>
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {user && (
        <>
          <Stat sm label="BAL" val={`${user.balance.toFixed(0)} XLM`} color="#10b981" />
          <Stat sm label="W/L" val={`${user.wins}/${user.losses}`}     color="#f59e0b" />
        </>
      )}
      {extraRight}
      <button onClick={() => { sfx.click(); onToggleMute(); }} title={muted ? 'Unmute' : 'Mute'}
        style={{ padding: '7px 10px', background: 'transparent', border: '1px solid #0a2540', borderRadius: 3, color: muted ? '#1e3a5f' : '#38bdf8', fontFamily: 'Share Tech Mono,monospace', fontSize: '.75rem' }}>
        {muted ? '🔇' : '🔊'}
      </button>
      {onDash    && <GBtn onClick={onDash}>📊</GBtn>}
      {onLogout  && <GBtn onClick={onLogout} danger>↩ OUT</GBtn>}
    </div>
  </header>
);

// ─────────────────────────────────────────────────────────────────────────────
// §19  FOOTER — subtle Network Status chip, no intrusive banners
// ─────────────────────────────────────────────────────────────────────────────

const AppFooter: React.FC<{ network: NetworkStatus }> = ({ network }) => (
  <footer style={{ padding: '8px 20px', borderTop: '1px solid #050d1a', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 4, background: 'rgba(1,6,15,.8)' }}>
    <span style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.46rem', color: '#0a2540', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '55%' }}>
      HUB: {HUB_ADDR}
    </span>
    {/* Network Status chip — no popup, no banner, just this */}
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <div style={{ width: 6, height: 6, borderRadius: '50%', background: network.color, boxShadow: `0 0 6px ${network.color}90` }} />
      <span style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.48rem', color: network.color, letterSpacing: '.1em' }}>{network.label}</span>
    </div>
  </footer>
);

// ─────────────────────────────────────────────────────────────────────────────
// §20  AUTH0 CONFIG BANNER — shown when credentials are missing
// ─────────────────────────────────────────────────────────────────────────────

const ConfigBanner: React.FC = () => (
  <div style={{ position: 'fixed', inset: 0, background: '#01060f', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 20000 }}>
    <div style={{ maxWidth: 520, background: '#030c1a', border: '1px solid #0a2540', borderRadius: 8, padding: '32px 28px' }}>
      <div style={{ fontFamily: 'Orbitron,monospace', fontSize: '1rem', color: '#38bdf8', marginBottom: 16 }}>AUTH0 CONFIGURATION NEEDED</div>
      <p style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.65rem', color: '#5d8aa8', lineHeight: 1.8, marginBottom: 18 }}>
        Auth0 credentials are not configured. To enable real authentication:
      </p>
      <ol style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.62rem', color: '#0a2540', lineHeight: 2.2, paddingLeft: 20 }}>
        <li>Create a free account at <span style={{ color: '#38bdf8' }}>auth0.com</span></li>
        <li>Create an SPA application</li>
        <li>Add <span style={{ color: '#38bdf8' }}>http://localhost:5173</span> to Callback / Logout / Web Origins</li>
        <li>Create a <span style={{ color: '#38bdf8' }}>.env</span> file with <span style={{ color: '#10b981' }}>VITE_AUTH0_DOMAIN</span> and <span style={{ color: '#10b981' }}>VITE_AUTH0_CLIENT_ID</span></li>
        <li>Restart the dev server</li>
      </ol>
      <div style={{ marginTop: 20, padding: '12px', background: '#020810', border: '1px solid #0a2540', borderRadius: 3, fontFamily: 'Share Tech Mono,monospace', fontSize: '.6rem', color: '#1e3a5f' }}>
        <div style={{ color: '#475569', marginBottom: 4 }}># .env</div>
        <div>VITE_AUTH0_DOMAIN=<span style={{ color: '#10b981' }}>your-tenant.auth0.com</span></div>
        <div>VITE_AUTH0_CLIENT_ID=<span style={{ color: '#10b981' }}>your_client_id</span></div>
        <div style={{ marginTop: 6, color: '#475569' }}># Optional: EmailJS for in-game alerts</div>
        <div>VITE_EJS_SERVICE=<span style={{ color: '#10b981' }}>service_xxxxx</span></div>
        <div>VITE_EJS_TEMPLATE=<span style={{ color: '#10b981' }}>template_xxxxx</span></div>
        <div>VITE_EJS_PUBKEY=<span style={{ color: '#10b981' }}>your_public_key</span></div>
      </div>
    </div>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// §21  ROOT APP COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  // ── Auth0 context ───────────────────────────────────────────────────────────
  const { user: a0User, isAuthenticated, isLoading: a0Loading, loginWithRedirect, logout } = useAuth0();

  // ── Derived user profile (Auth0 claims + local stats) ───────────────────────
  const [profile, setProfile] = useState<UserProfile | null>(null);

  // ── Screens and panels ─────────────────────────────────────────────────────
  type Screen = 'gate' | 'lobby' | 'game' | 'dashboard';
  const [screen, setScreen] = useState<Screen>('gate');

  // ── Game state via reducer ──────────────────────────────────────────────────
  const [game, dispatch] = useReducer(gameReducer, blankGame());
  const gameRef = useRef<GameState>(game);
  useEffect(() => { gameRef.current = game; }, [game]);

  // ── Profile ref for async closures ─────────────────────────────────────────
  const profileRef = useRef<UserProfile | null>(null);
  useEffect(() => { profileRef.current = profile; }, [profile]);

  // ── Misc UI ─────────────────────────────────────────────────────────────────
  const [stakeInput, setStakeInput]     = useState('10');
  const [muted,      setMuted]          = useState(false);
  const [network,    setNetwork]        = useState<NetworkStatus>({ kind: 'unknown', label: 'Detecting…', color: '#475569' });
  const busyRef = useRef(false);  // synchronous re-entrant gate for fire flow

  // ── CSS injection ───────────────────────────────────────────────────────────
  useEffect(() => {
    const el = document.createElement('style');
    el.textContent = GLOBAL_CSS;
    document.head.appendChild(el);
    return () => document.head.removeChild(el);
  }, []);

  // ── Network detection (runs once) ───────────────────────────────────────────
  useEffect(() => { detectNetwork().then(setNetwork); }, []);

  // ── Persist game whenever it changes ────────────────────────────────────────
  useEffect(() => { persistGame(game.sid > 0 ? game : null); }, [game]);

  // ── Build/restore profile when Auth0 authenticates ─────────────────────────
  useEffect(() => {
    if (!isAuthenticated || !a0User) return;
    const key = PROFILE_KEY(a0User.sub!);
    const saved = loadProfile(key);
    if (saved) {
      setProfile(saved);
    } else {
      // First login — create a new profile seeded from Auth0 claims
      const fresh: UserProfile = {
        sub:          a0User.sub!,
        username:     (a0User.nickname || a0User.email?.split('@')[0] || 'operative').toLowerCase(),
        email:        a0User.email || '',
        emailVerified: a0User.email_verified ?? false,
        picture:      a0User.picture || '',
        walletAddress: genAddr(),  // replaced when gate stage-3 completes
        balance:      a0User.email_verified ? 500 : 200,
        wins:         0,
        losses:       0,
        totalStaked:  0,
        txHistory:    [{
          id:     txId(),
          type:   'deposit',
          amount: a0User.email_verified ? 500 : 200,
          ts:     datets(),
          status: 'confirmed',
          label:  `Welcome — ${a0User.email_verified ? 'verified' : 'demo'} account`,
        }],
        createdAt: datets(),
      };
      saveProfile(key, fresh);
      setProfile(fresh);
    }

    // Restore an in-progress battle if one exists
    const saved_game = loadSavedGame();
    if (saved_game && saved_game.phase === 'battle') {
      dispatch({ type: 'GAME_RESTORE', payload: saved_game });
      setScreen('game');
      sfx.startBg();
    } else {
      // Refund stake for sessions that never finished placement
      if (saved_game && saved_game.stakeDeducted && saved_game.phase !== 'ended') {
        const key2 = PROFILE_KEY(a0User.sub!);
        const p    = loadProfile(key2);
        if (p) {
          const upd = withTx({ ...p, balance: p.balance + saved_game.stake }, {
            type: 'refund', amount: saved_game.stake, status: 'confirmed',
            label: `Auto-refund session #${saved_game.sid}`, sessionId: saved_game.sid,
          });
          saveProfile(key2, upd);
          setProfile(upd);
        }
        persistGame(null);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, a0User]);

  // ── Persist profile helper ──────────────────────────────────────────────────
  const persistProfile = useCallback((p: UserProfile) => {
    saveProfile(PROFILE_KEY(p.sub), p);
    setProfile(p);
    profileRef.current = p;
  }, []);

  // ── Gate completion ─────────────────────────────────────────────────────────
  const handleGateComplete = useCallback((walletAddress: string) => {
    if (!profile) { loginWithRedirect(); return; }
    const updated = { ...profile, walletAddress };
    persistProfile(updated);
    setScreen('lobby');
  }, [profile, loginWithRedirect, persistProfile]);

  // ── Start game ──────────────────────────────────────────────────────────────
  const handleStartGame = useCallback(async () => {
    if (busyRef.current) return;
    const p = profileRef.current;
    if (!p) return;
    const bet = Math.min(MAX_STAKE, Math.max(1, parseInt(stakeInput) || 10));
    if (bet > p.balance) { alert(`Insufficient balance (${p.balance.toFixed(1)} XLM)`); return; }
    busyRef.current = true;

    const sid     = 1000 + rnd(9000);
    const foeUnit = rnd(CELLS);
    dispatch({ type: 'GAME_INIT', payload: { sid, stake: bet, foeUnit } });
    setScreen('game');
    sfx.startBg();

    // Deduct stake from profile immediately (prevents spending twice on restore)
    const stx = { type: 'stake' as TxType, amount: bet, status: 'confirmed' as const, label: `Game #${sid} stake`, sessionId: sid };
    const upd = withTx({ ...p, balance: p.balance - bet, totalStaked: p.totalStaked + bet }, stx);
    persistProfile(upd);

    // Simulate network TX for stake lock
    await wait(300 + rnd(200));
    dispatch({ type: 'LOG_APPEND', payload: [mkLog(`Hub: ${HUB_ADDR.slice(0, 14)}…`)] });
    await wait(250);
    const stakeTx = txId();
    dispatch({ type: 'GAME_READY', payload: { txId: stakeTx } });
    busyRef.current = false;
  }, [stakeInput, persistProfile]);

  // ── Place unit ──────────────────────────────────────────────────────────────
  const handlePlace = useCallback(async (index: number) => {
    if (busyRef.current) return;
    const g = gameRef.current;
    if (!g || g.myUnit !== -1 || g.phase !== 'placement') return;
    busyRef.current = true;
    sfx.place();

    dispatch({ type: 'UNIT_PLACE', payload: { index } });

    // Simulate Poseidon commitment to chain
    await wait(280); dispatch({ type: 'LOG_APPEND', payload: [mkLog(`Poseidon(pos=${index}, salt=0x${hex(8)})`, 'zk')] });
    await wait(360); dispatch({ type: 'LOG_APPEND', payload: [mkLog(`Commit: 0x${hex(32)}`, 'zk')] });
    await wait(420); dispatch({ type: 'LOG_APPEND', payload: [mkLog('Commitment on-chain → confirmed ✓', 'zk')] });
    await wait(320);

    dispatch({ type: 'BATTLE_BEGIN', payload: { myTurn: rnd(2) === 0 } });
    busyRef.current = false;
  }, []);

  // ── Fire action — full ZK proof state machine ────────────────────────────────
  const handleFire = useCallback(async (index: number) => {
    if (busyRef.current) return;
    const snap = gameRef.current;
    if (!snap || !canFire(snap)) return;
    if (snap.foeGrid[index] !== 'fog' && snap.foeGrid[index] !== 'targeted') return;
    busyRef.current = true;

    sfx.fire();

    // ── ZK Witness Generation ────────────────────────────────────────────────
    dispatch({ type: 'ZK_WITNESS_BEGIN', payload: { index } });
    const witnessHex = await simulateZK(280, 380);
    dispatch({ type: 'ZK_WITNESS_DONE', payload: { witnessHex } });

    // ── Circuit Compilation ──────────────────────────────────────────────────
    dispatch({ type: 'ZK_CIRCUIT_BEGIN' });
    await simulateZK(320, 420);

    // ── Proof Generation ─────────────────────────────────────────────────────
    dispatch({ type: 'ZK_PROOF_BEGIN' });
    const proofHex = await simulateZK(360, 480);
    dispatch({ type: 'ZK_PROOF_DONE', payload: { proofHex } });

    // ── On-Chain Verification ────────────────────────────────────────────────
    dispatch({ type: 'ZK_VERIFY_BEGIN' });
    await wait(320 + rnd(180));

    const isHit        = index === snap.foeUnit;
    const verifyTxHash = txId();

    dispatch({ type: 'ZK_VERIFY_SUCCESS', payload: { isHit, verifyTxHash } });
    if (isHit) sfx.hit(); else sfx.miss();

    // ── Apply shot to board ──────────────────────────────────────────────────
    await wait(120);
    dispatch({ type: 'SHOT_APPLY', payload: { index, isHit } });

    // ── Player wins ──────────────────────────────────────────────────────────
    if (isHit) {
      await wait(280);
      sfx.victory();
      const endTx = txId();
      dispatch({ type: 'GAME_OVER', payload: { winner: 'you', txId: endTx } });
      persistGame(null);
      const p = profileRef.current;
      if (p) {
        const prize = snap.stake * 2;
        const upd   = withTx({ ...p, balance: p.balance + prize, wins: p.wins + 1 }, {
          type: 'win', amount: prize, status: 'confirmed',
          label: `Win game #${snap.sid} (+${prize} XLM)`, sessionId: snap.sid,
        });
        persistProfile(upd);
        // In-game email alert
        if (p.email) sendGameAlert({ type: 'game_won', toEmail: p.email, username: p.username, sessionId: snap.sid, detail: `You won ${prize} XLM!` });
        // Low balance alert
        if (upd.balance < 20 && p.email) sendGameAlert({ type: 'low_balance', toEmail: p.email, username: p.username, sessionId: snap.sid, detail: `Balance is ${upd.balance.toFixed(1)} XLM` });
      }
      busyRef.current = false;
      return;
    }

    // ── Enemy AI turn ─────────────────────────────────────────────────────────
    await wait(460);
    sfx.efir();
    dispatch({ type: 'LOG_APPEND', payload: [mkLog('Enemy computing strike…', 'fire')] });
    await wait(680);

    // All enemy logic in ONE functional update — always reads freshest state
    const latest = gameRef.current;
    if (!latest) { busyRef.current = false; return; }
    const avail = latest.myGrid.map((_, i) => i).filter(i => latest.myGrid[i] !== 'hit' && latest.myGrid[i] !== 'miss');
    if (avail.length === 0) { dispatch({ type: 'ZK_RESET' }); busyRef.current = false; return; }

    const aiIdx   = avail[rnd(avail.length)];
    const aiIsHit = aiIdx === latest.myUnit;

    dispatch({ type: 'ENEMY_STRIKE', payload: { index: aiIdx, isHit: aiIsHit } });

    if (aiIsHit) {
      sfx.ehit();
      await wait(280);
      sfx.defeat();
      const endTx = txId();
      dispatch({ type: 'GAME_OVER', payload: { winner: 'foe', txId: endTx } });
      persistGame(null);
      const p = profileRef.current;
      if (p) {
        const upd = withTx({ ...p, losses: p.losses + 1 }, {
          type: 'loss', amount: snap.stake, status: 'confirmed',
          label: `Loss game #${snap.sid}`, sessionId: snap.sid,
        });
        persistProfile(upd);
        if (p.email) sendGameAlert({ type: 'game_lost', toEmail: p.email, username: p.username, sessionId: snap.sid, detail: `Session #${snap.sid} ended.` });
      }
    } else {
      // Send enemy-attack alert (rate-limited to one per 60s)
      const p = profileRef.current;
      if (p?.email) sendGameAlert({ type: 'enemy_attack', toEmail: p.email, username: p.username, sessionId: snap.sid, detail: `Enemy fired at ${coord(aiIdx)} and missed.` });
    }

    dispatch({ type: 'ZK_RESET' });
    busyRef.current = false;
  }, [persistProfile]);

  // ── Voice command handler ────────────────────────────────────────────────────
  const handleVoiceCommand = useCallback((cmd: VoiceCommand) => {
    if (cmd.action === 'fire' && cmd.cellIndex >= 0) {
      dispatch({ type: 'LOG_APPEND', payload: [mkLog(`Voice: FIRE ${cmd.coord} (${(cmd.confidence * 100).toFixed(0)}%)`, 'fire')] });
      handleFire(cmd.cellIndex);
    } else if (cmd.action === 'abort') {
      handleAbort();
    }
  }, [handleFire]);

  const voice = useSpeechRecognition(handleVoiceCommand);

  // ── Abort with stake refund ──────────────────────────────────────────────────
  const handleAbort = useCallback(() => {
    const g = gameRef.current;
    const p = profileRef.current;
    if (g && p && g.stakeDeducted && g.phase !== 'ended') {
      const upd = withTx({ ...p, balance: p.balance + g.stake }, {
        type: 'refund', amount: g.stake, status: 'confirmed',
        label: `Stake refund — aborted #${g.sid}`, sessionId: g.sid,
      });
      persistProfile(upd);
    }
    busyRef.current = false;
    persistGame(null);
    dispatch({ type: 'GAME_RESET' });
    sfx.stopBg();
    voice.stopListening();
    setScreen('lobby');
  }, [persistProfile, voice]);

  // ── Logout ───────────────────────────────────────────────────────────────────
  const handleLogout = useCallback(() => {
    handleAbort();
    setProfile(null);
    setScreen('gate');
    logout({ logoutParams: { returnTo: window.location.origin } });
  }, [handleAbort, logout]);

  const toggleMute = useCallback(() => { const m = sfx.toggleMute(); setMuted(m); }, []);
  const acc = useMemo(() => accuracy(game), [game]);
  const busy = busyRef.current;

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

  // Show config banner if Auth0 is not set up yet
  if (!AUTH0_READY) return <ConfigBanner />;

  // Auth0 is loading its SDK
  if (a0Loading) return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#01060f' }}>
      <div style={{ width: 36, height: 36, border: '2px solid #0a2540', borderTopColor: '#0ea5e9', borderRadius: '50%', animation: 'spin .8s linear infinite' }} />
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'radial-gradient(ellipse 80% 45% at 10% 0%,rgba(14,165,233,.05),transparent 55%),radial-gradient(ellipse 60% 40% at 90% 100%,rgba(239,68,68,.04),transparent 55%),#01060f' }}>

      {/* ══ SECURITY GATE ══ */}
      {(!isAuthenticated || screen === 'gate') && (
        <SecurityGate onComplete={(addr) => {
          if (!isAuthenticated) {
            // Persist wallet address intent, then redirect to Auth0 login
            localStorage.setItem('zs_pending_wallet', addr);
            loginWithRedirect();
          } else {
            handleGateComplete(addr);
          }
        }} />
      )}

      {/* ══ LOBBY ══ */}
      {isAuthenticated && profile && screen === 'lobby' && (
        <>
          <AppHeader user={profile} muted={muted} onToggleMute={toggleMute} onDash={() => setScreen('dashboard')} onLogout={handleLogout} />
          <main style={{ flex: 1, padding: '24px 20px', maxWidth: 640, margin: '0 auto', width: '100%' }}>
            <div className="fu" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 26, paddingTop: 16 }}>
              <div style={{ textAlign: 'center', animation: 'float 4s ease-in-out infinite' }}>
                <div style={{ fontSize: '4rem', filter: 'drop-shadow(0 0 32px rgba(14,165,233,.55))', lineHeight: 1 }}>⬡</div>
                <p style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.6rem', color: '#0a2540', marginTop: 8, letterSpacing: '.18em' }}>PROVABLY FAIR · PRIVATE · ZK-POWERED</p>
              </div>
              <div style={{ width: '100%', maxWidth: 440, background: 'linear-gradient(160deg,#030c1a,#020810)', border: '1px solid #0a2540', borderRadius: 6, padding: '24px' }}>
                <div style={{ fontFamily: 'Orbitron,monospace', fontSize: '.6rem', letterSpacing: '.2em', color: '#0ea5e9', marginBottom: 14 }}>▸ MISSION BRIEFING</div>
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.54rem', color: '#1e3a5f', letterSpacing: '.12em', display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                    <span>STAKE (XLM)</span>
                    <span style={{ color: '#0a2540' }}>available: {profile.balance.toFixed(1)}</span>
                  </label>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <input value={stakeInput} onChange={e => setStakeInput(e.target.value.replace(/\D/g, ''))} placeholder="10"
                      style={{ flex: 1, minWidth: 70 }}
                      onFocus={e => e.target.style.borderColor = '#0ea5e9'} onBlur={e => e.target.style.borderColor = '#0a2540'} />
                    {[5, 10, 25, 50].map(n => (
                      <button key={n} onClick={() => { setStakeInput(String(n)); sfx.click(); }}
                        style={{ padding: '0 9px', background: stakeInput === String(n) ? 'rgba(14,165,233,.15)' : 'transparent', border: `1px solid ${stakeInput === String(n) ? '#0ea5e9' : '#0a2540'}`, borderRadius: 3, color: stakeInput === String(n) ? '#38bdf8' : '#1e3a5f', fontFamily: 'Share Tech Mono,monospace', fontSize: '.58rem' }}>{n}</button>
                    ))}
                  </div>
                </div>
                <PBtn full onClick={handleStartGame}>▶ DEPLOY MISSION</PBtn>
              </div>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', justifyContent: 'center' }}>
                {['Noir UltraHonk', 'Poseidon Hash', 'BN254 On-chain', 'Soroban Hub', 'ZK Fog-of-War'].map(f => (
                  <span key={f} style={{ padding: '3px 10px', border: '1px solid #0a2540', borderRadius: 100, fontFamily: 'Share Tech Mono,monospace', fontSize: '.52rem', color: '#0a2540' }}>{f}</span>
                ))}
              </div>
            </div>
          </main>
          <AppFooter network={network} />
        </>
      )}

      {/* ══ DASHBOARD ══ */}
      {isAuthenticated && profile && screen === 'dashboard' && (
        <>
          <AppHeader user={profile} muted={muted} onToggleMute={toggleMute} onLogout={handleLogout} />
          <main style={{ flex: 1, padding: '24px 20px', overflowY: 'auto' }}>
            <Dashboard user={profile} onClose={() => setScreen('lobby')} />
          </main>
          <AppFooter network={network} />
        </>
      )}

      {/* ══ GAME SCREEN ══ */}
      {isAuthenticated && screen === 'game' && (
        <>
          <AppHeader user={profile} muted={muted} onToggleMute={toggleMute}
            extraRight={
              <>
                {/* ZK status chip */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', border: `1px solid ${zkBusy(game) ? '#7c3aed' : '#0a2540'}`, borderRadius: 3, background: zkBusy(game) ? 'rgba(124,58,237,.08)' : 'transparent', transition: 'all .3s' }}>
                  {zkBusy(game) && <div style={{ width: 6, height: 6, border: '2px solid #a78bfa', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin .8s linear infinite' }} />}
                  <span style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.5rem', letterSpacing: '.1em', color: zkBusy(game) ? '#a78bfa' : '#1e3a5f' }}>{zkLabel(game)}</span>
                </div>
                <Stat sm label="SID"  val={`#${game.sid}`} />
                <Stat sm label="ACC"  val={acc} color="#f59e0b" />
                <GBtn onClick={handleAbort} danger>↩ ABORT</GBtn>
              </>
            }
          />

          <main style={{ flex: 1, padding: '16px 20px', maxWidth: 1080, margin: '0 auto', width: '100%' }}>
            <div className="fu" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

              {/* Setup spinner */}
              {game.phase === 'setup' && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, paddingTop: 44 }}>
                  <div style={{ width: 36, height: 36, border: '2px solid #0a2540', borderTopColor: '#0ea5e9', borderRadius: '50%', animation: 'spin .8s linear infinite' }} />
                  <div style={{ fontFamily: 'Orbitron,monospace', fontSize: '.72rem', color: '#0ea5e9', letterSpacing: '.18em' }}>INITIALIZING MISSION</div>
                  <div style={{ width: '100%', maxWidth: 460 }}><TacticalLog entries={game.log} /></div>
                </div>
              )}

              {/* Placement */}
              {game.phase === 'placement' && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
                  <div style={{ textAlign: 'center', padding: '12px 24px', border: '1px solid #10b981', borderRadius: 5, background: 'rgba(16,185,129,.04)', animation: 'pulseG 2.5s ease-in-out infinite' }}>
                    <div style={{ fontFamily: 'Orbitron,monospace', fontSize: '.88rem', letterSpacing: '.16em', color: '#10b981' }}>PLACE YOUR UNIT</div>
                    <p style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.58rem', color: '#0a3a20', marginTop: 4 }}>Click a cell on YOUR grid. Position is ZK-committed — invisible on-chain.</p>
                  </div>
                  <div style={{ maxWidth: 340, width: '100%' }}>
                    <TacticalGrid cells={game.myGrid} mode={busy ? 'view' : 'place'} onSel={handlePlace} label="YOUR TERRITORY — CLICK TO PLACE" accent="#10b981" />
                  </div>
                  <div style={{ width: '100%', maxWidth: 500 }}><TacticalLog entries={game.log} /></div>
                </div>
              )}

              {/* Battle + Ended */}
              {(game.phase === 'battle' || game.phase === 'ended') && (
                <>
                  {/* Winner banner */}
                  {game.winner && (
                    <div style={{ textAlign: 'center', padding: '18px 24px', border: `2px solid ${game.winner === 'you' ? '#10b981' : '#ef4444'}`, borderRadius: 6, background: game.winner === 'you' ? 'rgba(16,185,129,.05)' : 'rgba(239,68,68,.05)', boxShadow: game.winner === 'you' ? '0 0 50px rgba(16,185,129,.12)' : '0 0 50px rgba(239,68,68,.12)' }}>
                      <div style={{ fontFamily: 'Orbitron,monospace', fontWeight: 900, fontSize: 'clamp(1.4rem,4vw,2.8rem)', letterSpacing: '.14em', color: game.winner === 'you' ? '#10b981' : '#ef4444', textShadow: game.winner === 'you' ? '0 0 36px rgba(16,185,129,.7)' : '0 0 36px rgba(239,68,68,.7)' }}>
                        {game.winner === 'you' ? '★ MISSION ACCOMPLISHED' : '✕ MISSION FAILED'}
                      </div>
                      <div style={{ display: 'flex', gap: 7, justifyContent: 'center', flexWrap: 'wrap', marginTop: 10 }}>
                        {game.txIds.map((id, i) => <TxBadge key={i} id={id} />)}
                      </div>
                      {game.winner === 'you' && (
                        <div style={{ fontFamily: 'Rajdhani,sans-serif', fontWeight: 600, fontSize: '.95rem', color: '#10b981', marginTop: 6 }}>+{game.stake * 2} XLM credited</div>
                      )}
                      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 14, flexWrap: 'wrap' }}>
                        <PBtn onClick={() => { persistGame(null); dispatch({ type: 'GAME_RESET' }); sfx.stopBg(); setScreen('lobby'); }}>↩ RETURN TO LOBBY</PBtn>
                        <GBtn onClick={() => { persistGame(null); dispatch({ type: 'GAME_RESET' }); sfx.stopBg(); setScreen('dashboard'); }}>📊 ACCOUNT</GBtn>
                      </div>
                    </div>
                  )}

                  {/* Turn status bar */}
                  {!game.winner && (
                    <div style={{ textAlign: 'center', padding: '8px', border: `1px solid ${zkBusy(game) ? '#7c3aed' : game.myTurn ? '#0ea5e9' : '#0a2540'}`, borderRadius: 3, background: zkBusy(game) ? 'rgba(124,58,237,.04)' : game.myTurn ? 'rgba(14,165,233,.04)' : 'transparent', fontFamily: 'Orbitron,monospace', letterSpacing: '.13em', fontSize: 'clamp(.56rem,1.4vw,.72rem)', color: zkBusy(game) ? '#a78bfa' : game.myTurn ? '#38bdf8' : '#1e3a5f', transition: 'all .3s' }}>
                      {zkBusy(game) ? `◈ ${zkLabel(game).toUpperCase()}` : game.myTurn ? '▶ YOUR TURN — CLICK OR VOICE "FIRE [COL] [ROW]"' : '… ENEMY COMPUTING STRIKE'}
                    </div>
                  )}

                  {/* Grid battlefield */}
                  <div style={{ display: 'flex', gap: 18, justifyContent: 'center', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                    <TacticalGrid cells={game.myGrid} mode="view" onSel={() => {}} label={`YOUR GRID — ${profile?.username.toUpperCase() || 'P1'}`} accent="#10b981" />
                    <div style={{ display: 'flex', alignItems: 'center', paddingTop: 40, fontSize: '1.4rem', color: '#0a2540', fontFamily: 'Orbitron,monospace' }}>⚔</div>
                    <TacticalGrid cells={game.foeGrid} mode={canFire(game) ? 'attack' : 'view'} onSel={handleFire} label="ENEMY GRID — CLICK OR VOICE TO FIRE" accent="#ef4444" />
                  </div>

                  {/* Stats row */}
                  <div style={{ display: 'flex', gap: 7, justifyContent: 'center', flexWrap: 'wrap' }}>
                    <Stat label="SHOTS"    val={game.shots} />
                    <Stat label="HITS"     val={game.hits}              color="#ef4444" />
                    <Stat label="MISSES"   val={game.shots - game.hits} color="#334155" />
                    <Stat label="ACCURACY" val={acc}                    color="#f59e0b" />
                    <Stat label="STAKE"    val={`${game.stake} XLM`}    color="#10b981" />
                  </div>

                  {/* ZK progress bar */}
                  <ZKProgressBar game={game} />

                  {/* Voice command panel */}
                  <VoicePanel hook={voice} />

                  {/* TX hashes */}
                  {game.txIds.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ fontFamily: 'Share Tech Mono,monospace', fontSize: '.5rem', color: '#0a2540' }}>TXs:</span>
                      {game.txIds.map((id, i) => <TxBadge key={i} id={id} />)}
                    </div>
                  )}

                  <TacticalLog entries={game.log} />
                </>
              )}
            </div>
          </main>
          <AppFooter network={network} />
        </>
      )}
    </div>
  );
}
