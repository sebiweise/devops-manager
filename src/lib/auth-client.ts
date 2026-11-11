"use client";

import { createAuthClient } from "better-auth/react";

/** Browser client for better-auth; same origin, so no base URL is needed. */
export const authClient = createAuthClient();
