#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env, Bytes, Vec, String};

mod hub {
    soroban_sdk::contractimport!(file = "../game_hub.wasm");
}

#[contract]
pub struct ZKStrategyGame;

#[contractimpl]
impl ZKStrategyGame {
    pub fn start_game(
        env: Env,
        player1: Address,
        player2: Address,
        session_id: u32,
        player1_points: i128,
        player2_points: i128,
    ) {
        player1.require_auth();
        let hub_addr = Address::from_string(&String::from_str(&env, "CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG"));
        let hub_client = hub::Client::new(&env, &hub_addr);
        hub_client.start_game(
            &env.current_contract_address(), // game_id = this contract
            &session_id,
            &player1,
            &player2,
            &player1_points,
            &player2_points,
        );
    }

    pub fn verify_miss(_env: Env, _proof: Bytes, _public_inputs: Vec<Bytes>) {
        // ZK Verification Logic
    }

    pub fn end_game(env: Env, session_id: u32, player1_won: bool) {
        let hub_addr = Address::from_string(&String::from_str(&env, "CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG"));
        let hub_client = hub::Client::new(&env, &hub_addr);
        hub_client.end_game(&session_id, &player1_won);
    }
}
