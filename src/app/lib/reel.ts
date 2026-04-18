/**
 * Server-side helper for fetching a single public reel via the
 * backend Cloud Function. Called only from React Server Components
 * so the fetch happens at request time with no browser round-trip
 * and no exposure of the backend URL to clients.
 */

const GET_PUBLIC_REEL_URL =
  process.env.NEXT_PUBLIC_GET_PUBLIC_REEL_URL ||
  "https://europe-west2-tape-members.cloudfunctions.net/getPublicReel";

export type PublicReel = {
  id: string;
  videoUrl: string;
  firstFrame: string;
  caption: string;
  creatorName: string;
  creatorPhotoUrl: string;
};

/**
 * Fetch a single reel by id. Returns `null` for 404 (not found /
 * hidden / taken down) so the page can render the "no longer
 * available" fallback without throwing.
 *
 * `next: { revalidate: 60 }` leverages Next.js ISR caching — at the
 * Vercel edge + the 60s cache the Cloud Function already sets, the
 * same reel only hits Firestore once per minute at most.
 */
export async function fetchPublicReel(id: string): Promise<PublicReel | null> {
  try {
    const url = `${GET_PUBLIC_REEL_URL}/${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      next: { revalidate: 60 },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.error(
        `fetchPublicReel: non-2xx from Cloud Function (${res.status}) for ${id}`,
      );
      return null;
    }
    const data: unknown = await res.json();
    if (!data || typeof data !== "object") return null;
    // Narrow the unknown body to our expected shape — any missing
    // field defaults to empty string so render templates don't
    // crash on half-populated reels.
    const d = data as Partial<PublicReel>;
    return {
      id: d.id || id,
      videoUrl: d.videoUrl || "",
      firstFrame: d.firstFrame || "",
      caption: d.caption || "",
      creatorName: d.creatorName || "",
      creatorPhotoUrl: d.creatorPhotoUrl || "",
    };
  } catch (err) {
    console.error("fetchPublicReel failed:", err);
    return null;
  }
}
