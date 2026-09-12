import "server-only";

import fs from "node:fs";

const SERVERLESS_CHROMIUM_VERSION = "143.0.4";

export interface ChromiumLaunchConfig {
  executablePath: string;
  args: string[];
}

function uniqueArgs(args: string[]): string[] {
  return Array.from(new Set(args));
}

/**
 * The min package deliberately ships without a browser binary. Vercel functions
 * download this matching release pack into /tmp on their first cold invocation.
 */
export function getServerlessChromiumPackUrl(): string {
  const configured = process.env.CHROMIUM_PACK_URL?.trim();
  if (configured) return configured;

  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  return `https://github.com/Sparticuz/chromium/releases/download/v${SERVERLESS_CHROMIUM_VERSION}/chromium-v${SERVERLESS_CHROMIUM_VERSION}-pack.${architecture}.tar`;
}

/** Finds a local Chromium browser for direct airline Manage Booking imports. */
export function getChromeExecutablePath(): string | null {
  const configured = process.env.CHROME_EXECUTABLE_PATH?.trim();
  if (configured && fs.existsSync(configured)) return configured;

  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
          ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** Resolves local Chrome or prepares the lightweight Vercel Chromium runtime. */
export async function resolveChromiumLaunchConfig(
  additionalArgs: string[] = [],
): Promise<ChromiumLaunchConfig> {
  const systemPath = getChromeExecutablePath();
  if (systemPath) {
    return {
      executablePath: systemPath,
      args: uniqueArgs(additionalArgs),
    };
  }

  const packUrl = getServerlessChromiumPackUrl();
  try {
    const chromiumModule = await import("@sparticuz/chromium-min");
    const chromium = chromiumModule.default;
    const executablePath = await chromium.executablePath(packUrl);
    if (!executablePath || !fs.existsSync(executablePath)) {
      throw new Error("Downloaded Chromium executable was not created.");
    }

    return {
      executablePath,
      args: uniqueArgs([
        ...(Array.isArray(chromium.args) ? chromium.args : []),
        ...additionalArgs,
      ]),
    };
  } catch (error) {
    console.error(
      `[impexp] serverless Chromium preparation failed (${packUrl}):`,
      error,
    );
    throw new Error(
      "Serverless Chromium could not be prepared. Verify CHROMIUM_PACK_URL and deployment network access.",
      { cause: error },
    );
  }
}
