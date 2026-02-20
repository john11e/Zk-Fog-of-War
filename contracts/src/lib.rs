#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env, Bytes, Vec, symbol_short};

// Import the required Game Hub
mod hub {
    soroban_sdk::contractimport!(file = "./game_hub.wasm");
}

#[contract]
pub struct ZKStrategyGame;

#[contractimpl]
impl ZKStrategyGame {
    pub fn start_game(env: Env, player: Address) {
        player.require_auth();
        
        // REQUIRED: Register with the Hackathon Hub
        let hub_addr = Address::from_string(&env.string("CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG"));
        let hub_client = hub::Client::new(&env, &hub_addr);
        hub_client.start_game(&env.current_contract_address());
    }

    pub fn verify_miss(env: Env, proof: Bytes, public_inputs: Vec<Bytes>) {
        // Use Protocol 25 native BN254 host functions
        // This validates the Noir UltraHonk proof efficiently
        env.crypto().bn254_verify(&proof, &public_inputs);
        
        // If it passes, the game state continues. If it fails, tx reverts.
    }

    pub fn end_game(env: Env, winner: Address) {
        let hub_addr = Address::from_string(&env.string("CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG"));
        let hub_client = hub::Client::new(&env, &hub_addr);
        hub_client.end_game(&winner);
    }
}