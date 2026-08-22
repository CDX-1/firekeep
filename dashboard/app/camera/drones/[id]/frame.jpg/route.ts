import { baseFor } from "../../../../../lib/agents";

export const dynamic = "force-dynamic";

/**
 * One still frame from whichever agent films this drone.
 *
 * <p>Kept for tiles that fall back to polling when the browser has run out of connections for live
 * streams, and for a first paint while a stream is still opening.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const base = await baseFor(id);

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/drones/${encodeURIComponent(id)}/frame.jpg`, {
      cache: "no-store",
      signal: request.signal,
    });
  } catch {
    return new Response("agent unreachable", { status: 502 });
  }

  if (!upstream.ok) {
    return new Response("no frame", { status: upstream.status });
  }

  return new Response(await upstream.arrayBuffer(), {
    status: 200,
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
  });
}
