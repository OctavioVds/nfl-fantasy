import { CommandCenter } from "@/components/command-center";
import { getLatestSnapshot } from "@/lib/db";
import { fallbackSnapshot } from "@/lib/fallback-data";
import { snapshotForDisplay } from "@/lib/snapshot-view";

export const dynamic = "force-dynamic";

export default async function Home() {
  const snapshot = snapshotForDisplay((await getLatestSnapshot()) ?? fallbackSnapshot());
  return <CommandCenter initialSnapshot={snapshot} />;
}
