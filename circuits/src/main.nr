use dep::std;

// This circuit proves: "I know a secret (x, y) that hashes to 'commitment', 
// and that (x, y) is NOT the same as the 'attack_coords'."
fn main(
    secret_x: u8,           // Private: Player's hidden unit X
    secret_y: u8,           // Private: Player's hidden unit Y
    salt: Field,            // Private: To prevent brute-forcing small coordinates
    attack_x: pub u8,       // Public: Coordinate being attacked
    attack_y: pub u8,       // Public: Coordinate being attacked
    commitment: pub Field   // Public: Hash of (x, y, salt) stored on-chain
) {
    // 1. Check if the attack actually missed
    // If secret_x == attack_x AND secret_y == attack_y, this will fail
    let is_hit = (secret_x == attack_x) & (secret_y == attack_y);
    assert(is_hit == false);

    // 2. Verify that the secret position matches the on-chain commitment
    // We use Poseidon because Stellar Protocol 25 has native host functions for it
    let hash = std::hash::poseidon::bn254::hash_3([secret_x as Field, secret_y as Field, salt]);
    assert(hash == commitment);
}