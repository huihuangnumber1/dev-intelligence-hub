import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import { normalizeConfigurationDocument } from "../../src/domain/configuration-contract.js";
import { validationBrowserLaunchOptions } from "../../scripts/playwright-validation-options.mjs";

const publicDirectory = new URL("../../public/", import.meta.url);
const configuration = JSON.parse(await readFile(new URL("../../config.example.json", import.meta.url), "utf8"));
configuration.codeExecutor = {
  enabled: true,
  workspaces: [{ id: "native", sourceRoot: "D:/workspace" }],
  requiredProfilesByWorkspace: { native: ["native"] },
  profiles: {
    native: {
      kind: "windows-test", nodeExecutable: "C:/Program Files/nodejs/node.exe", nodeSha256: "a".repeat(64), timeoutMs: 30_000,
      asset: { schemaVersion: 1, title: "Native fixture", description: "Browser configuration fixture", version: 1, source: "console.log('ok');" },
    },
  },
};
normalizeConfigurationDocument(configuration);
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><main></main><script type="module">
import { createConfigurationFormState, configurationDocumentFromForm } from '/configuration-form-support.js';
import { renderConfigurationSettingsSkeleton } from '/settings-view.js';
import { bindConfigurationFormController } from '/configuration-form-controller.js';
let state = createConfigurationFormState(${JSON.stringify(configuration).replaceAll("<", "\\u003c")});
let controller;
window.formErrors = [];
function render() {
  controller?.destroy();
  document.querySelector('main').innerHTML = renderConfigurationSettingsSkeleton({state});
  const root = document.querySelector('form');
  root.addEventListener('submit', event => event.preventDefault());
  controller = bindConfigurationFormController({
    root, getState: () => state,
    onStateChange: (next, options = {}) => { state = next; if(options.render) render(); },
    onInvalidate: () => {}, onError: error => window.formErrors.push(error),
  });
}
render();
window.materialize = () => configurationDocumentFromForm(state);
</script></body></html>`;

const server = http.createServer(async (request, response) => {
  try {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    const name = request.url?.slice(1);
    if (!name || name !== path.basename(name) || !name.endsWith(".js")) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(await readFile(new URL(name, publicDirectory)));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch(validationBrowserLaunchOptions({ headless: true }));
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => typeof window.materialize === "function");
  const original = await page.evaluate(() => window.materialize());
  assert.equal(original.ok, true);
  assert.equal(Object.hasOwn(original.configuration.codeExecutor, "docker"), false);
  assert.equal(Object.hasOwn(original.configuration.codeExecutor.profiles.native, "resources"), false);
  const resourcePath = ["codeExecutor", "profiles", "native", "resources"];
  const encodedPath = (value) => JSON.stringify(value.map(String));
  const collection = page.locator(`[data-configuration-collection='${JSON.stringify(resourcePath)}']`);
  async function addResource(name, sourcePath, kind) {
    const template = collection.locator(":scope > [data-configuration-structure-template]");
    await template.locator("summary").click();
    for (const [key, value] of [["name", name], ["sourcePath", sourcePath], ["sha256", "b".repeat(64)]]) {
      await template.locator(`[data-configuration-template-field='${encodedPath([...resourcePath, 0, key])}']`).fill(value);
    }
    await template.locator(`[data-configuration-template-field='${encodedPath([...resourcePath, 0, "kind"])}']`).selectOption(kind);
    await template.getByRole("button", { name: "新增固定资源", exact: true }).click();
  }
  await addResource("fixtures", "D:/fixtures", "directory");
  await addResource("settings", "D:/fixtures/settings.json", "file");
  const sourceField = page.locator(`[data-configuration-field='${encodedPath([...resourcePath, 1, "sourcePath"])}']`);
  for (const sourcePath of ["//server/share/fixtures", "/fixtures", "D:/fixtures:stream"]) {
    await sourceField.fill(sourcePath);
    const invalid = await page.evaluate(() => window.materialize());
    assert.equal(invalid.ok, false, sourcePath);
    assert.equal(invalid.issues.some(({ path, code }) => path === [...resourcePath, 1, "sourcePath"].join(".") && code === "INVALID_CONFIGURATION_TEXT"), true);
  }
  await sourceField.fill("c:\\fixtures\\settings.json");
  const backslashPath = await page.evaluate(() => window.materialize());
  assert.equal(backslashPath.ok, true);
  normalizeConfigurationDocument(backslashPath.configuration);
  await sourceField.fill("D:/edited/settings.json");
  await collection.locator(":scope > [data-configuration-entry]").first().locator(":scope > header button").click();
  const result = await page.evaluate(() => window.materialize());
  assert.equal(result.ok, true);
  assert.deepEqual(result.configuration.codeExecutor.profiles.native.resources, [
    { name: "settings", sourcePath: "D:/edited/settings.json", sha256: "b".repeat(64), kind: "file" },
  ]);
  normalizeConfigurationDocument(result.configuration);
  await collection.locator(":scope > [data-configuration-entry]").first().locator(":scope > header button").click();
  const empty = await page.evaluate(() => window.materialize());
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.configuration.codeExecutor.profiles.native.resources, []);
  assert.deepEqual(await page.evaluate(() => window.formErrors), []);
  assert.deepEqual(errors, []);
  console.log("Windows-only no-Docker browser editor: absent resources, add, path validation, edit, index-safe delete and canonical save contract passed.");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
