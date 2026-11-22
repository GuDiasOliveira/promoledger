// Render public/icons/icon.svg to the PNG sizes required for PWA installability.
// Usage: node scripts/gen-icons.mjs  (uses the Playwright Chromium already installed for E2E)
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const svg = readFileSync(new URL("../public/icons/icon.svg", import.meta.url), "utf8");
const targets = [
  { file: "icon-192.png", size: 192, padding: 0 },
  { file: "icon-512.png", size: 512, padding: 0 },
  // Maskable: keep the artwork inside the 80% safe zone.
  { file: "icon-maskable-512.png", size: 512, padding: 0.1 },
];

const browser = await chromium.launch();
for (const { file, size, padding } of targets) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const inset = Math.round(size * padding);
  await page.setContent(
    `<html><body style="margin:0;background:#4f46e5">` +
      `<div style="padding:${inset}px;width:${size - 2 * inset}px;height:${size - 2 * inset}px">` +
      svg.replace("<svg ", `<svg width="${size - 2 * inset}" height="${size - 2 * inset}" `) +
      `</div></body></html>`,
  );
  await page.screenshot({ path: new URL(`../public/icons/${file}`, import.meta.url).pathname });
  await page.close();
}
await browser.close();
console.log("icons generated:", targets.map((t) => t.file).join(", "));
