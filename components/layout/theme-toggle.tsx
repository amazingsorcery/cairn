"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { applyTheme, DEFAULT_THEME, readTheme, type Theme } from "./theme";

/**
 * Dark/light toggle. The label names the target state ("switch to light theme").
 *
 * The first render uses `DEFAULT_THEME` to match the server, then an effect reads the stored
 * preference. Page colours are already correct via the boot script in `theme.ts`.
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
