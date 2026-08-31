"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createCategory, createTag } from "@/lib/actions/taxonomy";
import { slugify } from "@/lib/utils";

/**
 * Creating a category or a tag. `/admin/taxonomy`, admin only.
 *
 * FIELD-LEVEL ERRORS COME FROM THE ACTION, not from a second copy of the rules here. Zod
 * produces `fieldErrors` keyed by the same path the schema uses (`lib/actions/result.ts`), so
 * a form attaches a message to the input that caused it with no translation layer — and there
 * is exactly one definition of what a valid slug is, in `lib/validation/`.
 *
 * The slug is derived from the name as you type, and stays derived until you edit it. A slug
 * is a URL that will be linked to from outside; making it an afterthought is how a catalogue
 * ends up with `tool-2` in its permalinks.
 */

type FieldErrors = Record<string, string[]>;

function useCreateForm(action: (input: unknown) => Promise<import("@/lib/actions/result").ActionResult<{ id: string }>>) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [slugTouched, setSlugTouched] = React.useState(false);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [message, setMessage] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const effectiveSlug = slugTouched ? slug : slugify(name);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrors({});
    setMessage(null);
    startTransition(async () => {
      const result = await action({ name: name.trim(), slug: effectiveSlug, description: null });
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        setMessage(result.message);
        return;
      }
      setName("");
      setSlug("");
      setSlugTouched(false);
      router.refresh();
    });
  }

  return {
    name,
    setName,
    slug: effectiveSlug,
    setSlug: (value: string) => {
      setSlugTouched(true);
      setSlug(value);
    },
    errors,
    message,
    pending,
    submit,
  };
}

function CreateForm({
  idPrefix,
  legend,
  form,
}: {
  idPrefix: string;
  legend: string;
  form: ReturnType<typeof useCreateForm>;
}) {
  const nameError = form.errors.name?.[0];
  const slugError = form.errors.slug?.[0];

  return (
    <form onSubmit={form.submit} className="rounded-lg border border-border bg-card p-5">
      <fieldset disabled={form.pending}>
        <legend className="text-base font-semibold tracking-tight">{legend}</legend>
        <div className="mt-4 flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1 basis-48">
            <label htmlFor={`${idPrefix}-name`} className="mb-1.5 block text-sm font-medium">
              name
            </label>
            <Input
              id={`${idPrefix}-name`}
              value={form.name}
              onChange={(event) => form.setName(event.target.value)}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? `${idPrefix}-name-error` : undefined}
              required
            />
            {nameError ? (
              <p id={`${idPrefix}-name-error`} className="mt-1 text-sm text-destructive">
                {nameError}
              </p>
            ) : null}
          </div>

          <div className="min-w-0 flex-1 basis-48">
            <label htmlFor={`${idPrefix}-slug`} className="mb-1.5 block text-sm font-medium">
              slug
            </label>
            <Input
              id={`${idPrefix}-slug`}
              value={form.slug}
              onChange={(event) => form.setSlug(event.target.value)}
              className="font-mono"
              aria-invalid={slugError ? true : undefined}
              aria-describedby={slugError ? `${idPrefix}-slug-error` : undefined}
              required
            />
            {slugError ? (
              <p id={`${idPrefix}-slug-error`} className="mt-1 text-sm text-destructive">
                {slugError}
              </p>
            ) : null}
          </div>

          <Button type="submit" className="mt-7 h-11">
            {form.pending ? "creating…" : "create"}
          </Button>
        </div>

        {form.message && !nameError && !slugError ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {form.message}
          </p>
        ) : null}
      </fieldset>
    </form>
  );
}

export function CreateCategoryForm() {
  const form = useCreateForm(createCategory);
  return <CreateForm idPrefix="category" legend="Add a category" form={form} />;
}

export function CreateTagForm() {
  const form = useCreateForm(createTag);
  return <CreateForm idPrefix="tag" legend="Add a tag" form={form} />;
}
