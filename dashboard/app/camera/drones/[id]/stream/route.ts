import { baseFor } from "../../../../../lib/agents";

export const dynamic = "force-dynamic";

/**
 * Pipes one drone's MJPEG stream through from whichever agent is filming it.
 *
 * <p>The body is handed straight back without buffering, so the browser decodes frames as they
 * arrive exactly as if it had connected to the agent directly - but everything stays on the
 * dashboard's own origin, so a phone on the LAN only needs to reach this app.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const base = await baseFor(id);

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/drones/${encodeURIComponent(id)}/stream`, {
      cache: "no-store",
      // Closing the browser tab has to close the connection to the agent too, or the feed keeps
      // rendering for a viewer that went away.
      signal: request.signal,
    });
  } catch {
    return new Response("agent unreachable", { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    return new Response("no stream", { status: upstream.status || 502 });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type":
        upstream.headers.get("content-type") ?? "multipart/x-mixed-replace; boundary=firekeepframe",
      "Cache-Control": "no-store",
    },
  });
}
