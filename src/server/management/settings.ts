import "server-only";
import {
  beginAction,
  defaultActionDeps,
  type ActionActor,
  type ActionDeps,
  type ActionResult,
} from "@/server/authz/action";
import { updateManagementSettings } from "@/server/data/management";

/**
 * Per-installation management settings (design §8.2 #12), admin only, local
 * (no GitHub call): the management toggle (MANAGEMENT_TOGGLE, off by
 * default) and the variable-value redaction setting (SETTINGS_UPDATE). Both
 * go through the same pipeline and work while the installation's management
 * is off; the global kill switch MANAGEMENT_ENABLED=false blocks them too.
 */

type ToggleInput = {
  installationId: bigint;
  enabled: boolean;
  confirmed: boolean;
  idempotencyKey: string;
};

async function updateSetting(
  actor: ActionActor,
  input: ToggleInput,
  setting: "managementEnabled" | "redactVariableValues",
  deps: ActionDeps,
): Promise<ActionResult<{ enabled: boolean }>> {
  const begun = await beginAction(
    actor,
    {
      installationId: input.installationId,
      action:
        setting === "managementEnabled"
          ? "MANAGEMENT_TOGGLE"
          : "SETTINGS_UPDATE",
      role: "ADMIN",
      idempotencyKey: input.idempotencyKey,
      target: { type: "installation", id: String(input.installationId) },
      confirmation: "DIALOG",
      requiresManagement: false,
    },
    deps,
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;
  if (!session.confirm({ kind: "DIALOG", confirmed: input.confirmed }))
    return { status: "confirmation_mismatch" };
  const before = session.installation[setting];
  if (before === input.enabled)
    return { status: "refused", reason: "unchanged" };
  const row = await session.record({
    params: { setting, before, after: input.enabled },
  });
  if (!row.created)
    return { status: "pending", auditId: row.id, replayed: true };
  const outcome = await session.perform(row.id, async () => {
    await updateManagementSettings(actor.scope, input.installationId, {
      [setting]: input.enabled,
    });
    return { data: { enabled: input.enabled } };
  });
  session.revalidate();
  return outcome;
}

export async function setManagementEnabled(
  actor: ActionActor,
  input: ToggleInput,
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult<{ enabled: boolean }>> {
  return updateSetting(actor, input, "managementEnabled", deps);
}

export async function setVariableRedaction(
  actor: ActionActor,
  input: ToggleInput,
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult<{ enabled: boolean }>> {
  return updateSetting(actor, input, "redactVariableValues", deps);
}
