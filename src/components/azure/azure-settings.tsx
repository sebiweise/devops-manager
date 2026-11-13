"use client";

import { useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import {
  ActionDialog,
  type DialogControls,
} from "@/components/management/action-dialog";
import { Button } from "@/components/ui/button";
import type { AzureResultLike } from "@/lib/azure-view";
import {
  connectAzureAction,
  disconnectAzureAction,
  installAzureHooksAction,
  linkAzureDefinitionAction,
  rotateAzureAction,
  rotateAzureHookSecretAction,
  selectAzureProjectsAction,
  setAzureDefinitionOsServerAction,
  updateAzureLimitsAction,
} from "@/server/actions/azure";
import { AzureResult } from "./azure-actions";

/**
 * The admin controls of "CI · Azure DevOps" (design addendum M7 §3):
 * Connect and Rotate with an organisation-scoped PAT or a Microsoft Entra
 * service principal (tenant id, client id, client secret; password fields,
 * never echoed), Disconnect (type the organisation name), the project
 * selection, the definition links and OS overrides, the limits (with
 * "adopt detected"), and the service hook credentials (shown once). Every
 * control is a confirmation dialog with a fresh idempotency key.
 */

const input = "h-9 rounded-md border bg-background px-2 font-mono text-sm";
const label = "flex flex-col gap-1 text-sm";

export function CredentialForm({
  installationId,
  mode,
  orgName,
  currentKind,
  controls,
}: {
  installationId: string;
  mode: "connect" | "rotate";
  orgName?: string;
  currentKind?: "PAT" | "ENTRA_SP" | "ENV";
  controls: DialogControls;
}) {
  const t = useTranslations("ci.azure.settings");
  const [key] = useState(() => crypto.randomUUID());
  const [org, setOrg] = useState(orgName ?? "");
  const [kind, setKind] = useState<"PAT" | "ENTRA_SP">(
    currentKind === "ENTRA_SP" ? "ENTRA_SP" : "PAT",
  );
  const [pat, setPat] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [result, setResult] = useState<AzureResultLike>();
  const [pending, startTransition] = useTransition();
  const id = useId();
  const done = result?.status === "succeeded";
  const ready =
    (mode === "rotate" || org.trim()) &&
    (kind === "PAT"
      ? pat.trim()
      : tenantId.trim() && clientId.trim() && secret.trim());
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          try {
            const action =
              mode === "connect" ? connectAzureAction : rotateAzureAction;
            const res = await action({
              installationId,
              org: mode === "connect" ? org.trim() : undefined,
              authKind: kind,
              ...(kind === "PAT"
                ? { pat }
                : { tenantId, clientId, clientSecret: secret }),
              expiresAt: expiresAt || null,
              confirmed: true,
              idempotencyKey: key,
            });
            setResult(res);
            // Secrets leave the form state as soon as they were sent.
            setPat("");
            setSecret("");
            if (res.status === "succeeded") controls.changed();
          } catch {
            setResult({ status: "error" });
          }
        });
      }}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t("authKind")}</legend>
        {(["PAT", "ENTRA_SP"] as const).map((k) => (
          <label key={k} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={`${id}-kind`}
              value={k}
              checked={kind === k}
              onChange={() => setKind(k)}
              className="mt-1"
            />
            <span className="flex flex-col">
              <span>{t(`kind.${k}`)}</span>
              <span className="text-xs text-muted-foreground">
                {t(`kindHint.${k}`)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {kind === "PAT" ? (
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>{t("steps.pat1")}</li>
          <li>{t("steps.pat2")}</li>
          <li>{t("steps.pat3")}</li>
        </ol>
      ) : (
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>{t("steps.sp1")}</li>
          <li>{t("steps.sp2")}</li>
          <li>{t("steps.sp3")}</li>
        </ol>
      )}
      {mode === "connect" ? (
        <label htmlFor={`${id}-org`} className={label}>
          <span className="font-medium">{t("org")}</span>
          <span className="text-xs text-muted-foreground">{t("orgHint")}</span>
          <input
            id={`${id}-org`}
            type="text"
            autoComplete="off"
            spellCheck={false}
            required
            maxLength={200}
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            placeholder="example-org"
            className={input}
          />
        </label>
      ) : null}
      {kind === "PAT" ? (
        <label htmlFor={`${id}-pat`} className={label}>
          <span className="font-medium">{t("pat")}</span>
          <input
            id={`${id}-pat`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            maxLength={512}
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            className={input}
          />
        </label>
      ) : (
        <>
          <label htmlFor={`${id}-tenant`} className={label}>
            <span className="font-medium">{t("tenantId")}</span>
            <input
              id={`${id}-tenant`}
              type="text"
              autoComplete="off"
              spellCheck={false}
              required
              maxLength={100}
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              className={input}
            />
          </label>
          <label htmlFor={`${id}-client`} className={label}>
            <span className="font-medium">{t("clientId")}</span>
            <input
              id={`${id}-client`}
              type="text"
              autoComplete="off"
              spellCheck={false}
              required
              maxLength={100}
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              className={input}
            />
          </label>
          <label htmlFor={`${id}-secret`} className={label}>
            <span className="font-medium">{t("clientSecret")}</span>
            <input
              id={`${id}-secret`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              required
              maxLength={512}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className={input}
            />
          </label>
        </>
      )}
      <label htmlFor={`${id}-exp`} className={label}>
        <span className="font-medium">{t("expiresAt")}</span>
        <span className="text-xs text-muted-foreground">
          {t("expiresAtHint")}
        </span>
        <input
          id={`${id}-exp`}
          type="date"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
          className={input}
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending || done || !ready}>
          {mode === "connect" ? t("connect") : t("rotate")}
        </Button>
        <AzureResult result={result} />
      </div>
    </form>
  );
}

export function AzureCredentialButton(props: {
  installationId: string;
  mode: "connect" | "rotate";
  orgName?: string;
  currentKind?: "PAT" | "ENTRA_SP" | "ENV";
}) {
  const t = useTranslations("ci.azure.settings");
  return (
    <ActionDialog
      trigger={props.mode === "connect" ? t("connect") : t("rotate")}
      triggerVariant={props.mode === "connect" ? "default" : "outline"}
      title={props.mode === "connect" ? t("connectTitle") : t("rotateTitle")}
    >
      {(controls) => <CredentialForm {...props} controls={controls} />}
    </ActionDialog>
  );
}

export function DisconnectForm({
  installationId,
  orgName,
  hasHooks,
  controls,
}: {
  installationId: string;
  orgName: string;
  hasHooks: boolean;
  controls: DialogControls;
}) {
  const t = useTranslations("ci.azure.settings");
  const tm = useTranslations("management");
  const [key] = useState(() => crypto.randomUUID());
  const [typed, setTyped] = useState("");
  const [hooks, setHooks] = useState(hasHooks);
  const [result, setResult] = useState<AzureResultLike>();
  const [pending, startTransition] = useTransition();
  const id = useId();
  const done = result?.status === "succeeded";
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          try {
            const res = await disconnectAzureAction({
              installationId,
              typed,
              deleteHooks: hooks,
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
      <p className="text-sm">{t("disconnectText")}</p>
      {hasHooks ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={hooks}
            onChange={(e) => setHooks(e.target.checked)}
          />
          {t("disconnectHooks")}
        </label>
      ) : null}
      <label htmlFor={id} className={label}>
        <span>{tm("typeToConfirm", { text: orgName })}</span>
        <input
          id={id}
          type="text"
          autoComplete="off"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className={input}
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          size="sm"
          variant="destructive"
          disabled={pending || done || typed.trim() !== orgName}
        >
          {t("disconnect")}
        </Button>
        <AzureResult result={result} />
      </div>
    </form>
  );
}

export function AzureDisconnectButton(props: {
  installationId: string;
  orgName: string;
  hasHooks: boolean;
}) {
  const t = useTranslations("ci.azure.settings");
  return (
    <ActionDialog trigger={t("disconnect")} title={t("disconnectTitle")}>
      {(controls) => <DisconnectForm {...props} controls={controls} />}
    </ActionDialog>
  );
}

type Project = {
  id: string;
  name: string;
  visibility: string;
  selected: boolean;
};

export function ProjectsForm({
  installationId,
  projects,
  controls,
}: {
  installationId: string;
  projects: ReadonlyArray<Project>;
  controls: DialogControls;
}) {
  const t = useTranslations("ci.azure.settings");
  const [key] = useState(() => crypto.randomUUID());
  const [chosen, setChosen] = useState(
    () => new Set(projects.filter((p) => p.selected).map((p) => p.id)),
  );
  const [result, setResult] = useState<AzureResultLike>();
  const [pending, startTransition] = useTransition();
  const done = result?.status === "succeeded";
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          try {
            const res = await selectAzureProjectsAction({
              installationId,
              projectIds: [...chosen],
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
      <p className="text-sm">{t("projectsText")}</p>
      <fieldset className="flex max-h-72 flex-col gap-1 overflow-y-auto">
        <legend className="sr-only">{t("projectsTitle")}</legend>
        {projects.map((p) => (
          <label key={p.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={chosen.has(p.id)}
              onChange={(e) => {
                const next = new Set(chosen);
                if (e.target.checked) next.add(p.id);
                else next.delete(p.id);
                setChosen(next);
              }}
            />
            <span>{p.name}</span>
            <span className="text-xs text-muted-foreground">
              {t(
                `visibility.${p.visibility === "public" ? "public" : "private"}`,
              )}
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending || done}>
          {t("save")}
        </Button>
        <AzureResult result={result} />
      </div>
    </form>
  );
}

export function AzureProjectsButton(props: {
  installationId: string;
  projects: ReadonlyArray<Project>;
}) {
  const t = useTranslations("ci.azure.settings");
  return (
    <ActionDialog
      trigger={t("projectsEdit")}
      triggerSize="xs"
      title={t("projectsTitle")}
    >
      {(controls) => <ProjectsForm {...props} controls={controls} />}
    </ActionDialog>
  );
}

type Definition = {
  projectId: string;
  id: number;
  name: string;
  manualRepositoryId: string | null;
  osOverride: string | null;
};

export function DefinitionForm({
  installationId,
  definition,
  repositories,
  controls,
}: {
  installationId: string;
  definition: Definition;
  repositories: ReadonlyArray<{ id: string; fullName: string }>;
  controls: DialogControls;
}) {
  const t = useTranslations("ci.azure.settings");
  const [linkKey] = useState(() => crypto.randomUUID());
  const [osKey] = useState(() => crypto.randomUUID());
  const [repo, setRepo] = useState(definition.manualRepositoryId ?? "");
  const [os, setOs] = useState(definition.osOverride ?? "");
  const [result, setResult] = useState<AzureResultLike>();
  const [pending, startTransition] = useTransition();
  const id = useId();
  const done = result?.status === "succeeded";
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          try {
            let res: AzureResultLike = {
              status: "refused",
              reason: "unchanged",
            };
            if ((definition.manualRepositoryId ?? "") !== repo)
              res = await linkAzureDefinitionAction({
                installationId,
                projectId: definition.projectId,
                definitionId: definition.id,
                repositoryId: repo || null,
                confirmed: true,
                idempotencyKey: linkKey,
              });
            if (
              (definition.osOverride ?? "") !== os &&
              (res.status === "succeeded" || res.reason === "unchanged")
            )
              res = await setAzureDefinitionOsServerAction({
                installationId,
                projectId: definition.projectId,
                definitionId: definition.id,
                os: (os || null) as "LINUX" | "WINDOWS" | "MACOS" | null,
                confirmed: true,
                idempotencyKey: osKey,
              });
            setResult(res);
            if (res.status === "succeeded") controls.changed();
          } catch {
            setResult({ status: "error" });
          }
        });
      }}
    >
      <p className="text-sm">{t("linkText", { pipeline: definition.name })}</p>
      <label htmlFor={`${id}-repo`} className={label}>
        <span className="font-medium">{t("linkRepository")}</span>
        <select
          id={`${id}-repo`}
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">{t("linkAutomatic")}</option>
          {repositories.map((r) => (
            <option key={r.id} value={r.id}>
              {r.fullName}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={`${id}-os`} className={label}>
        <span className="font-medium">{t("osOverride")}</span>
        <select
          id={`${id}-os`}
          value={os}
          onChange={(e) => setOs(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">{t("osAutomatic")}</option>
          {(["LINUX", "WINDOWS", "MACOS"] as const).map((o) => (
            <option key={o} value={o}>
              {t(`os.${o}`)}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending || done}>
          {t("save")}
        </Button>
        <AzureResult result={result} />
      </div>
    </form>
  );
}

export function AzureDefinitionButton(props: {
  installationId: string;
  definition: Definition;
  repositories: ReadonlyArray<{ id: string; fullName: string }>;
}) {
  const t = useTranslations("ci.azure.settings");
  return (
    <ActionDialog
      trigger={t("linkEdit")}
      triggerLabel={t("linkEditFor", { pipeline: props.definition.name })}
      triggerSize="xs"
      title={t("linkTitle", { pipeline: props.definition.name })}
    >
      {(controls) => <DefinitionForm {...props} controls={controls} />}
    </ActionDialog>
  );
}

type Limits = {
  hostedParallelJobs: number;
  includedMinutes: number | null;
  maxJobMinutes: number;
  monthResetDay: number;
  blockWhenQuotaExhausted: boolean;
};

export function LimitsForm({
  installationId,
  limits,
  detected,
  controls,
}: {
  installationId: string;
  limits: Limits;
  detected: {
    totalMinutes: number | null;
    totalCount: number | null;
    isPremium: boolean | null;
  } | null;
  controls: DialogControls;
}) {
  const t = useTranslations("ci.azure.settings.limits");
  const [key] = useState(() => crypto.randomUUID());
  const [parallel, setParallel] = useState(String(limits.hostedParallelJobs));
  const [paid, setPaid] = useState(limits.includedMinutes == null);
  const [minutes, setMinutes] = useState(
    String(limits.includedMinutes ?? 1800),
  );
  const [cap, setCap] = useState(String(limits.maxJobMinutes));
  const [reset, setReset] = useState(String(limits.monthResetDay));
  const [block, setBlock] = useState(limits.blockWhenQuotaExhausted);
  const [result, setResult] = useState<AzureResultLike>();
  const [pending, startTransition] = useTransition();
  const id = useId();
  const done = result?.status === "succeeded";
  const submit = (adopt: boolean) =>
    startTransition(async () => {
      try {
        const res = await updateAzureLimitsAction({
          installationId,
          ...(adopt
            ? { adopt: true }
            : {
                limits: {
                  hostedParallelJobs: Number(parallel),
                  includedMinutes: paid ? null : Number(minutes),
                  maxJobMinutes: Number(cap),
                  monthResetDay: Number(reset),
                  blockWhenQuotaExhausted: block,
                },
              }),
          confirmed: true,
          idempotencyKey: key,
        });
        setResult(res);
        if (res.status === "succeeded") controls.changed();
      } catch {
        setResult({ status: "error" });
      }
    });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit(false);
      }}
    >
      <p className="text-sm text-muted-foreground">{t("text")}</p>
      <label htmlFor={`${id}-p`} className={label}>
        <span className="font-medium">{t("parallel")}</span>
        <input
          id={`${id}-p`}
          type="number"
          min={0}
          max={1000}
          value={parallel}
          onChange={(e) => setParallel(e.target.value)}
          className={input}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={paid}
          onChange={(e) => setPaid(e.target.checked)}
        />
        {t("paid")}
      </label>
      {!paid ? (
        <label htmlFor={`${id}-m`} className={label}>
          <span className="font-medium">{t("included")}</span>
          <input
            id={`${id}-m`}
            type="number"
            min={0}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            className={input}
          />
        </label>
      ) : null}
      <label htmlFor={`${id}-c`} className={label}>
        <span className="font-medium">{t("maxJob")}</span>
        <input
          id={`${id}-c`}
          type="number"
          min={1}
          max={4320}
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          className={input}
        />
      </label>
      <label htmlFor={`${id}-r`} className={label}>
        <span className="font-medium">{t("resetDay")}</span>
        <span className="text-xs text-muted-foreground">
          {t("resetDayHint")}
        </span>
        <input
          id={`${id}-r`}
          type="number"
          min={1}
          max={28}
          value={reset}
          onChange={(e) => setReset(e.target.value)}
          className={input}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={block}
          onChange={(e) => setBlock(e.target.checked)}
        />
        {t("block")}
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending || done}>
          {t("save")}
        </Button>
        {detected &&
        (detected.totalMinutes != null ||
          detected.totalCount != null ||
          detected.isPremium != null) ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || done}
            onClick={() => submit(true)}
          >
            {t("adopt")}
          </Button>
        ) : null}
        <AzureResult result={result} />
      </div>
    </form>
  );
}

export function AzureLimitsButton(props: {
  installationId: string;
  limits: Limits;
  detected: {
    totalMinutes: number | null;
    totalCount: number | null;
    isPremium: boolean | null;
  } | null;
}) {
  const t = useTranslations("ci.azure.settings.limits");
  return (
    <ActionDialog trigger={t("edit")} triggerSize="xs" title={t("title")}>
      {(controls) => <LimitsForm {...props} controls={controls} />}
    </ActionDialog>
  );
}

type HookResult = AzureResultLike & {
  data?: {
    url: string;
    username: string;
    password: string;
    subscriptions: number;
    mode: string;
  } | null;
};

export function HookForm({
  installationId,
  op,
  controls,
}: {
  installationId: string;
  op: "auto" | "manual" | "rotate";
  controls: DialogControls;
}) {
  const t = useTranslations("ci.azure.settings.hooks");
  const [key] = useState(() => crypto.randomUUID());
  const [result, setResult] = useState<HookResult>();
  const [pending, startTransition] = useTransition();
  const done = result?.status === "succeeded";
  const data = result?.status === "succeeded" ? result.data : null;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          try {
            const res =
              op === "rotate"
                ? await rotateAzureHookSecretAction({
                    installationId,
                    confirmed: true,
                    idempotencyKey: key,
                  })
                : await installAzureHooksAction({
                    installationId,
                    mode: op,
                    confirmed: true,
                    idempotencyKey: key,
                  });
            setResult(res as HookResult);
            if (res.status === "succeeded") controls.changed();
          } catch {
            setResult({ status: "error" });
          }
        });
      }}
    >
      <p className="text-sm">{t(`text.${op}`)}</p>
      {data ? (
        <div className="flex flex-col gap-1 rounded-md border bg-muted/40 p-2 text-sm">
          <p className="font-medium">{t("onceTitle")}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">{t("url")}</dt>
            <dd className="font-mono text-xs break-all">{data.url}</dd>
            <dt className="text-muted-foreground">{t("username")}</dt>
            <dd className="font-mono text-xs break-all">{data.username}</dd>
            <dt className="text-muted-foreground">{t("password")}</dt>
            <dd className="font-mono text-xs break-all">{data.password}</dd>
          </dl>
          <p className="text-xs text-muted-foreground">
            {data.mode === "auto"
              ? t("created", { count: data.subscriptions })
              : t("manualSteps")}
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending || done}>
          {t(`op.${op}`)}
        </Button>
        <AzureResult result={result} />
      </div>
    </form>
  );
}

export function AzureHookButton(props: {
  installationId: string;
  op: "auto" | "manual" | "rotate";
}) {
  const t = useTranslations("ci.azure.settings.hooks");
  return (
    <ActionDialog
      trigger={t(`op.${props.op}`)}
      triggerSize="xs"
      triggerVariant="outline"
      title={t(`title.${props.op}`)}
    >
      {(controls) => <HookForm {...props} controls={controls} />}
    </ActionDialog>
  );
}
