import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";
import { expect, it, vi } from "vite-plus/test";

import {
  createVoiceRecordingOutbox,
  type PendingVoiceRecording,
  type VoiceRecordingStorage,
} from "./voiceRecordingOutbox";

function setup(options: { readonly stored?: ReadonlyArray<PendingVoiceRecording> } = {}) {
  const files = new Map<string, PendingVoiceRecording>(
    (options.stored ?? []).map((recording) => [recording.id, recording]),
  );
  const storage: VoiceRecordingStorage = {
    load: async () => [...files.values()],
    save: async (recording) => void files.set(recording.id, recording),
    update: async (recording) => void files.set(recording.id, recording),
    remove: async (id) => void files.delete(id),
    audioUri: (id) => `file:///outbox/${id}.m4a`,
  };
  const transcribe = vi.fn<(uri: string) => Promise<string>>();
  const transcriber: VoiceTranscriber = {
    prepare: async () => ({ locale: "es", transcribe: (uri) => transcribe(uri) }),
  };
  const drafts = new Map<string, string>();
  let nextId = 0;
  const outbox = createVoiceRecordingOutbox({
    storage,
    getTranscriber: () => transcriber,
    readDraftText: (draftKey) => drafts.get(draftKey) ?? "",
    appendDraftText: (draftKey, text) => drafts.set(draftKey, (drafts.get(draftKey) ?? "") + text),
    now: () => new Date("2026-10-03T00:00:00Z"),
    createId: () => `rec-${++nextId}`,
  });
  return { outbox, files, transcribe, drafts };
}

it("keeps a recording whose transcription failed and delivers it later", async () => {
  const { outbox, files, transcribe, drafts } = setup();
  drafts.set("thread", "Draft so far");

  const id = await outbox.keep("file:///cache/recording.m4a", "thread");
  outbox.release(id!);
  transcribe.mockRejectedValueOnce(new Error("offline"));
  await expect(outbox.deliver()).resolves.toBe(false);
  expect(files.has(id!)).toBe(true);

  transcribe.mockResolvedValueOnce(" Hola mundo. ");
  await expect(outbox.deliver()).resolves.toBe(true);

  expect(transcribe).toHaveBeenLastCalledWith(`file:///outbox/${id}.m4a`);
  expect(drafts.get("thread")).toBe("Draft so far Hola mundo.");
  expect(files.size).toBe(0);
});

it("leaves a recording its composer still holds", async () => {
  const { outbox, files, transcribe, drafts } = setup();

  const id = await outbox.keep("file:///cache/recording.m4a", "thread");
  await outbox.deliver();
  expect(transcribe).not.toHaveBeenCalled();

  await outbox.complete(id!);
  expect(files.size).toBe(0);
  expect(drafts.get("thread")).toBeUndefined();
});

it("delivers a transcript the composer could not insert without transcribing again", async () => {
  const { outbox, transcribe, drafts } = setup();

  const id = await outbox.keep("file:///cache/recording.m4a", "thread");
  await outbox.setTranscript(id!, "Texto ya transcrito.");
  outbox.release(id!);
  await outbox.deliver();

  expect(transcribe).not.toHaveBeenCalled();
  expect(drafts.get("thread")).toBe("Texto ya transcrito.");
});

it("drops recordings without speech", async () => {
  const { outbox, files } = setup();

  const id = await outbox.keep("file:///cache/recording.m4a", "thread");
  await outbox.setTranscript(id!, "   ");

  expect(files.size).toBe(0);
  expect(outbox.snapshot()).toEqual([]);
});

it("recovers recordings saved before the app restarted", async () => {
  const { outbox, transcribe, drafts } = setup({
    stored: [
      { id: "old", draftKey: "thread", createdAt: "2026-10-02T00:00:00Z", transcript: null },
    ],
  });
  transcribe.mockResolvedValueOnce("Recuperado.");

  await outbox.deliver();

  expect(drafts.get("thread")).toBe("Recuperado.");
});

it("discards a recording on request", async () => {
  const { outbox, files, transcribe } = setup();

  const id = await outbox.keep("file:///cache/recording.m4a", "thread");
  outbox.release(id!);
  await outbox.discard(id!);
  await outbox.deliver();

  expect(files.size).toBe(0);
  expect(transcribe).not.toHaveBeenCalled();
});
