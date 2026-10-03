import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("expo-file-system", () => ({
  File: class extends Blob {
    constructor(readonly uri: string) {
      super(["audio"], { type: "audio/mp4" });
    }
  },
}));

import { getVoiceTranscriber } from "./voiceTranscriber";

beforeEach(() => {
  vi.stubEnv("EXPO_PUBLIC_TRANSCRIPTION_URL", "https://api.example.com/v1/audio/transcriptions");
  vi.stubEnv("EXPO_PUBLIC_TRANSCRIPTION_API_KEY", "secret");
  vi.stubEnv("EXPO_PUBLIC_TRANSCRIPTION_MODEL", "whisper-1");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function transcribe(signal = new AbortController().signal) {
  const prepared = await getVoiceTranscriber()!.prepare({ signal });
  return prepared.transcribe("file:///recording.m4a", { signal });
}

it("uploads the recording to the configured service and returns its text", async () => {
  const fetchMock = vi.fn(async () => Response.json({ text: " Hola mundo. " }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(transcribe()).resolves.toBe("Hola mundo.");
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://api.example.com/v1/audio/transcriptions");
  expect(init.headers).toEqual({ Authorization: "Bearer secret" });
  expect((init.body as FormData).get("model")).toBe("whisper-1");
  expect((init.body as FormData).get("file")).toBeInstanceOf(Blob);
});

it("retries network failures and transient statuses", async () => {
  vi.useFakeTimers();
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Network request failed"))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ text: "Hola." }));
  vi.stubGlobal("fetch", fetchMock);

  const result = transcribe();
  await vi.runAllTimersAsync();

  await expect(result).resolves.toBe("Hola.");
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("retries an attempt that never answers", async () => {
  vi.useFakeTimers();
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal!.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    )
    .mockResolvedValueOnce(Response.json({ text: "Hola." }));
  vi.stubGlobal("fetch", fetchMock);

  const result = transcribe();
  await vi.runAllTimersAsync();

  await expect(result).resolves.toBe("Hola.");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("does not retry a rejected request", async () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(transcribe()).rejects.toMatchObject({ code: "transcription-failed" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("stops retrying when cancelled", async () => {
  const controller = new AbortController();
  const fetchMock = vi.fn(async () => {
    controller.abort();
    throw new TypeError("Network request failed");
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(transcribe(controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
