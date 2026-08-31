"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { applyTheme, DEFAULT_THEME, readTheme, type Theme } from "./theme";

/**
 * Switch between the dark and light palettes.
 *
 * `docs/design/states.md` §1.5: the label names the **target** state, not the current one
 * — "switch to light theme" while dark is showing. A toggle labelled with its current
 * state is ambiguous the moment a reader arrives mid-session and does not know which way
 * it points. The icon never carries the meaning alone; the `aria-label` always does.
 *
 * 44×44 (`size-11`, the `icon` size on `Button`) per the touch-target rule in
 * `docs/design/wireframes/00-conventions.txt`.
 *
 * HYDRATION. The server cannot know the reader's stored preference — that is the whole
 * reason the boot script in `theme.ts` exists. So the first client render deliberately
 * matches the server render (`DEFAULT_THEME`), and an effect corrects it immediately
 * afterwards. The correction is a label and an icon swap on a control nobody is reading at
 * that instant; the *page colours* were already right before first paint.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    setTheme(readTheme());
  }, []);

  const target: Theme = theme === "dark" ? "light" : "dark";
  const label = `switch to ${target} theme`;

  return (
    <Button
      variant="ghost"
      size="icon"
      className={className}
      aria-label={label}
      title={label}
      onClick={() => {
        applyTheme(target);
        setTheme(target);
      }}
    >
      {theme === "dark" ? (
        <Sun className="size-5" aria-hidden="true" />
      ) : (
        <Moon className="size-5" aria-hidden="true" />
      )}
    </Button>
  );
}
