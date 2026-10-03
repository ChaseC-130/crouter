"use client";
import { useRef, useState } from "react";
import { Search, RotateCcw } from "lucide-react";
import { modelEnabled, usageEligibility } from "@/lib/routing-policy";
import type {
  ProviderInfo,
  RoutingPreferences,
  RoutingPreferenceChange,
} from "@/lib/types";

export function ModelPicker({
  providers,
  preferences,
  loading,
  ready,
  saving,
  onChange,
  onRefresh,
}: {
  providers: ProviderInfo[];
  preferences: RoutingPreferences;
  loading: boolean;
  ready: boolean;
  saving: boolean;
  onChange: (change: RoutingPreferenceChange) => void;
  onRefresh: () => void;
}) {
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [view, setView] = useState("all");
  const list = useRef<HTMLDivElement>(null);
  const groups = providers
    .filter((p) => provider === "all" || p.id === provider)
    .map((p) => ({
      ...p,
      models: p.models.filter(
        (m) =>
          `${p.name} ${p.id} ${m.id} ${m.name}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()) &&
          (view === "all" ||
            modelEnabled(preferences, { provider: p.id, model: m.id })),
      ),
    }))
    .filter((p) => p.models.length);
  const visible = groups
    .filter((p) => p.runnable && p.installed)
    .flatMap((p) => p.models.map((m) => ({ provider: p.id, model: m.id })));
  const selected = providers.reduce(
    (count, p) =>
      count +
      p.models.filter((m) =>
        modelEnabled(preferences, { provider: p.id, model: m.id }),
      ).length,
    0,
  );
  return (
    <section className="model-picker" aria-label="Model selection">
      <div className="routing-model-heading">
        <strong>
          Models for routing <span>{selected} selected</span>
        </strong>
        <button className="text-button" disabled={loading} onClick={onRefresh}>
          <RotateCcw size={13} />
          {loading ? "Checking…" : "Refresh"}
        </button>
      </div>
      <label className="search-field model-search">
        <Search size={16} />
        <input
          aria-label="Search host models"
          placeholder="Search models or providers…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="model-filters">
        <select
          aria-label="Filter models by provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        >
          <option value="all">All providers</option>
          {providers
            .filter((p) => p.models.length)
            .map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
        </select>
        <select
          aria-label="Filter models by selection"
          value={view}
          onChange={(e) => setView(e.target.value)}
        >
          <option value="all">All models</option>
          <option value="selected">Selected only</option>
        </select>
        <div className="model-bulk-actions">
          <button
            className="text-button"
            disabled={!ready || !visible.length}
            onClick={() =>
              onChange({ operation: "models", models: visible, enabled: true })
            }
          >
            Select visible
          </button>
          <button
            className="text-button"
            disabled={
              !ready || !visible.some((m) => modelEnabled(preferences, m))
            }
            onClick={() =>
              onChange({ operation: "models", models: visible, enabled: false })
            }
          >
            Clear visible
          </button>
        </div>
      </div>
      <div
        className="routing-model-list"
        ref={list}
        onKeyDown={(event) => {
          if (
            !(event.target instanceof HTMLInputElement) ||
            event.target.type !== "checkbox"
          )
            return;
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
            return;
          const inputs = Array.from(
            list.current?.querySelectorAll<HTMLInputElement>(
              "details[open] input:not(:disabled)",
            ) || [],
          );
          const index = inputs.indexOf(event.target);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? inputs.length - 1
                : index + (event.key === "ArrowDown" ? 1 : -1);
          event.preventDefault();
          inputs[Math.max(0, Math.min(inputs.length - 1, next))]?.focus();
        }}
      >
        {groups.map((p) => (
          <details className="model-group" key={p.id} open>
            <summary>
              {p.name}
              <span>
                {
                  p.models.filter((m) =>
                    modelEnabled(preferences, { provider: p.id, model: m.id }),
                  ).length
                }{" "}
                / {p.models.length}
              </span>
            </summary>
            {p.models.map((m) => {
              const checked = modelEnabled(preferences, {
                provider: p.id,
                model: m.id,
              });
              const eligibility = preferences.usageAware
                ? usageEligibility(p, m.id, preferences.minRemainingPercent)
                : undefined;
              return (
                <label
                  className={`routing-model-option ${checked ? "is-selected" : ""}`}
                  key={m.id}
                >
                  <input
                    type="checkbox"
                    aria-label={`Allow ${p.id} model ${m.id}`}
                    checked={checked}
                    disabled={!ready || !p.runnable || !p.installed}
                    onChange={(e) =>
                      onChange({
                        operation: "model",
                        provider: p.id,
                        model: m.id,
                        enabled: e.target.checked,
                      })
                    }
                  />
                  <span>
                    <strong>{m.name}</strong>
                    {m.name !== m.id && (
                      <small className="model-id">{m.id}</small>
                    )}
                    <small>
                      Effort: {m.efforts.join(", ")}
                      {eligibility?.reason ? ` · ${eligibility.reason}` : ""}
                      {!p.runnable ? " · Unsupported host" : ""}
                    </small>
                  </span>
                </label>
              );
            })}
          </details>
        ))}
        {!groups.length && (
          <p className="model-empty">
            {loading && !providers.length
              ? "Reading host model catalogs…"
              : view === "selected"
                ? "No selected models match. Switch to All models to choose some."
                : "No matching models. Try another search or provider."}
          </p>
        )}
      </div>
      <p className="model-status" role="status">
        {saving
          ? "Saving selections…"
          : selected
            ? "Selections saved on this host. Use ↑ / ↓ to move and Space to select."
            : "Choose models to enable routing. New models start unselected."}
      </p>
    </section>
  );
}
