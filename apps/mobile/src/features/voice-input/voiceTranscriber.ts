import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { File } from "expo-file-system";

import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";

type TranscriptionService = {
  readonly url: string;
  readonly apiKey: string;
  readonly model: string;
};

/**
 * Uses the OpenAI-compatible transcription endpoint configured at build time,
 * otherwise on-device transcription.
 */
export function getVoiceTranscriber(): VoiceTranscriber | null {
  const url = process.env.EXPO_PUBLIC_TRANSCRIPTION_URL;
  const apiKey = process.env.EXPO_PUBLIC_TRANSCRIPTION_API_KEY;
  const model = process.env.EXPO_PUBLIC_TRANSCRIPTION_MODEL;
  if (!url || !apiKey || !model) return getLocalVoiceTranscriber();

  const service = { url, apiKey, model };
  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      return {
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        transcribe: (uri, { signal }) => transcribe(service, uri, signal),
      };
    },
  };
}

const ATTEMPT_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 3;

class TranscriptionResponseError extends Error {
  constructor(readonly status: number) {
    super(`Transcription service responded with ${status}.`);
  }
}

/** Retries network failures, timeouts, and transient statuses while the recording still exists. */
async function transcribe(
  service: TranscriptionService,
  uri: string,
  signal: AbortSignal,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await requestTranscript(service, uri, signal);
    } catch (error) {
      throwIfVoiceTranscriptionAborted(signal);
      if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) {
        throw new VoiceTranscriptionError("transcription-failed", "Voice transcription failed.", {
          cause: error,
        });
      }
      await wait(attempt * 1_000, signal);
      throwIfVoiceTranscriptionAborted(signal);
    }
  }
}

async function requestTranscript(
  service: TranscriptionService,
  uri: string,
  signal: AbortSignal,
): Promise<string> {
  const attempt = new AbortController();
  const abort = () => attempt.abort();
  const timeout = setTimeout(abort, ATTEMPT_TIMEOUT_MS);
  signal.addEventListener("abort", abort);
  try {
    const body = new FormData();
    // expo/fetch uploads expo-file-system files; it rejects `{ uri, name, type }` parts.
    body.append("file", new File(uri));
    body.append("model", service.model);
    const response = await fetch(service.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${service.apiKey}` },
      body,
      signal: attempt.signal,
    });
    if (!response.ok) throw new TranscriptionResponseError(response.status);
    const { text } = (await response.json()) as { text: string };
    throwIfVoiceTranscriptionAborted(signal);
    return text.trim();
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof TranscriptionResponseError)) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}
