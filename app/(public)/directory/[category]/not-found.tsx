import NotFound from "@/app/not-found";

/**
 * Unknown category slug. Reuses the global 404 so it can't drift into distinguishing
 * "never existed" from "not published".
 */
export default function CategoryNotFound() {
  return <NotFound />;
}
