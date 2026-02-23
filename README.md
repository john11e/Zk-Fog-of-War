# ⬡ Zero-Shot — ZK Fog-of-War on Stellar

> **Provably fair. Cryptographically private. Every shot verified on-chain.**

Zero-Shot is a turn-based fog-of-war strategy game built on **Stellar Protocol 25 / Soroban**, where every fire action is backed by a **zero-knowledge proof** (Noir UltraHonk + BN254). Neither player can fake a hit, lie about a miss, or reveal their unit position — the chain enforces it all.

---

## 🔗 Live Deployment

| Resource | Link |
|---|---|
| **Hub contract** | `CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG` |
| **Network** | Stellar Testnet — Protocol 25 |
| **Explorer** | [stellar.expert/testnet](https://stellar.expert/explorer/testnet) |

---

## 🧠 How It Works

### Game Flow
1. **Security Gate** — players pass a 3-stage lock: age verification → Terms of Service → wallet connection (Freighter or generated address)
2. **Auth** — Auth0 handles login/signup with real email verification; verified accounts start with 500 XLM, demo accounts with 200 XLM
3. **Lobby** — player sets a stake (1–50 XLM) and deploys the mission
4. **Placement** — each player secretly places one unit on a 6×6 grid; the position is committed on-chain as `Poseidon(position, salt)` — invisible to the opponent
5. **Battle** — players alternate firing at coordinates; each shot generates a full ZK proof
6. **Resolution** — the first player whose unit is hit loses; winnings are credited automatically

### ZK Proof Lifecycle (per shot)
```
IDLE
 → WITNESS_GENERATION    private input: position + Poseidon salt
 → CIRCUIT_COMPILATION   Noir UltraHonk circuit loaded
 → PROOF_GENERATION      BN254 proof bytes produced
 → ON_CHAIN_VERIFICATION hub.verify_shot() called on Soroban
 → VERIFICATION_SUCCESS  result is authoritative — shot applied
   | VERIFICATION_FAILURE  proof rejected — turn restored, retry allowed
```

The entire proof state is displayed live to the player via the **ZK Progress Bar** in the game UI.

---

## 🏗 Architecture

```
ZK-Fog-of-War/
├── contracts/              Soroban smart contract (Rust)
│   ├── src/lib.rs          hub contract: start_game, end_game, verify_shot
│   └── Cargo.toml
├── circuits/               Zero-knowledge circuits
│   └── src/main.nr         Noir UltraHonk fog-of-war circuit
├── src/                    React frontend
│   ├── main.tsx            Auth0Provider entry point
│   └── App.tsx             Full game client (1,900+ lines, 21 sections)
├── game_hub.wasm           Compiled Soroban contract
├── .env.example            Environment variable template
└── README.md
```

### Frontend Sections (`App.tsx`)

| Section | Description |
|---|---|
| §2 | TypeScript interfaces for all game/ZK/user/voice types |
| §7 | `gameReducer` — pure reducer, all state via typed `GameAction` dispatch |
| §8–§9 | `parseVoice` + `useSpeechRecognition` — Web Speech API hook |
| §12 | `SecurityGate` — 3-stage multi-lock with glow animations |
| §13 | `TacticalGrid` — fog-of-war grid with cell state machine |
| §15 | `ZKProgressBar` — live ZK proof stage visualiser |
| §16 | `VoicePanel` — voice command UI with pulse indicator |
| §17 | `Dashboard` — TX history, stats, identity panel |
| §19 | `AppFooter` — subtle Network Status chip (no intrusive banners) |
| §21 | Root `App` — Auth0 context, game loop, fire/place/abort handlers |

---

## 🛠 Tech Stack

| Layer | Technology |
|---|---|
| **Blockchain** | Stellar Protocol 25 |
| **Smart Contract** | Soroban (Rust) |
| **ZK Circuits** | Noir Language + UltraHonk proving system |
| **ZK Verifier** | BN254 elliptic curve pairing |
| **Hash Function** | Poseidon (ZK-friendly, used for unit commitments) |
| **Frontend** | React 18 + TypeScript + Vite |
| **State Management** | `useReducer` with discriminated union `GameAction` |
| **Authentication** | Auth0 (SPA) — real email verification, session persistence |
| **Wallet** | Freighter browser extension + fallback generated address |
| **Voice Commands** | Web Speech API — NATO phonetic parsing |
| **Sound** | Procedural Web Audio API — zero external files |
| **Game Alerts** | EmailJS — in-game tactical email notifications |
| **Styling** | Inline CSS-in-JS — Orbitron + Share Tech Mono + Rajdhani fonts |

---

## ⚡ Quick Start

### Prerequisites
- Node 18+ or Bun
- Rust + `wasm-pack` (for contract compilation)
- [Nargo](https://noir-lang.org) (for circuit compilation)
- [Freighter](https://freighter.app) wallet extension (optional)

### 1 — Clone & install
```bash
git clone https://github.com/your-username/ZK-Fog-of-War.git
cd ZK-Fog-of-War
npm install
```

### 2 — Configure environment
```bash
cp .env.example .env
```

Open `.env` and fill in:

```env
# Required — Auth0 (https://auth0.com)
VITE_AUTH0_DOMAIN=your-tenant.auth0.com
VITE_AUTH0_CLIENT_ID=your_client_id

# Optional — Stellar network
VITE_STELLAR_NETWORK=testnet

# Optional — EmailJS in-game alerts (https://emailjs.com)
VITE_EJS_SERVICE=service_xxxxxxx
VITE_EJS_TEMPLATE=template_xxxxxxx
VITE_EJS_PUBKEY=your_public_key
```

### 3 — Auth0 setup (5 minutes)
1. Create a free account at [auth0.com](https://auth0.com)
2. Create an application → **Single Page Application**
3. Under **Settings**, add to all three URL fields:
   ```
   http://localhost:5173
   ```
4. Under **Authentication → Database**, enable **Email + Password**
5. (Recommended) Enable **Require Email Verification**
6. Copy **Domain** and **Client ID** into your `.env`

### 4 — Run the frontend
```bash
npm run dev
# or
bun run dev
```

Visit `http://localhost:5173`

### 5 — Compile the Soroban contract (optional — wasm already included)
```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
```

### 6 — Compile the Noir circuit (optional)
```bash
cd circuits
nargo compile
nargo prove
```

---

## 🎮 Voice Commands

The game supports hands-free play via the **Web Speech API**. Click **ACTIVATE** in the Voice Commands panel during battle.

| Say | Action |
|---|---|
| `"Fire Alpha 4"` | Fire at cell A4 |
| `"Fire Bravo 2"` | Fire at cell B2 |
| `"Shoot Charlie 5"` | Fire at cell C5 |
| `"Attack Delta 1"` | Fire at cell D1 |
| `"Abort"` | Abort the current game |

NATO phonetic alphabet supported for columns A–F. Numbers can be spoken as words (`"four"`) or digits (`"4"`).

---

## 📧 EmailJS Alert Templates

If you configure EmailJS, the following in-game emails are sent (rate-limited to one per event per 60 seconds):

| Alert type | Trigger |
|---|---|
| `ENEMY ATTACK` | Enemy fires a shot at your grid |
| `GAME WON` | You win — includes prize amount |
| `GAME LOST` | You lose — session summary |
| `LOW BALANCE` | Balance drops below 20 XLM |

Your EmailJS template must include these variables:
```
{{to_email}}  {{username}}  {{alert_type}}  {{session_id}}  {{detail}}
```

---

## 🔐 Auth & Account Types

| Feature | Demo Account | Verified Account |
|---|---|---|
| Login method | Auth0 (any) | Auth0 + email verification |
| Starting balance | 200 XLM | 500 XLM |
| Identity badge | 🎮 DEMO | 🔐 VERIFIED |
| TX history | ✓ | ✓ |
| Wallet | Generated address | Freighter or generated |

---

## 💰 Stake Safety

- Maximum stake: **50 XLM per game**
- Stake is deducted at game start and flagged `stakeDeducted: true`
- If the page is refreshed mid-game, the stake is **automatically refunded** on next load
- Aborting a game via the **↩ ABORT** button refunds the stake immediately
- Winnings (2× stake) are credited only after on-chain `end_game` confirmation

---

## 📁 Repository Structure for Judges

```
ZK-Fog-of-War/
├── README.md              ← you are here
├── BUIDL.md               ← pitch summary
├── .env.example           ← environment variable template
├── .gitignore
├── package.json
├── vite.config.ts
│
├── contracts/             ← Soroban smart contract
│   ├── src/lib.rs
│   └── Cargo.toml
│
├── circuits/              ← Noir ZK circuit
│   └── src/main.nr
│
├── src/                   ← React frontend
│   ├── App.tsx            (1,910 lines — 21 annotated sections)
│   └── main.tsx
│
└── game_hub.wasm          ← compiled contract artifact
```

---

## 🧪 Testing Checklist

- [ ] Security gate: all 3 stages must be completed before proceeding
- [ ] Auth0 login and registration flow works
- [ ] Email verification badge appears for verified accounts
- [ ] Stake deducted on game start, refunded on abort
- [ ] Placement: clicking own grid places unit with ZK commitment
- [ ] Battle: firing runs through all 5 ZK proof stages visibly
- [ ] Voice: `"Fire Alpha 4"` triggers the correct cell
- [ ] Enemy AI fires back after player miss
- [ ] Win/loss updates TX history and balance correctly
- [ ] Network status chip shows in footer (Mainnet/Testnet)
- [ ] Page refresh during battle restores the session
- [ ] Page refresh during placement refunds stake

---

## 📜 License

MIT — see `LICENSE` for details.

---

## 👥 Team

| Name | Role |
|---|---|
| *(your name)* | Full-stack + ZK circuits |
| *(co-builder)* | Smart contract + Soroban |

---

*Built for the Stellar Protocol 25 Hackathon. All XLM in this demo is testnet currency.*
