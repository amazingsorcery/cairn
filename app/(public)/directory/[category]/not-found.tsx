import NotFound from "@/app/not-found";

/**
 * A category slug that does not exist.
 *
 * It renders the **same page** as the global 404 by reusing the component rather than
 * restating its copy. `states.md` §1.2: "For a draft or removed entry the 404 is the same
 * page. It must not distinguish 'never existed' from 'not published'." Reusing the component
 * makes that structurally true instead of a rule someone has to remember when they edit one
 * of the two files.
 */
export default function CategoryNotFound() {
  return <NotFound />;
}
