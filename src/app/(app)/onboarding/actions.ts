"use server";

import { revalidatePath } from "next/cache";
import { hasRole } from "@/server/authz/roles";
import { requireScope } from "@/server/better-auth/session";
import { discoverInstallations } from "@/server/ingest/discovery";

/** Re-reads all installations of the App from GitHub (admin only). */
export async function refreshInstallations() {
  const { scope } = await requireScope();
  if (!hasRole(scope.role, "ADMIN")) throw new Error("Not found");
  await discoverInstallations();
  revalidatePath("/onboarding");
  revalidatePath("/dashboard");
}
