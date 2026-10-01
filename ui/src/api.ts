import { useEffect, useState } from "react";
import type { DemoSnapshot } from "./types";

export function useDemoState(): DemoSnapshot | undefined {
  const [snapshot, setSnapshot] = useState<DemoSnapshot | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | undefined;

    const connect = () => {
      source = new EventSource("/api/demo/stream");
      source.onmessage = (message) => {
        if (!cancelled) setSnapshot(JSON.parse(message.data) as DemoSnapshot);
      };
      source.onerror = () => {
        source?.close();
        if (!cancelled) setTimeout(() => { if (!cancelled) connect(); }, 1500);
      };
    };
    connect();

    return () => {
      cancelled = true;
      source?.close();
    };
  }, []);

  return snapshot;
}

export async function startDemo(): Promise<void> {
  await fetch("/api/demo/start", { method: "POST" });
}

export async function resetDemo(): Promise<void> {
  await fetch("/api/demo/reset", { method: "POST" });
}
