import { CommandCenter } from "@/components/command-center";
import { getLatestSnapshot } from "@/lib/db";
import { fallbackSnapshot } from "@/lib/fallback-data";

export const dynamic = "force-dynamic";

export default async function Home() {
  const snapshot = (await getLatestSnapshot()) ?? fallbackSnapshot();
  return <CommandCenter initialSnapshot={snapshot} />;
}
