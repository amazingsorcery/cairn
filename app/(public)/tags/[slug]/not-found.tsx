import NotFound from "@/app/not-found";

/**
 * Unknown tag, or one only drafts carry. Reuses the global 404 so "not published" and
 * "never existed" stay indistinguishable.
 */
export default function TagNotFound() {
  return <NotFound />;
}
