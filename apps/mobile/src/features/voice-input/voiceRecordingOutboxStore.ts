import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { writeFileAtomically } from "../../lib/atomic-file";
import { appendComposerDraftText, getComposerDraftSnapshot } from "../../state/use-composer-drafts";
import {
  createVoiceRecordingOutbox,
  type PendingVoiceRecording,
  type VoiceRecordingStorage,
} from "./voiceRecordingOutbox";
import { getVoiceTranscriber } from "./voiceTranscriber";

const VOICE_OUTBOX_DIRECTORY = "voice-outbox";
const RETRY_DELAY_MS = 30_000;

async function getDirectory() {
  const { Directory, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, VOICE_OUTBOX_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

async function getFile(name: string) {
  const { File } = await import("expo-file-system");
  return new File(await getDirectory(), name);
}

let directoryUri = "";

const expoVoiceRecordingStorage: VoiceRecordingStorage = {
  load: async () => {
    const { File } = await import("expo-file-system");
    const directory = await getDirectory();
    directoryUri = directory.uri;
    const recordings: PendingVoiceRecording[] = [];
    for (const entry of directory.list()) {
      if (!(entry instanceof File) || !entry.name.endsWith(".json")) continue;
      try {
        recordings.push(JSON.parse(await entry.text()) as PendingVoiceRecording);
      } catch {
        // An unreadable record keeps its audio on disk for manual recovery.
      }
    }
    return [...recordings].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
  save: async (recording, sourceUri) => {
    const { File } = await import("expo-file-system");
    const audio = await getFile(`${recording.id}.m4a`);
    await new File(sourceUri).copy(audio);
    await writeFileAtomically(await getFile(`${recording.id}.json`), JSON.stringify(recording));
  },
  update: async (recording) => {
    await writeFileAtomically(await getFile(`${recording.id}.json`), JSON.stringify(recording));
  },
  remove: async (id) => {
    for (const name of [`${id}.json`, `${id}.m4a`]) {
      const file = await getFile(name);
      if (file.exists) file.delete();
    }
  },
  audioUri: (id) => `${directoryUri.replace(/\/?$/, "/")}${id}.m4a`,
};

export const voiceRecordingOutbox = createVoiceRecordingOutbox({
  storage: expoVoiceRecordingStorage,
  getTranscriber: getVoiceTranscriber,
  readDraftText: (draftKey) => getComposerDraftSnapshot(draftKey).text,
  appendDraftText: appendComposerDraftText,
  now: () => new Date(),
  createId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
});

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let activeVoiceSessions = 0;

/** Delivers waiting recordings now, then again later while any still fail. */
export function deliverPendingVoiceRecordings(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  // Native transcription runs one operation at a time, so retries wait for capture to finish.
  if (activeVoiceSessions > 0) return;
  void voiceRecordingOutbox.deliver().then((allDelivered) => {
    if (allDelivered || retryTimer || AppState.currentState !== "active") return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      deliverPendingVoiceRecordings();
    }, RETRY_DELAY_MS);
  });
}

/** Holds delivery while a composer records or transcribes; delivers once it ends. */
export function holdVoiceRecordingDelivery(): () => void {
  activeVoiceSessions += 1;
  return () => {
    activeVoiceSessions -= 1;
    deliverPendingVoiceRecordings();
  };
}

let foregroundTriggerInstalled = false;

/** Recordings waiting for a draft, with delivery retried whenever the app returns to the foreground. */
export function usePendingVoiceRecordings(draftKey: string | null) {
  const recordings = useSyncExternalStore(
    voiceRecordingOutbox.subscribe,
    voiceRecordingOutbox.snapshot,
  );
  useEffect(() => {
    if (!draftKey) return;
    if (!foregroundTriggerInstalled) {
      foregroundTriggerInstalled = true;
      AppState.addEventListener("change", (state) => {
        if (state === "active") deliverPendingVoiceRecordings();
      });
    }
    deliverPendingVoiceRecordings();
  }, [draftKey]);
  return useMemo(
    () => (draftKey ? recordings.filter((recording) => recording.draftKey === draftKey) : []),
    [draftKey, recordings],
  );
}
