import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { File } from "expo-file-system";
import { fetch } from "expo/fetch";

import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import {
  getCloudTranscriptionSettings,
  type CloudTranscriptionSettings,
} from "./voiceTranscriptionSettings";

// Allows a slow uplink about 25 KB/s on top of a minute for the service to answer.
const uploadTimeoutMs = (bytes: number) => 60_000 + bytes / 25;

/** The cloud service configured in Settings, otherwise on-device transcription. */
export function getVoiceTranscriber(): VoiceTranscriber | null {
  const settings = getCloudTranscriptionSettings();
  if (!settings) return getLocalVoiceTranscriber();
  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      return {
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        transcribe: (uri, { signal }) => transcribe(settings, uri, signal),
      };
    },
  };
}

async function transcribe(
  settings: CloudTranscriptionSettings,
  uri: string,
  signal: AbortSignal,
): Promise<string> {
  throwIfVoiceTranscriptionAborted(signal);
  // A stalled upload must not leave the composer transcribing indefinitely.
  const file = new File(uri);
  const upload = new AbortController();
  const abort = () => upload.abort();
  const timeout = setTimeout(abort, uploadTimeoutMs(file.size));
  signal.addEventListener("abort", abort);
  try {
    const body = new FormData();
    // expo/fetch uploads expo-file-system files; it rejects `{ uri, name, type }` parts.
    body.append("file", file);
    body.append("model", settings.model);
    const response = await fetch(settings.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      body,
      redirect: "error", // A redirect could downgrade the upload to cleartext.
      signal: upload.signal,
    });
    if (!response.ok) throw new Error(`Transcription service responded with ${response.status}.`);
    const { text } = (await response.json()) as { text?: unknown };
    if (typeof text !== "string") throw new Error("Transcription service returned no text.");
    throwIfVoiceTranscriptionAborted(signal);
    return text.trim();
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    throw new VoiceTranscriptionError("transcription-failed", "Voice transcription failed.", {
      cause: error,
    });
  } finally {
    upload.abort(); // Stops reading a response body that was not consumed.
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
