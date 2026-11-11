/** The subset of GitHub webhook and REST payloads the ingest layer reads. */

export type GhAccount = {
  id: number;
  login: string;
  type: string; // "User" | "Organization" | "Bot" | "Enterprise"
};

export type GhInstallation = {
  id: number;
  account: GhAccount | null;
  repository_selection: "all" | "selected";
  permissions: Record<string, string | undefined>;
  events: string[];
  suspended_at?: string | null;
};

/** Repositories as listed in installation events (few fields) or by REST (all fields). */
export type GhRepository = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  archived?: boolean;
  default_branch?: string;
  owner?: { login: string };
};

export type InstallationEvent = {
  action:
    | "created"
    | "deleted"
    | "suspend"
    | "unsuspend"
    | "new_permissions_accepted"
    | string;
  installation: GhInstallation;
  repositories?: GhRepository[];
};

export type InstallationRepositoriesEvent = {
  action: "added" | "removed" | string;
  installation: GhInstallation;
  repository_selection?: "all" | "selected";
  repositories_added?: GhRepository[];
  repositories_removed?: GhRepository[];
};

export type RepositoryEvent = {
  action: string; // created, deleted, archived, unarchived, edited, renamed, transferred, publicized, privatized
  repository: GhRepository & { owner: { login: string } };
  installation?: { id: number };
};

export type AppAuthorizationEvent = {
  action: "revoked" | string;
  sender: { id: number; login: string };
};

export type WebhookPayload = {
  action?: string;
  installation?: {
    id: number;
    account?: GhAccount | null;
  } & Partial<GhInstallation>;
  repository?: GhRepository;
  sender?: { id: number; login: string };
  [key: string]: unknown;
};
