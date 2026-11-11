import { AsyncLocalStorage } from "node:async_hooks";
import type { Role } from "@/server/authz/roles";

/**
 * Per-request sign-in decisions.
 *
 * better-auth's `user.validateUserInfo` sees the fresh provider profile (and
 * so the groups claim) but cannot write; the database hooks can write but do
 * not see the profile. The auth route runs every request inside this store, so
 * the gate's decision travels from the one to the other without persisting
 * anything the user could influence (the groups snapshot is never an input
 * field of the user model).
 */

export type SignInEntry = {
  provider: string;
  /** Effective role decided by the gate. */
  role: Role;
  /** Role from the env allowlists alone (stored as User.envRole). */
  envRole: Role | null;
  /** Groups claim; only stored for OIDC sign-ins. */
  groups: string[];
};

type Store = { decisions: Map<string, SignInEntry> };

const storage = new AsyncLocalStorage<Store>();

export function runWithSignInContext<T>(fn: () => T): T {
  return storage.run({ decisions: new Map() }, fn);
}

const key = (email: string) => email.trim().toLowerCase();

export function rememberDecision(email: string, entry: SignInEntry) {
  storage.getStore()?.decisions.set(key(email), entry);
}

export function decisionFor(email: string): SignInEntry | undefined {
  return storage.getStore()?.decisions.get(key(email));
}
