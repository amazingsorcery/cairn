import { ConfirmAction } from "@/components/admin/confirm-action";
import { adminMetadata, requireAdminPage } from "@/components/admin/guard";
import { CreateCategoryForm, CreateTagForm } from "@/components/admin/taxonomy-forms";
import { deleteCategory, deleteTag } from "@/lib/actions/taxonomy";
import { listCategories, listTags } from "@/lib/queries/taxonomy";

/**
 * `/admin/taxonomy`: categories and tags, admin only. Deletion is final (no soft-delete).
 * `ON DELETE RESTRICT` on `tools/playbooks.category_id` blocks deleting a category in use;
 * the 23503 is mapped to a readable message.
 *
 * Renaming isn't wired up yet (`updateCategory`/`updateTag` exist).
 */

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return adminMetadata(
    {
      title: "Taxonomy",
      description: "Categories and tags.",
      path: "/admin/taxonomy",
    },
    "admin",
  );
}

export default async function AdminTaxonomyPage() {
  await requireAdminPage();
  const [categories, tags] = await Promise.all([listCategories(), listTags()]);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Taxonomy</h1>
      <p className="mt-3 max-w-[68ch] text-base leading-relaxed text-foreground-secondary">
        Counts below are of <strong className="text-foreground">published</strong> entries, which
        is what a reader sees on a facet. A category holding only drafts shows zero here and is
        still not deletable.
      </p>

      <section aria-labelledby="categories-heading" className="mt-10">
        <h2 id="categories-heading" className="text-xl font-semibold tracking-tight">
          Categories
        </h2>

        <div className="mt-4">
          <CreateCategoryForm />
        </div>

        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <caption className="sr-only">
              Every category, in display order, with its published tool and playbook counts.
            </caption>
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <Th>name</Th>
                <Th>slug</Th>
                <Th>tools</Th>
                <Th>playbooks</Th>
                <Th>action</Th>
              </tr>
            </thead>
            <tbody>
              {categories.map((category) => {
                const inUse = category.toolCount > 0 || category.playbookCount > 0;
                return (
                  <tr key={category.id} className="border-b border-border last:border-0">
                    <th scope="row" className="px-3 py-3 text-left font-medium">
                      {category.name}
                    </th>
                    <td className="px-3 py-3 font-mono text-muted-foreground">{category.slug}</td>
                    <td className="px-3 py-3 tabular">{category.toolCount}</td>
                    <td className="px-3 py-3 tabular">{category.playbookCount}</td>
                    <td className="px-3 py-3">
                      <ConfirmAction
                        action={deleteCategory}
                        id={category.id}
                        triggerLabel="delete"
                        triggerVariant="outline"
                        title={`Delete ${category.name}?`}
                        description={
                          inUse ? (
                            <>
                              This category holds published entries, so the database will refuse
                              the delete. Move them to another category first. Deletion is final
                              — there is no trash and nothing to restore from.
                            </>
                          ) : (
                            <>
                              Deletion is final. There is no soft-delete and no trash in this
                              schema, so nothing can be restored afterwards.
                            </>
                          )
                        }
                        confirmLabel="delete"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {categories.length === 0 ? (
          <p className="mt-4 text-sm text-foreground-secondary">
            No categories yet. Every tool and every playbook needs one.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="tags-heading" className="mt-12">
        <h2 id="tags-heading" className="text-xl font-semibold tracking-tight">
          Tags
        </h2>
        <p className="mt-2 max-w-[68ch] text-sm text-foreground-secondary">
          Only tags carrying at least one published tool are listed: a facet chip that returns an
          empty page is worse than no chip, so the query that feeds the public rail excludes
          them and this page shows the same set.
        </p>

        <div className="mt-4">
          <CreateTagForm />
        </div>

        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[36rem] border-collapse text-sm">
            <caption className="sr-only">
              Tags with at least one published tool, alphabetically, with their counts.
            </caption>
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <Th>name</Th>
                <Th>slug</Th>
                <Th>tools</Th>
                <Th>action</Th>
              </tr>
            </thead>
            <tbody>
              {tags.map((tag) => (
                <tr key={tag.id} className="border-b border-border last:border-0">
                  <th scope="row" className="px-3 py-3 text-left font-medium">
                    {tag.name}
                  </th>
                  <td className="px-3 py-3 font-mono text-muted-foreground">{tag.slug}</td>
                  <td className="px-3 py-3 tabular">{tag.toolCount}</td>
                  <td className="px-3 py-3">
                    <ConfirmAction
                      action={deleteTag}
                      id={tag.id}
                      triggerLabel="delete"
                      triggerVariant="outline"
                      title={`Delete ${tag.name}?`}
                      description={
                        <>
                          {tag.toolCount === 1
                            ? "One tool carries this tag and will lose it."
                            : `${tag.toolCount} tools carry this tag and will lose it.`}{" "}
                          Their search vectors are recomputed in the same transaction. Deletion is
                          final — there is no trash.
                        </>
                      }
                      confirmLabel="delete"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {tags.length === 0 ? (
          <p className="mt-4 text-sm text-foreground-secondary">
            No tag carries a published tool yet.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">
      {children}
    </th>
  );
}
