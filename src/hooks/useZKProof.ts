import { Noir } from "@noir-lang/noir_js";
import { UltraHonkBackend } from "@aztec/bb.js";
import circuit from "../../circuits/target/zero_shot.json";

export const useZKProof = () => {
  const generateProof = async (secretPos: {x: number, y: number}, attackPos: {x: number, y: number}, salt: string) => {
    const noir = new Noir(circuit);
    const backend = new UltraHonkBackend(circuit.bytecode);

    // Inputs must match the Noir circuit parameters
    const inputs = {
      secret_x: secretPos.x,
      secret_y: secretPos.y,
      salt: salt,
      attack_x: attackPos.x,
      attack_y: attackPos.y,
      commitment: localStorage.getItem('zk_commitment') // Stored during start_game
    };

    const { witness } = await noir.execute(inputs);
    const proof = await backend.generateProof(witness);
    return proof;
  };

  return { generateProof };
};