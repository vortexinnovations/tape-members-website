/**
 * Server-side helper for fetching a single public drink bar via
 * the backend Cloud Function. Called only from React Server
 * Components so the fetch happens at request time with no browser
 * round-trip and no exposure of the backend URL to clients.
 *
 * Mirrors lib/reel.ts — both endpoints are unauthenticated, gated
 * on `visible == true`, and return narrow public-safe shapes.
 */

const GET_PUBLIC_BAR_URL =
  process.env.NEXT_PUBLIC_GET_PUBLIC_BAR_URL ||
  "https://europe-west2-tape-members.cloudfunctions.net/getPublicBar";

export type PublicBar = {
  id: string;
  name: string;
  description: string;
  photoUrl: string;
  acceptingOrders: boolean;
};

/**
 * Fetch a single bar by id. Returns `null` for 404 (not found /
 * hidden / taken down) so the page can render a graceful fallback
 * without throwing.
 *
 * `next: { revalidate: 60 }` leverages Next.js ISR caching — at
 * the Vercel edge + the 60s cache the Cloud Function already sets,
 * the same bar only hits Firestore once per minute at most.
 */
export async function fetchPublicBar(id: string): Promise<PublicBar | null> {
  try {
    const url = `${GET_PUBLIC_BAR_URL}/${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      next: { revalidate: 60 },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.error(
        `fetchPublicBar: non-2xx from Cloud Function (${res.status}) for ${id}`,
      );
      return null;
    }
    const data: unknown = await res.json();
    if (!data || typeof data !== "object") return null;
    const d = data as Partial<PublicBar>;
    return {
      id: d.id || id,
      name: d.name || "",
      description: d.description || "",
      photoUrl: d.photoUrl || "",
      acceptingOrders: d.acceptingOrders !== false,
    };
  } catch (err) {
    console.error("fetchPublicBar failed:", err);
    return null;
  }
}
