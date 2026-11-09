"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Queue lists behind tabs. Panels are server-rendered children; this only owns tab state.
 * The tab list scrolls rather than wraps on narrow screens.
 */

export interface QueuePanel {
  value: string;
  label: string;
  count: number;
  content: React.ReactNode;
}

export function QueueTabs({ panels }: { panels: readonly QueuePanel[] }) {
  const first = panels[0];
  if (!first) return null;

  return (
    <Tabs defaultValue={first.value} className="mt-6">
      <TabsList className="max-w-full overflow-x-auto">
        {panels.map((panel) => (
          <TabsTrigger key={panel.value} value={panel.value}>
            {panel.label}
            <span className="ml-2 tabular text-xs text-muted-foreground">{panel.count}</span>
          </TabsTrigger>
        ))}
      </TabsList>
      {panels.map((panel) => (
        <TabsContent key={panel.value} value={panel.value}>
          {panel.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
