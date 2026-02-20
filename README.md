# Zero-Shot: ZK Fog-of-War on Stellar

**Zero-Shot** is a minimal tactical strategy prototype built for the Stellar ZK Gaming Hackathon. It utilizes **Protocol 25 (X-Ray)** host functions to enable high-performance, private-state gameplay.

## 🚀 ZK Mechanic: Provable Hidden Position
In traditional on-chain games, unit positions are public. In **Zero-Shot**, positions are committed as a Poseidon hash. 
- **The Player** proves they weren't hit by providing a ZK-SNARK.
- **The Contract** verifies the proof using native `BN254` operations.
- **The Result:** Hidden information is possible on Stellar without a centralized server.

## 🛠 Tech Stack
- **ZK Circuit:** Noir (UltraHonk)
- **Smart Contracts:** Soroban (Rust)
- **Frontend:** Stellar Game Studio + Bun + React
- **Blockchain:** Stellar Testnet (Protocol 25)

## 📦 Project Structure
- `/circuits`: Noir source code for the "Miss Proof".
- `/contracts`: Soroban smart contracts (interfacing with Hub `CB4VZ...`).
- `/src`: React frontend using Stellar Game Studio hooks.

## 🏃 Quick Start
1. `bun install`
2. `bun run build` (Compiles Noir & Soroban)
3. `bun run deploy` (Deploys to Testnet)
4. `npm start` (Launch UI)

## 🔗 Hub Integration
Successfully calls `start_game()` and `end_game()` on contract:
`CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG`