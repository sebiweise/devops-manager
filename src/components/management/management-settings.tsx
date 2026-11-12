"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { ResultLike } from "@/lib/management-view";
import {
  setManagementEnabledAction,
  setVariableRedactionAction,
} from "@/server/actions/management";
import {
  ActionDialog,
  ResultMessage,
  type DialogControls,
} from "./action-dialog";

/**
 * Installation settings (admin, design §8.2 #12): the per-installation
 * management toggle and the variable-value redaction setting, each behind a
 * confirmation dialog and audited. Both work while management is off, so
 * an admin can turn it on; the global kill switch MANAGEMENT_ENABLED=false
 * blocks them as well, so the buttons are hidden then.
 */

type Setting = "management" | "redaction";

function TogglePanel({
  installationId,
  setting,
  enable,
  controls,
}: {
  installationId: string;
  setting: Setting;
  enable: boolean;
  controls: DialogControls;
}) {
  const t = useTranslations("management.settings");
  const [key] = useState(() => crypto.randomUUID());
  const [result, setResult] = useState<ResultLike>();
  const [pending, startTransition] = useTransition();
  const done = result?.status === "succeeded";
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          try {
            const action =
              setting === "management"
                ? setManagementEnabledAction
                : setVariableRedactionAction;
            const res = await action({
              installationId,
              enabled: enable,
              confirmed: true,
              idempotencyKey: key,
            });
            setResult(res);
            if (res.status === "succeeded") controls.changed();
          } catch {
            setResult({ status: "error" });
          }
        });
      }}
    >
      <p className="text-sm">
        {t(`${setting}.${enable ? "confirmOn" : "confirmOff"}`)}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          size="sm"
          variant={enable && setting === "management" ? "default" : "outline"}
          disabled={pending || done}
        >
          {t(`${setting}.${enable ? "turnOn" : "turnOff"}`)}
        </Button>
        <ResultMessage result={result} />
      </div>
    </form>
  );
}

export function ManagementSettings({
  installationId,
  globalEnabled,
  managementEnabled,
  redactVariableValues,
}: {
  installationId: string;
  globalEnabled: boolean;
  managementEnabled: boolean;
  redactVariableValues: boolean;
}) {
  const t = useTranslations("management.settings");
  const rows: Array<{ setting: Setting; on: boolean }> = [
    { setting: "management", on: managementEnabled },
    { setting: "redaction", on: redactVariableValues },
  ];
  return (
    <div className="flex flex-col gap-4">
      {rows.map(({ setting, on }) => (
        <section
          key={setting}
          aria-labelledby={`setting-${setting}`}
          className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3"
        >
          <div className="flex max-w-prose flex-col gap-1">
            <h3 id={`setting-${setting}`} className="font-medium">
              {t(`${setting}.label`)}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t(`${setting}.description`)}
            </p>
            <p className="text-sm">
              {on ? t("stateOn") : t("stateOff")}
              {setting === "management" && !globalEnabled
                ? ` ${t("globalOff")}`
                : ""}
            </p>
          </div>
          {globalEnabled ? (
            <ActionDialog
              trigger={t(`${setting}.${on ? "turnOff" : "turnOn"}`)}
              title={t(`${setting}.label`)}
            >
              {(controls) => (
                <TogglePanel
                  installationId={installationId}
                  setting={setting}
                  enable={!on}
                  controls={controls}
                />
              )}
            </ActionDialog>
          ) : null}
        </section>
      ))}
    </div>
  );
}
