import { makeAid, type AidFn } from "@cuas/sim";
import { api } from "./api.ts";

/** Load the trained classification aid (content/aid/model.json via the API). */
export async function loadAid(mode: "honest" | "unreliable"): Promise<AidFn | undefined> {
  try {
    return makeAid(await api.aidModel(), mode);
  } catch {
    return undefined;
  }
}
