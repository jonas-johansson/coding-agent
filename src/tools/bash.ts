import { createWriteStream } from "fs";
import { unlink } from "fs/promises";
import { spawn } from "child_process";
import { z } from "zod";
import { defineTool, isAbortError, throwIfAborted, type ToolOutput } from "./core";
import { checkCommandSafety, isCommandGuardEnabled } from "./dangerous-command";
import {
  TOOL_OUTPUT_TRUNCATION_BYTES,
  TOOL_OUTPUT_TRUNCATION_HEAD_BYTES,
  buildTruncatedToolOutputFromHead,
  createToolOutputPath,
  finishWriteStream,
  shouldPersistLargeToolOutput,
  truncateUtf8Prefix,
} from "./output";

const BASH_DEFAULT_TIMEOUT = 30_000;
const BASH_MAX_TIMEOUT = 600_000;
const BASH_SIGKILL_GRACE_MS = 2_000;
const BASH_FORCE_RETURN_GRACE_MS = 1_000;

type ProcessResult = {
  code: number | null;
  error?: Error;
  forceReturned?: boolean;
};

export const bashTool = defineTool({
  name: "bash",
  description: "Execute a bash command in the current working directory.",
  concurrency: "exclusive",
  inputSchema: z.object({
    command: z.string(),
    timeout: z
      .number()
      .default(30)
      .optional()
      .describe("Maximum time to wait in seconds (max 600). Defaults to 30."),
  }),
  titleFormatter: (input) => {
    const cmd = input.command ?? "";
    if (input.timeout !== undefined && input.timeout !== 30) {
      return `bash: [timeout=${input.timeout}] ${cmd}`;
    }
    return `bash: ${cmd}`;
  },
  execute: async (input, signal, context): Promise<ToolOutput> => {
    throwIfAborted(signal);

    if (isCommandGuardEnabled()) {
      const safety = checkCommandSafety(input.command);
      if (safety.verdict === "dangerous") {
        const message = `Blocked by command guard: ${safety.reason}.`;
        context?.onOutput?.(message);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          is_error: true,
        };
      }
    }

    const timeoutMs = Math.min(
      (input.timeout ?? BASH_DEFAULT_TIMEOUT / 1000) * 1000,
      BASH_MAX_TIMEOUT,
    );
    try {
      const shouldPersistLargeOutput = shouldPersistLargeToolOutput();
      const fullOutputPath = shouldPersistLargeOutput ? await createToolOutputPath("bash") : undefined;
      const fullOutputStream = fullOutputPath ? createWriteStream(fullOutputPath, { encoding: "utf8" }) : undefined;

      // Use spawn with detached: true so the shell and all its children
      // form their own process group. This lets us kill the entire tree
      // (e.g. "sleep 15") instantly via process.kill(-pid, SIGTERM)
      // instead of only killing the wrapper shell.
      const child = spawn("/bin/sh", ["-c", input.command], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let previewHead = "";
      let outputBytes = 0;
      let killSignal: NodeJS.Signals | null = null;
      let timedOut = false;
      let captureOutput = true;
      let settled = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
      let forceReturnTimer: ReturnType<typeof setTimeout> | undefined;
      let resolveProcess: ((result: ProcessResult) => void) | undefined;

      const captureChunk = (chunk: string, streamName: "stdout" | "stderr") => {
        if (!captureOutput) return;
        fullOutputStream?.write(chunk);
        context?.onOutput?.(chunk);
        outputBytes += Buffer.byteLength(chunk, "utf8");

        if (shouldPersistLargeOutput) {
          previewHead = truncateUtf8Prefix(previewHead + chunk, TOOL_OUTPUT_TRUNCATION_HEAD_BYTES);
        }

        if (!shouldPersistLargeOutput || outputBytes <= TOOL_OUTPUT_TRUNCATION_BYTES) {
          if (streamName === "stdout") stdout += chunk;
          else stderr += chunk;
        }
      };

      child.stdout.on("data", (data: Buffer) => {
        captureChunk(data.toString("utf8"), "stdout");
      });

      child.stderr.on("data", (data: Buffer) => {
        captureChunk(data.toString("utf8"), "stderr");
      });

      // Kill the entire process group so children are also terminated
      const killTree = (signalToSend: NodeJS.Signals) => {
        killSignal = signalToSend;
        if (child.pid) {
          try { process.kill(-child.pid, signalToSend); } catch {}
        }
        child.kill(signalToSend);
      };

      const forceReturn = () => {
        if (settled) return;
        captureOutput = false;
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        resolveProcess?.({ code: null, forceReturned: true });
      };

      const scheduleKillEscalation = () => {
        if (sigkillTimer || forceReturnTimer) return;
        sigkillTimer = setTimeout(() => {
          killTree("SIGKILL");
        }, BASH_SIGKILL_GRACE_MS);
        forceReturnTimer = setTimeout(() => {
          forceReturn();
        }, BASH_SIGKILL_GRACE_MS + BASH_FORCE_RETURN_GRACE_MS);
      };

      // Set up timeout
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        killTree("SIGTERM");
        scheduleKillEscalation();
      }, timeoutMs);

      // Set up abort signal
      let onAbort: (() => void) | undefined;
      if (signal) {
        onAbort = () => {
          killTree("SIGTERM");
          scheduleKillEscalation();
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      // Wait for the process to exit
      const processResult = await new Promise<ProcessResult>((resolve) => {
        resolveProcess = (result) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };

        child.on("error", (error) => resolveProcess?.({ code: null, error }));
        child.on("close", (exitCode) => resolveProcess?.({ code: exitCode }));
      });
      const { code } = processResult;

      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (forceReturnTimer) clearTimeout(forceReturnTimer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      if (fullOutputStream) {
        await finishWriteStream(fullOutputStream);
      }

      if (processResult.error) {
        throw processResult.error;
      }

      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const outputWasTruncated = shouldPersistLargeOutput && outputBytes > TOOL_OUTPUT_TRUNCATION_BYTES;
      if (fullOutputPath && !outputWasTruncated) {
        await unlink(fullOutputPath).catch(() => undefined);
      }

      const bashOutput = outputWasTruncated && fullOutputPath
        ? buildTruncatedToolOutputFromHead(previewHead, outputBytes, fullOutputPath)
        : [stdout, stderr].filter(Boolean).join("\n");

      if (timedOut) {
        const forcedMessage = processResult.forceReturned
          ? " Process did not exit after SIGKILL; stopped waiting."
          : killSignal === "SIGKILL"
            ? " Sent SIGKILL after SIGTERM."
            : "";
        const timeoutMessage = `Command timed out after ${Math.floor(timeoutMs / 1000)} seconds.${forcedMessage}`;
        const message = bashOutput
          ? `${timeoutMessage} Partial output:\n${bashOutput}`
          : timeoutMessage;
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          is_error: true,
        };
      }

      if (code !== 0 && code !== null) {
        const message = [bashOutput, `Command exited with code ${code}`].filter(Boolean).join("\n");
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          is_error: true,
        };
      }

      return {
        content: [{ type: "text", text: bashOutput }]
      };
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        is_error: true,
      };
    }
  }
})
