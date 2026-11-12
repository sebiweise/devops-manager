"use client";

import { useParams } from "next/navigation";
import { ErrorPanel } from "@/components/shell/error-panel";

export default function AccountError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const params = useParams<{ account: string }>();
  return (
    <ErrorPanel
      digest={error.digest}
      reset={reset}
      backHref={`/o/${encodeURIComponent(decodeURIComponent(params.account ?? ""))}`}
      backLabel="backToAccount"
    />
  );
}
