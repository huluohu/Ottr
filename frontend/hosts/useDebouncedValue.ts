// 防抖值（Task 5）：HostTree 搜索共用（走 vault search，防抖 200ms）。
// 原 QuickConnect 消费方已随 ⌘K 面板并入 palette（客户端即时过滤，无防抖）。
import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
