import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
const browser = await chromium.launch({
  headless: true,
  channel: process.env.CROUTER_TEST_BROWSER || "chrome",
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1100 },
  colorScheme: "dark",
});
let preferences = {
  enabledModels: [],
  usageAware: false,
  minRemainingPercent: 20,
  instructions: "",
  rules: [],
};
const snapshot = () => ({
  projects: [],
  tasks: [],
  messages: [],
  warnings: [],
  config: {
    routingProvider: "jev",
    routingConfigured: true,
    demo: true,
    projectPathBase: "/synthetic",
    routingPreferences: preferences,
    codex: true,
    claude: true,
    agy: true,
    muse: false,
    grok: false,
  },
});
const providers = ["codex", "claude", "agy"].map((id) => ({
  id,
  name: id === "agy" ? "Antigravity · agy" : id,
  installed: true,
  runnable: true,
  detail: "Synthetic CLI",
  windows: [],
  models: Array.from({ length: 16 }, (_, i) => ({
    id: `${id}-${i}`,
    name: `${id} Model ${i}`,
    description: "Synthetic model",
    efforts: ["low", "high"],
    defaultEffort: "low",
  })),
}));
let delayProviders = false;
let delaySaves = false;
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/api/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === "/api/snapshot") return route.fulfill({ json: snapshot() });
  if (path === "/api/providers") {
    if (delayProviders)
      await new Promise((resolve) => setTimeout(resolve, 700));
    return route.fulfill({ json: { providers } });
  }
  if (path === "/api/routing-preferences") {
    if (delaySaves) await new Promise((resolve) => setTimeout(resolve, 250));
    const change = route.request().postDataJSON();
    if (change.operation === "rules") {
      preferences = {
        ...preferences,
        instructions: change.instructions,
        rules: change.rules,
      };
      return route.fulfill({ json: { preferences } });
    }
    if (change.operation === "usage") {
      preferences = { ...preferences, usageAware: change.enabled };
      return route.fulfill({ json: { preferences } });
    }
    if (change.operation === "reserve") {
      preferences = {
        ...preferences,
        minRemainingPercent: change.minRemainingPercent,
      };
      return route.fulfill({ json: { preferences } });
    }
    const refs =
      change.operation === "models"
        ? change.models
        : [{ provider: change.provider, model: change.model }];
    preferences = {
      ...preferences,
      enabledModels: preferences.enabledModels.filter(
        (m) =>
          !refs.some(
            (ref) => m.provider === ref.provider && m.model === ref.model,
          ),
      ),
    };
    if (change.enabled) preferences.enabledModels.push(...refs);
    return route.fulfill({ json: { preferences } });
  }
  return route.fulfill({ json: {} });
});
try {
  await page.goto(process.env.CROUTER_UI_URL || "http://127.0.0.1:3000");
  await page.getByRole("button", { name: "Host & usage" }).click();
  await page
    .getByRole("checkbox", { name: "Allow codex model codex-0", exact: true })
    .waitFor();
  const theme = page.getByLabel("Appearance", { exact: true });
  assert.equal(await theme.inputValue(), "system");
  const bg = () =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(await bg(), "rgb(20, 25, 20)");
  assert.equal(
    await page
      .locator(".modal")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(29, 36, 28)",
  );
  assert.equal(
    await page.locator(".routing-model-option input:checked").count(),
    0,
  );
  assert.equal(await page.getByText("Gemini CLI", { exact: false }).count(), 0);
  delaySaves = true;
  const first = page.getByRole("checkbox", {
    name: "Allow codex model codex-0",
    exact: true,
  });
  await first.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  assert.equal(await first.isChecked(), true);
  assert.equal(await first.isEnabled(), true);
  assert.equal(
    await page
      .getByRole("checkbox", { name: "Allow codex model codex-1", exact: true })
      .isChecked(),
    true,
  );
  await page
    .getByRole("status")
    .filter({ hasText: "Selections saved" })
    .waitFor();
  assert.equal(preferences.enabledModels.length, 2);
  await page.getByLabel("Filter models by provider").selectOption("agy");
  assert.equal(await page.locator(".routing-model-option").count(), 16);
  await page.getByLabel("Search host models").fill("agy-15");
  assert.equal(await page.locator(".routing-model-option").count(), 1);
  await page
    .getByRole("button", { name: "Select visible", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Selections saved" })
    .waitFor();
  assert.equal(preferences.enabledModels.length, 3);
  await page
    .getByLabel("General routing instructions")
    .fill("Prefer low effort for simple fixes.");
  await page.getByRole("button", { name: "Add rule", exact: true }).click();
  await page.getByLabel("Model for rule 1").selectOption("codex:codex-0");
  await page
    .getByLabel("Condition for rule 1")
    .fill("Small UI and documentation changes");
  await page.getByRole("button", { name: "Save rules", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Selections saved" })
    .waitFor();
  assert.equal(preferences.rules[0].model, "codex-0");
  assert.equal(preferences.rules[0].when, "Small UI and documentation changes");
  const usageToggle = page.getByRole("checkbox", {
    name: /Route based on remaining usage/,
  });
  await usageToggle.check();
  await page
    .getByRole("status")
    .filter({ hasText: "Selections saved" })
    .waitFor();
  assert.equal(preferences.usageAware, true);
  await page.getByLabel("Minimum remaining usage", { exact: true }).fill("30");
  await page.getByRole("button", { name: "Save reserve", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Selections saved" })
    .waitFor();
  assert.equal(preferences.minRemainingPercent, 30);
  await page.getByLabel("Search host models").fill("");
  await page.locator(".routing-model-list").evaluate((el) => {
    el.scrollTop = 300;
  });
  const scroll = await page
    .locator(".routing-model-list")
    .evaluate((el) => el.scrollTop);
  delayProviders = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  assert.equal(await page.locator(".routing-model-option").count(), 16);
  assert.equal(
    await page.locator(".routing-model-list").evaluate((el) => el.scrollTop),
    scroll,
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).waitFor();
  assert.equal(
    await page.locator(".routing-model-list").evaluate((el) => el.scrollTop),
    scroll,
  );
  await page.getByLabel("Filter models by selection").selectOption("selected");
  assert.equal(await page.locator(".routing-model-option").count(), 1);
  await theme.selectOption("light");
  assert.equal(await bg(), "rgb(248, 249, 246)");
  await theme.selectOption("dark");
  await page.screenshot({
    path: path.join(os.tmpdir(), "crouter-routing-dark-settings.png"),
  });
  await page.reload();
  assert.equal(await bg(), "rgb(20, 25, 20)");
  await page.getByRole("button", { name: "Host & usage" }).click();
  await first.waitFor();
  assert.equal(
    await page.getByLabel("General routing instructions").inputValue(),
    "Prefer low effort for simple fixes.",
  );
  assert.equal(
    await page.getByLabel("Condition for rule 1").inputValue(),
    "Small UI and documentation changes",
  );
  await theme.selectOption("system");
  await page.emulateMedia({ colorScheme: "light" });
  assert.equal(await bg(), "rgb(248, 249, 246)");
  await page.screenshot({
    path: path.join(os.tmpdir(), "crouter-routing-light-settings.png"),
  });
  await page.emulateMedia({ colorScheme: "dark" });
  assert.equal(await bg(), "rgb(20, 25, 20)");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(await page.getByRole("dialog").count(), 1);
  const bounds = await page.getByRole("dialog").boundingBox();
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844);
  await page.locator(".routing-rules").screenshot({
    path: path.join(os.tmpdir(), "crouter-routing-mobile-rules.png"),
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({
    path: path.join(os.tmpdir(), "crouter-routing-dark-workspace.png"),
  });
  assert.deepEqual(errors, []);
  console.log(
    "UI checks passed: model selection, routing rule editing/persistence, usage toggle/reserve, stable refresh/scroll, themes, and mobile layout.",
  );
} catch (error) {
  await page.screenshot({
    path: path.join(os.tmpdir(), "crouter-routing-ui-failure.png"),
  });
  console.error(
    JSON.stringify({
      errors,
      page: (await page.locator("body").innerText()).slice(0, 5000),
    }),
  );
  throw error;
} finally {
  await browser.close();
}
