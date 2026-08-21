/**
 * Cross-platform clipboard image reader.
 *
 * Spawns native OS clipboard tools to read image data from the system
 * clipboard. Works in every terminal emulator because the subprocess
 * accesses the clipboard directly — not the terminal's paste buffer.
 */

import { execFile } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { readFile, unlink } from "fs/promises";
import { randomBytes } from "crypto";

export type SupportedImageMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

export type ClipboardImage = {
  mediaType: SupportedImageMediaType;
  data: Buffer;
};

const SUPPORTED_MIME_TYPES: SupportedImageMediaType[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

const EXEC_TIMEOUT_MS = 2000;

function execFileAsync(
  command: string,
  args: string[],
  options?: { timeout?: number; encoding?: BufferEncoding | "buffer"; maxBuffer?: number },
): Promise<{ stdout: Buffer | string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: options?.timeout ?? EXEC_TIMEOUT_MS,
        encoding: options?.encoding as BufferEncoding | undefined,
        maxBuffer: options?.maxBuffer ?? 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: stdout as Buffer | string, stderr: stderr as string });
      },
    );
  });
}

async function readClipboardMacOS(): Promise<ClipboardImage | null> {
  const tmpFile = join(tmpdir(), `pace-clip-${randomBytes(6).toString("hex")}.png`);

  // AppleScript that writes clipboard PNG data to a temp file
  const script = `
    try
      set imgData to the clipboard as «class PNGf»
      set outFile to POSIX file "${tmpFile}"
      set fRef to open for access outFile with write permission
      write imgData to fRef
      close access fRef
      return "ok"
    on error
      return "no_image"
    end try
  `;

  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      timeout: EXEC_TIMEOUT_MS,
      encoding: "utf-8",
    });

    if ((stdout as string).trim() !== "ok") {
      return null;
    }

    const data = await readFile(tmpFile);
    // Clean up temp file (best-effort)
    void unlink(tmpFile).catch(() => {});

    if (data.length === 0) {
      return null;
    }

    return { mediaType: "image/png", data };
  } catch {
    // Clean up temp file on error (best-effort)
    void unlink(tmpFile).catch(() => {});
    return null;
  }
}

function pickSupportedMimeType(targets: string): SupportedImageMediaType | null {
  const available = targets.split("\n").map((line) => line.trim());
  for (const mime of SUPPORTED_MIME_TYPES) {
    if (available.includes(mime)) {
      return mime;
    }
  }
  return null;
}

async function readClipboardWayland(): Promise<ClipboardImage | null> {
  try {
    const { stdout: typesOutput } = await execFileAsync(
      "wl-paste",
      ["--list-types"],
      { timeout: EXEC_TIMEOUT_MS, encoding: "utf-8" },
    );

    const mime = pickSupportedMimeType(typesOutput as string);
    if (!mime) {
      return null;
    }

    const { stdout: imageData } = await execFileAsync(
      "wl-paste",
      ["--type", mime],
      { timeout: EXEC_TIMEOUT_MS, encoding: "buffer" },
    );

    const data = Buffer.isBuffer(imageData) ? imageData : Buffer.from(imageData);
    if (data.length === 0) {
      return null;
    }

    return { mediaType: mime, data };
  } catch {
    return null;
  }
}

async function readClipboardX11(): Promise<ClipboardImage | null> {
  try {
    const { stdout: targetsOutput } = await execFileAsync(
      "xclip",
      ["-selection", "clipboard", "-t", "TARGETS", "-o"],
      { timeout: EXEC_TIMEOUT_MS, encoding: "utf-8" },
    );

    const mime = pickSupportedMimeType(targetsOutput as string);
    if (!mime) {
      return null;
    }

    const { stdout: imageData } = await execFileAsync(
      "xclip",
      ["-selection", "clipboard", "-t", mime, "-o"],
      { timeout: EXEC_TIMEOUT_MS, encoding: "buffer" },
    );

    const data = Buffer.isBuffer(imageData) ? imageData : Buffer.from(imageData);
    if (data.length === 0) {
      return null;
    }

    return { mediaType: mime, data };
  } catch {
    return null;
  }
}

/**
 * Reads image data from the system clipboard using native OS tools.
 *
 * Returns `null` if:
 * - No image data is on the clipboard (text-only).
 * - The required clipboard tool is not installed.
 * - The platform is not supported (e.g. Windows/WSL).
 * - The tool times out or fails.
 */
export async function readClipboardImage(): Promise<ClipboardImage | null> {
  if (process.platform === "darwin") {
    return readClipboardMacOS();
  }

  if (process.platform === "linux") {
    // Prefer Wayland if WAYLAND_DISPLAY is set
    if (process.env.WAYLAND_DISPLAY) {
      return readClipboardWayland();
    }
    // Fall back to X11 if DISPLAY is set
    if (process.env.DISPLAY) {
      return readClipboardX11();
    }
  }

  // Unsupported platform — no image paste support
  return null;
}
