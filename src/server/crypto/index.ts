import "server-only";
import { env } from "@/env";
import { createKeyRing, type KeyRing } from "./keyring";

let ring: KeyRing | undefined;

/** The instance key ring from TOKEN_ENCRYPTION_KEY(_PREVIOUS). */
export function tokenKeyRing(): KeyRing {
  ring ??= createKeyRing(
    env.TOKEN_ENCRYPTION_KEY,
    env.TOKEN_ENCRYPTION_KEY_PREVIOUS,
  );
  return ring;
}

export function encryptToken(plaintext: string, aad: string): string {
  return tokenKeyRing().encrypt(plaintext, aad);
}

export function decryptToken(ciphertext: string, aad: string): string {
  return tokenKeyRing().decrypt(ciphertext, aad);
}
