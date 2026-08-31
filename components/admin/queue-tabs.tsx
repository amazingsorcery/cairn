"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * The four queue lists behind Radix tabs. `wireframes/11-admin-queue.txt`.
 *
 * Each panel's contents are SERVER-RENDERED and passed in as children. This component owns
 * only the tab state, which is the whole reason it is a client component — the tables, the
 * confidence chips and the verification dates never leave the server, so no query result and
 * no draft row is serialised into the client bundle for a tab nobody opened.
 *
 * The triggers are 44 px and the list scrolls horizontally at 375 px rather than wrapping,
 * because four wrapped tabs on two lines read as two separate controls.
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
