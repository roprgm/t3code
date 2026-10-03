import { afterEach, expect, it, vi } from "vite-plus/test";

const keychain = vi.hoisted(() => new Map<string, string>());
const localTranscriber = vi.hoisted(() => ({ prepare: vi.fn() }));

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
  getItem: (key: string) => keychain.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void keychain.set(key, value),
  deleteItemAsync: async (key: string) => void keychain.delete(key),
}));

vi.mock("expo-file-system", () => ({
  File: class extends Blob {
    constructor(readonly uri: string) {
      super(["audio"], { type: "audio/mp4" });
    }
  },
}));

vi.mock("expo/fetch", () => ({
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));

vi.mock("../../native/voiceTranscription", () => ({
  getLocalVoiceTranscriber: () => localTranscriber,
}));

import { getVoiceTranscriber } from "./voiceTranscriber";
import { saveCloudTranscriptionSettings } from "./voiceTranscriptionSettings";

const service = {
  url: "https://api.example.com/v1/audio/transcriptions",
  apiKey: "secret",
  model: "gpt-transcribe",
};

afterEach(async () => {
  await saveCloudTranscriptionSettings(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function transcribe(signal = new AbortController().signal) {
  const prepared = await getVoiceTranscriber()!.prepare({ signal });
  return prepared.transcribe("file:///recording.m4a", { signal });
}

it("ignores stored settings that are incomplete", async () => {
  keychain.set("t3code.voice-transcription.cloud", JSON.stringify({ url: service.url }));
  vi.resetModules();
  const { getVoiceTranscriber: fresh } = await import("./voiceTranscriber");

  expect(fresh()).toBe(localTranscriber);
  keychain.clear();
});

it("uses on-device transcription until a cloud service is saved", async () => {
  expect(getVoiceTranscriber()).toBe(localTranscriber);

  await saveCloudTranscriptionSettings(service);
  expect(getVoiceTranscriber()).not.toBe(localTranscriber);

  await saveCloudTranscriptionSettings(null);
  expect(getVoiceTranscriber()).toBe(localTranscriber);
});

it("uploads the recording to the saved service and returns its text", async () => {
  await saveCloudTranscriptionSettings(service);
  const fetchMock = vi.fn(async () => Response.json({ text: " Hola mundo. " }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(transcribe()).resolves.toBe("Hola mundo.");
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(service.url);
  expect(init.headers).toEqual({ Authorization: "Bearer secret" });
  expect(init.redirect).toBe("error");
  expect((init.body as FormData).get("model")).toBe("gpt-transcribe");
  expect((init.body as FormData).has("file")).toBe(true);
});

it("fails on a rejected request or a response without text", async () => {
  await saveCloudTranscriptionSettings(service);
  let signal: AbortSignal | undefined;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    signal = init.signal!;
    return new Response(null, { status: 401 });
  });
  await expect(transcribe()).rejects.toMatchObject({ code: "transcription-failed" });
  expect(signal?.aborted).toBe(true);

  vi.stubGlobal("fetch", async () => Response.json({ error: "unexpected" }));
  await expect(transcribe()).rejects.toMatchObject({ code: "transcription-failed" });
});

it("fails an upload that never answers instead of transcribing forever", async () => {
  await saveCloudTranscriptionSettings(service);
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) =>
        init.signal!.addEventListener("abort", () => reject(new Error("aborted"))),
      ),
  );

  const result = expect(transcribe()).rejects.toMatchObject({ code: "transcription-failed" });
  await vi.runAllTimersAsync();
  await result;
});

it("ignores a stored service that does not use https", async () => {
  keychain.set("t3code.voice-transcription.cloud", JSON.stringify({ ...service, url: "http://x" }));
  vi.resetModules();
  const { getVoiceTranscriber: fresh } = await import("./voiceTranscriber");

  expect(fresh()).toBe(localTranscriber);
  keychain.clear();
});

it("aborts an upload in flight when the recording is cancelled", async () => {
  await saveCloudTranscriptionSettings(service);
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  vi.stubGlobal(
    "fetch",
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        started.resolve();
        init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );

  const result = transcribe(controller.signal);
  await started.promise;
  controller.abort();

  await expect(result).rejects.toMatchObject({ code: "cancelled" });
});

it("reports cancellation instead of failure", async () => {
  await saveCloudTranscriptionSettings(service);
  const controller = new AbortController();
  vi.stubGlobal("fetch", async () => {
    controller.abort();
    throw new TypeError("Network request failed");
  });

  await expect(transcribe(controller.signal)).rejects.toMatchObject({ code: "cancelled" });
});
