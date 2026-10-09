import type { AidFn } from "@cuas/sim";

/** The classification aid is wired in later (PLAN.md 6.12); until then there is no suggestion. */
export async function loadAid(_mode: "honest" | "unreliable"): Promise<AidFn | undefined> {
  return undefined;
}
