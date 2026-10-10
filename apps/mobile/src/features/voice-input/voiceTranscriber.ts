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

/** What the user chose in Settings → Voice input. */
export type VoiceTranscriberChoice = {
  readonly cloud: boolean;
  readonly language: string | undefined;
};

/** The cloud service when chosen and saved, otherwise on-device transcription. */
export function getVoiceTranscriber(choice: VoiceTranscriberChoice): VoiceTranscriber | null {
  const settings = choice.cloud ? getCloudTranscriptionSettings() : null;
  if (!settings) return getLocalVoiceTranscriber(choice.language);
  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      return {
        // The service detects the spoken language; the locale only shapes transcript spacing.
        locale: choice.language ?? Intl.DateTimeFormat().resolvedOptions().locale,
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
