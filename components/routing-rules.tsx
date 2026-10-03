"use client";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type {
  ProviderInfo,
  RoutingPreferences,
  RoutingPreferenceChange,
  RoutingRule,
} from "@/lib/types";

export function RoutingRules({
  providers,
  preferences,
  saving,
  ready,
  onChange,
}: {
  providers: ProviderInfo[];
  preferences: RoutingPreferences;
  saving: boolean;
  ready: boolean;
  onChange: (change: RoutingPreferenceChange) => void;
}) {
  const [draft, setDraft] = useState<{
    instructions: string;
    rules: RoutingRule[];
  } | null>(null);
  const current = draft || {
    instructions: preferences.instructions,
    rules: preferences.rules,
  };
  const models = providers.flatMap((p) =>
    p.models.map((m) => ({
      provider: p.id,
      model: m.id,
      name: `${p.name} · ${m.name}`,
    })),
  );
  const enabled = models.filter((m) =>
    preferences.enabledModels.some(
      (ref) => ref.provider === m.provider && ref.model === m.model,
    ),
  );
  const disabled = !ready || saving;
  function changeRule(index: number, rule: RoutingRule) {
    setDraft({
      ...current,
      rules: current.rules.map((r, i) => (i === index ? rule : r)),
    });
  }
  return (
    <form
      className="routing-rules"
      aria-label="Routing rules"
      onSubmit={(event) => {
        event.preventDefault();
        onChange({ operation: "rules", ...current });
        setDraft(null);
      }}
    >
      <div className="routing-model-heading">
        <strong>Routing rules</strong>
        <button
          type="button"
          className="text-button"
          disabled={disabled || !enabled.length || current.rules.length >= 16}
          onClick={() =>
            setDraft({
              ...current,
              rules: [
                ...current.rules,
                {
                  provider: enabled[0].provider,
                  model: enabled[0].model,
                  when: "",
                },
              ],
            })
          }
        >
          <Plus size={13} /> Add rule
        </button>
      </div>
      <p className="usage-note">
        Tell JEV / Clef when to prefer each model. Rules apply in order to
        enabled, eligible models. Matching rules take priority over usage
        balancing.
      </p>
      <label className="routing-guidance">
        General routing instructions
        <textarea
          aria-label="General routing instructions"
          rows={3}
          maxLength={2000}
          placeholder="Use lightweight models for small fixes; stronger reasoning for architecture and complex debugging."
          value={current.instructions}
          disabled={disabled}
          onChange={(e) =>
            setDraft({ ...current, instructions: e.target.value })
          }
        />
      </label>
      {current.rules.map((rule, index) => {
        const value = `${rule.provider}:${rule.model}`;
        const known = models.some((m) => `${m.provider}:${m.model}` === value);
        const selected = preferences.enabledModels.some(
          (m) => m.provider === rule.provider && m.model === rule.model,
        );
        return (
          <div className="routing-rule" key={index}>
            <label>
              Prefer model
              <select
                aria-label={`Model for rule ${index + 1}`}
                value={value}
                disabled={disabled}
                onChange={(e) => {
                  const model = models.find(
                    (m) => `${m.provider}:${m.model}` === e.target.value,
                  );
                  if (model)
                    changeRule(index, {
                      ...rule,
                      provider: model.provider,
                      model: model.model,
                    });
                }}
              >
                {!known && <option value={value}>{value} · unavailable</option>}
                {models.map((m) => (
                  <option
                    key={`${m.provider}:${m.model}`}
                    value={`${m.provider}:${m.model}`}
                  >
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              When
              <textarea
                aria-label={`Condition for rule ${index + 1}`}
                required
                rows={2}
                maxLength={500}
                value={rule.when}
                disabled={disabled}
                placeholder="The task is a small UI or documentation change."
                onChange={(e) =>
                  changeRule(index, { ...rule, when: e.target.value })
                }
              />
            </label>
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove rule ${index + 1}`}
              disabled={disabled}
              onClick={() =>
                setDraft({
                  ...current,
                  rules: current.rules.filter((_, i) => i !== index),
                })
              }
            >
              <Trash2 size={15} />
            </button>
            {!selected && (
              <p className="usage-note">
                Select this model above to make this rule eligible.
              </p>
            )}
          </div>
        );
      })}
      <div className="routing-rules-actions">
        <button
          type="submit"
          className="secondary-button"
          disabled={disabled || !draft}
        >
          Save rules
        </button>
        {draft && (
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            onClick={() => setDraft(null)}
          >
            Discard changes
          </button>
        )}
      </div>
      <p className="usage-note">
        Saved to <code>routing.json</code> in your private data directory. File
        edits apply to the next request. These instructions are sent to your
        routing service.
      </p>
    </form>
  );
}
