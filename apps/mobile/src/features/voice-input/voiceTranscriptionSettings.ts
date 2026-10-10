import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

/** An OpenAI-compatible `/audio/transcriptions` service the user configured on this device. */
export type CloudTranscriptionSettings = {
  readonly url: string;
  readonly apiKey: string;
  readonly model: string;
};

export const DEFAULT_CLOUD_TRANSCRIPTION = {
  url: "https://api.openai.com/v1/audio/transcriptions",
  model: "gpt-transcribe",
} as const;

const STORAGE_KEY = "t3code.voice-transcription.cloud";

let cached: CloudTranscriptionSettings | null | undefined;
const listeners = new Set<() => void>();

/** Settings live in the Keychain, read once and then served from memory. */
export function getCloudTranscriptionSettings(): CloudTranscriptionSettings | null {
  if (cached === undefined) {
    try {
      const stored = JSON.parse(SecureStore.getItem(STORAGE_KEY) ?? "null") as unknown;
      const { url, apiKey, model } = (stored ?? {}) as Partial<CloudTranscriptionSettings>;
      const valid =
        [url, apiKey, model].every((value) => typeof value === "string" && value) &&
        url!.startsWith("https://");
      cached = valid ? (stored as CloudTranscriptionSettings) : null;
    } catch {
      return null; // Not cached, so a transient Keychain failure is retried on the next read.
    }
  }
  return cached;
}

export async function saveCloudTranscriptionSettings(
  settings: CloudTranscriptionSettings | null,
): Promise<void> {
  if (settings) {
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(settings), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } else await SecureStore.deleteItemAsync(STORAGE_KEY);
  cached = settings;
  for (const listener of listeners) listener();
}

/** Re-renders when the configured service changes, so voice input availability stays current. */
export function useCloudTranscriptionSettings(): CloudTranscriptionSettings | null {
  return useSyncExternalStore(subscribe, getCloudTranscriptionSettings);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
