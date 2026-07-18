import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Legacy route — redirects to the new /capture/[service_id] flow.
 */
export default async function LegacyOacRedirect({
  params,
}: {
  params: Promise<{ period: string }>;
}) {
  const { period } = await params;
  redirect(`/capture/${period}`);
}
