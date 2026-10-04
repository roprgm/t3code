import { beforeEach, expect, it, vi } from "vite-plus/test";

const fs = vi.hoisted(() => new Set<string>());
const drafts = vi.hoisted(() => new Map<string, string>());
const transcribe = vi.hoisted(() => vi.fn<(uri: string) => Promise<string>>());

vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;
    constructor(parent: { uri: string }, name: string) {
      this.uri = `${parent.uri}/${name}`;
    }
    create() {}
    list() {
      return [...fs].filter((uri) => uri.startsWith(`${this.uri}/`)).map((uri) => new File(uri));
    }
  }
  class File {
    uri: string;
    constructor(parentOrUri: { uri: string } | string, name?: string) {
      this.uri = typeof parentOrUri === "string" ? parentOrUri : `${parentOrUri.uri}/${name}`;
    }
    get name() {
      return this.uri.slice(this.uri.lastIndexOf("/") + 1);
    }
    get exists() {
      return fs.has(this.uri);
    }
    delete() {
      fs.delete(this.uri);
    }
    moveSync(destination: File) {
      fs.delete(this.uri);
      fs.add(destination.uri);
      this.uri = destination.uri;
    }
  }
  return { Directory, File, Paths: { document: { uri: "file:///docs" } } };
});
vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove() {} }) },
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: (key: string) => ({ text: drafts.get(key) ?? "" }),
  appendComposerDraftText: (key: string, text: string) =>
    drafts.set(key, (drafts.get(key) ?? "") + text),
}));
vi.mock("./voiceTranscriber", () => ({
  getVoiceTranscriber: () => ({
    prepare: async () => ({ locale: "es", transcribe: (uri: string) => transcribe(uri) }),
  }),
}));

beforeEach(() => {
  fs.clear();
  drafts.clear();
  transcribe.mockReset();
  vi.resetModules();
});

const loadOutbox = () => import("./voiceRecordingOutbox");

it("keeps a recording that failed and appends its transcript to the draft later", async () => {
  const outbox = await loadOutbox();
  fs.add("file:///cache/recording.m4a");
  drafts.set("thread", "Draft so far");

  outbox.keepRecording("file:///cache/recording.m4a", "thread");
  expect(fs.has("file:///cache/recording.m4a")).toBe(false);

  transcribe.mockRejectedValueOnce(new Error("offline"));
  outbox.deliverPendingRecordings();
  await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
  expect(drafts.get("thread")).toBe("Draft so far");

  transcribe.mockResolvedValueOnce(" Hola mundo. ");
  await vi.waitFor(() => {
    outbox.deliverPendingRecordings();
    expect(drafts.get("thread")).toBe("Draft so far Hola mundo.");
  });
  expect(fs.size).toBe(0);
});

it("recovers recordings left from before the app restarted", async () => {
  fs.add(`file:///docs/voice-outbox/1000_${encodeURIComponent("env:thread")}.m4a`);
  transcribe.mockResolvedValueOnce("Recuperado.");
  const outbox = await loadOutbox();

  outbox.deliverPendingRecordings();

  await vi.waitFor(() => expect(drafts.get("env:thread")).toBe("Recuperado."));
});

it("keeps the recording's file format", async () => {
  const outbox = await loadOutbox();
  fs.add("file:///cache/recording.wav");
  transcribe.mockResolvedValueOnce("Hola.");

  outbox.keepRecording("file:///cache/recording.wav", "thread");
  outbox.deliverPendingRecordings();

  await vi.waitFor(() => expect(transcribe).toHaveBeenCalledWith(expect.stringMatching(/\.wav$/)));
});

it("waits while a recording is in progress", async () => {
  const outbox = await loadOutbox();
  fs.add("file:///cache/recording.m4a");
  transcribe.mockResolvedValueOnce("Hola.");
  outbox.keepRecording("file:///cache/recording.m4a", "thread");

  const resume = outbox.pauseRecordingDelivery();
  outbox.deliverPendingRecordings();
  expect(transcribe).not.toHaveBeenCalled();

  resume();
  await vi.waitFor(() => expect(drafts.get("thread")).toBe("Hola."));
});

it("drops recordings without speech and discards on request", async () => {
  const outbox = await loadOutbox();
  fs.add("file:///cache/silence.m4a");
  fs.add("file:///cache/other.m4a");
  transcribe.mockResolvedValueOnce("   ");

  outbox.keepRecording("file:///cache/silence.m4a", "thread");
  outbox.keepRecording("file:///cache/other.m4a", "other-thread");
  outbox.discardPendingRecordings("other-thread");
  outbox.deliverPendingRecordings();

  await vi.waitFor(() => expect(fs.size).toBe(0));
  expect(transcribe).toHaveBeenCalledTimes(1);
  expect(drafts.get("thread")).toBeUndefined();
});
