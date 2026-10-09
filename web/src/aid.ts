import { makeAid, type AidFn, type AidModel } from "@cuas/sim";

/** Load the trained classification aid (content/aid/model.json via the API). */
export async function loadAid(mode: "honest" | "unreliable"): Promise<AidFn | undefined> {
  const res = await fetch("/api/aid/model");
  if (!res.ok) return undefined;
  const model = (await res.json()) as AidModel;
  return makeAid(model, mode);
}
