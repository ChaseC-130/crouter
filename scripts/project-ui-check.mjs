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
  reducedMotion: "reduce",
});
page.setDefaultTimeout(10000);
const gameId = "11111111-1111-4111-8111-111111111111";
const generalId = "00000000-0000-4000-8000-000000000001";
const projects = [
  {
    id: gameId,
    name: "Tactics",
    path: "/synthetic/game",
    aliases: ["units"],
    description: "",
    createdAt: new Date().toISOString(),
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Billing",
    path: "/synthetic/billing",
    aliases: [],
    description: "Invoices and payment processing",
    createdAt: new Date().toISOString(),
  },
  {
    id: generalId,
    kind: "general",
    name: "General",
    path: "/synthetic/general",
    aliases: [],
    description: "Generic requests in a scratch directory",
    createdAt: new Date().toISOString(),
  },
];
const messages = [];
let lastUpdate;
let lastChat;
let lastCreate;
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const snapshot = () => ({
  projects,
  tasks: [],
  messages,
  warnings: [],
  config: {
    routingProvider: "jev",
    routingConfigured: true,
    demo: true,
    projectPathBase: "/synthetic",
    routingPreferences: {
      enabledModels: [],
      usageAware: false,
      minRemainingPercent: 20,
      instructions: "",
      rules: [],
    },
    codex: true,
    claude: false,
    grok: false,
    agy: false,
    muse: false,
  },
});
await page.route("**/api/**", async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/api/snapshot")
    return route.fulfill({ json: snapshot() });
  if (url.pathname === "/api/projects" && route.request().method() === "GET")
    return route.fulfill({
      json: { path: "/synthetic/tools", base: "/synthetic" },
    });
  if (
    url.pathname === "/api/projects" &&
    route.request().method() === "PATCH"
  ) {
    lastUpdate = route.request().postDataJSON();
    const project = projects.find((p) => p.id === lastUpdate.id);
    Object.assign(project, lastUpdate);
    return route.fulfill({ json: { project } });
  }
  if (url.pathname === "/api/projects" && route.request().method() === "POST") {
    lastCreate = route.request().postDataJSON();
    const project = {
      ...lastCreate,
      id: "33333333-3333-4333-8333-333333333333",
      createdAt: new Date().toISOString(),
    };
    projects.push(project);
    return route.fulfill({ json: { project } });
  }
  if (url.pathname === "/api/chat") {
    lastChat = route.request().postDataJSON();
    messages.push(
      {
        id: "m1",
        role: "user",
        content: lastChat.turn,
        createdAt: new Date().toISOString(),
      },
      {
        id: "m2",
        role: "assistant",
        content:
          lastChat.projectId === generalId
            ? "General · Birthday poem queued."
            : "Tactics · Balance audit queued. Review unit tiers, combat roles and upgrade tradeoffs.",
        createdAt: new Date().toISOString(),
      },
    );
    return route.fulfill({ json: {} });
  }
  return route.fulfill({ json: {} });
});
try {
  await page.goto(process.env.CROUTER_UI_URL || "http://127.0.0.1:3000");
  await page.getByRole("button", { name: "Set up Tactics" }).waitFor();
  const chat = await page
    .getByRole("region", { name: "Conversation", exact: true })
    .boundingBox();
  const dashboard = await page
    .getByRole("region", { name: "Task dashboard", exact: true })
    .boundingBox();
  assert.ok(chat.width > dashboard.width * 1.6);
  const composer = page.getByLabel("Message to route");
  assert.ok((await composer.boundingBox()).height >= 120);
  await page
    .getByRole("button", { name: "Expand conversation", exact: true })
    .click();
  assert.equal(
    await page.getByRole("region", { name: "Task dashboard" }).count(),
    0,
  );
  assert.ok(
    (
      await page
        .getByRole("region", { name: "Conversation", exact: true })
        .boundingBox()
    ).width > chat.width,
  );
  await page
    .getByRole("button", { name: "Show task dashboard", exact: true })
    .click();
  await page.getByRole("button", { name: "Set up Tactics" }).click();
  assert.equal(
    await page.getByLabel("Project path on host").getAttribute("readonly"),
    "",
  );
  const description =
    "A strategy game with unit tiers, combat roles, upgrades and balance audits. Units in the same tier should be distinct; upgrades should preserve tradeoffs with native tier peers.";
  await page.getByLabel("Project context", { exact: true }).fill(description);
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(lastUpdate.id, gameId);
  assert.equal(lastUpdate.description, description);
  assert.ok(!("path" in lastUpdate));
  await page
    .getByRole("button", { name: "Set up Tactics" })
    .waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Project settings for Tactics" })
    .click();
  assert.equal(
    await page.getByLabel("Project context", { exact: true }).inputValue(),
    description,
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByLabel("Project for this message").selectOption(gameId);
  const request =
    "Lets do a heuristic balance audit of units and report back suggested balance changes we should make. Units within the same tier should not be duplicates of one another, and upgraded units shouldn't be better versions of their native tier peers.";
  await composer.fill(request);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page
    .getByText(
      "Tactics · Balance audit queued. Review unit tiers, combat roles and upgrade tradeoffs.",
      { exact: true },
    )
    .waitFor();
  assert.equal(lastChat.projectId, gameId);
  assert.equal(lastChat.turn, request);
  assert.equal(await page.locator(".welcome-message").count(), 0);
  await page.screenshot({
    path: path.join(os.tmpdir(), "crouter-context-chat.png"),
  });
  await page
    .getByRole("button", { name: "Add project", exact: true })
    .first()
    .click();
  await page.getByLabel("Project name", { exact: true }).fill("Tools");
  await page
    .getByLabel("Project path on host", { exact: true })
    .fill("../tools");
  await page
    .getByLabel("Project context", { exact: true })
    .fill("Developer tools and automation workflows.");
  await page
    .getByRole("button", { name: "Connect project", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    lastCreate.description,
    "Developer tools and automation workflows.",
  );
  await page
    .getByLabel("Project for this message")
    .locator("option")
    .filter({ hasText: "Tools" })
    .waitFor({ state: "attached" });
  assert.equal(
    await page.getByLabel("Project for this message").locator("option").count(),
    5,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.ok((await composer.boundingBox()).height >= 130);
  await composer.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(os.tmpdir(), "crouter-context-chat-mobile.png"),
  });
  // A first-time user can send work without connecting any repository.
  projects.splice(
    0,
    projects.length,
    projects.find((p) => p.id === generalId),
  );
  messages.length = 0;
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.reload();
  await page.getByLabel("Project for this message").selectOption(generalId);
  assert.equal(
    await page
      .getByRole("button", { name: "Project settings for General" })
      .count(),
    0,
  );
  assert.match(await page.locator(".stat").first().innerText(), /^0\s/);
  assert.equal(await composer.isEnabled(), true);
  await composer.fill("Write a birthday poem");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page
    .getByText("General · Birthday poem queued.", { exact: true })
    .waitFor();
  assert.equal(lastChat.projectId, generalId);
  await page.screenshot({
    path: path.join(os.tmpdir(), "crouter-general-workspace.png"),
  });
  assert.deepEqual(errors, []);
  console.log(
    "Project UI checks passed: project setup/editing, explicit targets, generic requests without projects, and desktop/mobile layout.",
  );
} catch (error) {
  await page.screenshot({
    path: path.join(os.tmpdir(), "crouter-project-ui-failure.png"),
  });
  console.log(
    "Visible dialogs:",
    await page.getByRole("dialog").count(),
    "Browser errors:",
    errors,
  );
  throw error;
} finally {
  await browser.close();
}
