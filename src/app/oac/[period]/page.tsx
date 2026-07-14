import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Legacy route — redirects to the new /capture/[service_id] flow.
 * The [period] param maps to the service ID in the new schema.
 */
export default function LegacyOacRedirect({
  params,
}: {
  params: { period: string };
}) {
  redirect(`/capture/${params.period}`);
}
