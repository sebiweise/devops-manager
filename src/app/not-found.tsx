import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-md flex-col items-center gap-4 p-16 text-center">
      <h1 className="text-2xl font-semibold">404</h1>
      <p className="text-muted-foreground">
        This page does not exist or is not visible to you.
      </p>
      <Link className="underline" href="/">
        Home
      </Link>
    </main>
  );
}
