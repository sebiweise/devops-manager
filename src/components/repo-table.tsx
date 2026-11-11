import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RepoDto } from "@/server/data/live-repositories";

export async function RepoTable({ repos }: { repos: RepoDto[] }) {
  const t = await getTranslations();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("dashboard.repo")}</TableHead>
          <TableHead>{t("dashboard.defaultBranch")}</TableHead>
          <TableHead className="text-right">GitHub</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {repos.map((repo) => (
          <TableRow key={repo.id}>
            <TableCell className="font-medium">
              <span className="mr-2">{repo.fullName}</span>
              {repo.private ? (
                <Badge variant="secondary">{t("common.private")}</Badge>
              ) : null}
              {repo.archived ? (
                <Badge variant="outline" className="ml-1">
                  {t("common.archived")}
                </Badge>
              ) : null}
            </TableCell>
            <TableCell>{repo.defaultBranch}</TableCell>
            <TableCell className="text-right">
              <a
                className="underline"
                href={`https://github.com/${repo.fullName}`}
                rel="noopener noreferrer"
                target="_blank"
              >
                {t("dashboard.open")}
              </a>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
