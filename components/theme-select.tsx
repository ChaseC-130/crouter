"use client";
import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
type Theme = "system" | "light" | "dark";
export function ThemeSelect() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    const stored = document.documentElement.dataset.theme;
    const timer = setTimeout(() => {
      if (stored === "light" || stored === "dark") setTheme(stored);
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  const Icon = theme === "system" ? Monitor : theme === "dark" ? Moon : Sun;
  return (
    <label className="theme-select">
      <Icon size={16} />
      <span>Appearance</span>
      <select
        aria-label="Appearance"
        value={theme}
        onChange={(e) => {
          const next = e.target.value as Theme;
          setTheme(next);
          document.documentElement.dataset.theme = next;
          try {
            localStorage.setItem("crouter-theme", next);
          } catch {
            /* Theme still works when storage is unavailable. */
          }
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
