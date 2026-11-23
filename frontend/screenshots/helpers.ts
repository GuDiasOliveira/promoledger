import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, type CDPSession, type Page } from "@playwright/test";

import { API_URL } from "../e2e/config";

/** Where the README images live (committed). */
export const OUT_DIR = path.resolve(__dirname, "../../docs/screenshots");
/** Seed output shared between the setup project and the capture specs (git-ignored). */
export const STATE_FILE = path.resolve(__dirname, "../test-results/screenshots-state.json");

// Accounts created by backend/scripts/seed.py (fictional people, reserved domain).
export const SEED_PASSWORD = "promoledger-seed-2026";
export const ADMIN = { email: "seed.admin@promoledger.example", password: SEED_PASSWORD };
export const SELLER = { email: "seed.seller1@promoledger.example", password: SEED_PASSWORD };

export interface SeedState {
  promotionId: string;
  richHistoryOrderId: string;
}

export const readState = (): SeedState =>
  JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as SeedState;

export async function apiToken(account: { email: string; password: string }): Promise<string> {
  const res = await fetch(`${API_URL}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(account),
  });
  if (!res.ok) throw new Error(`login -> ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Log in through the real UI, like the E2E suite does. */
export async function logIn(page: Page, account: { email: string; password: string }) {
  await page.goto("/login");
  const form = page.locator("form").filter({ visible: true });
  await form.getByLabel("Email").fill(account.email);
  await form.getByLabel("Password").fill(account.password);
  await form.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Your promotions" })).toBeVisible();
}

/** PNG of the current viewport (or the whole page), after fonts and animations settle. */
export async function shot(page: Page, name: string, { fullPage = false } = {}) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0); // no stray hover states
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(OUT_DIR, `${name}.png`),
    fullPage,
    animations: "disabled",
    caret: "hide",
  });
}

/**
 * Shows where a click lands (a fading ring), so a GIF without a cursor is still followable.
 * Install before recording; it only affects the page it runs in.
 */
export async function showClicks(page: Page) {
  await page.evaluate(() => {
    if (document.getElementById("__clicks")) return;
    const style = document.createElement("style");
    style.id = "__clicks";
    style.textContent = `
      .__click { position: fixed; z-index: 2147483647; pointer-events: none;
        width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 9999px;
        border: 3px solid rgb(79 70 229); background: rgb(79 70 229 / 0.2);
        animation: __click 600ms ease-out forwards; }
      @keyframes __click { from { transform: scale(0.4); opacity: 1 } to { transform: scale(1.4); opacity: 0 } }`;
    document.head.append(style);
    document.addEventListener(
      "pointerdown",
      (event) => {
        const dot = document.createElement("div");
        dot.className = "__click";
        dot.style.left = `${event.clientX}px`;
        dot.style.top = `${event.clientY}px`;
        document.body.append(dot);
        setTimeout(() => dot.remove(), 700);
      },
      true,
    );
  });
}

interface Frame {
  file: string;
  at: number; // seconds
}

/**
 * Records a GIF from Chromium's screencast (sharp device-pixel frames, only when the screen
 * changes) between `start()` and `stop()`, then encodes it with ffmpeg (two-pass palette).
 * Navigations reset injected helpers, so call `showClicks` again after each `goto`.
 */
export class GifRecorder {
  private cdp?: CDPSession;
  private frames: Frame[] = [];
  private readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), "promoledger-gif-"));

  constructor(
    private readonly page: Page,
    private readonly name: string,
    private readonly width: number,
  ) {}

  async start() {
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on("Page.screencastFrame", async ({ data, sessionId, metadata }) => {
      const file = path.join(this.dir, `f${String(this.frames.length).padStart(5, "0")}.png`);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      this.frames.push({ file, at: metadata.timestamp ?? Date.now() / 1000 });
      await this.cdp?.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    });
    await this.cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  }

  /** Hold the current screen for `ms` in the GIF (screencast only emits on change). */
  async hold(ms: number) {
    await this.page.waitForTimeout(ms);
  }

  async stop() {
    const end = Date.now() / 1000;
    await this.cdp?.send("Page.stopScreencast");
    await this.cdp?.detach();
    if (this.frames.length === 0) throw new Error(`no frames recorded for ${this.name}`);

    // ffmpeg concat list: each frame lasts until the next one (the last until stop()).
    const lines = this.frames.flatMap((frame, i) => {
      const next = this.frames[i + 1]?.at ?? end;
      return [`file '${frame.file}'`, `duration ${Math.max(next - frame.at, 0.04).toFixed(3)}`];
    });
    lines.push(`file '${this.frames.at(-1)!.file}'`); // concat demuxer quirk: repeat the last
    const list = path.join(this.dir, "frames.txt");
    fs.writeFileSync(list, lines.join("\n"));

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const filter =
      `fps=12,scale=${this.width}:-1:flags=lanczos,split[a][b];` +
      `[a]palettegen=max_colors=128:stats_mode=diff[p];` +
      `[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
    execFileSync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list].concat([
        "-vf",
        filter,
        "-loop",
        "0",
        path.join(OUT_DIR, `${this.name}.gif`),
      ]),
      { stdio: "inherit" },
    );
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
