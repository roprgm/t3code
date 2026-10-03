import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";

/** A recording kept on disk until its transcript reaches a draft. */
export type PendingVoiceRecording = {
  readonly id: string;
  readonly draftKey: string;
  readonly createdAt: string;
  readonly transcript: string | null;
};

export interface VoiceRecordingStorage {
  readonly load: () => Promise<ReadonlyArray<PendingVoiceRecording>>;
  /** Copies the recording beside its record so cache cleanup cannot remove it. */
  readonly save: (recording: PendingVoiceRecording, sourceUri: string) => Promise<void>;
  readonly update: (recording: PendingVoiceRecording) => Promise<void>;
  readonly remove: (id: string) => Promise<void>;
  readonly audioUri: (id: string) => string;
}

export type VoiceRecordingOutboxDependencies = {
  readonly storage: VoiceRecordingStorage;
  readonly getTranscriber: () => VoiceTranscriber | null;
  readonly readDraftText: (draftKey: string) => string;
  readonly appendDraftText: (draftKey: string, text: string) => void;
  readonly now: () => Date;
  readonly createId: () => string;
};

/**
 * Keeps recordings until their transcript lands in a draft. Recordings an
 * active composer still owns are held and skipped by delivery.
 */
export function createVoiceRecordingOutbox(dependencies: VoiceRecordingOutboxDependencies) {
  let recordings: ReadonlyArray<PendingVoiceRecording> = [];
  let loading: Promise<void> | null = null;
  let delivering: Promise<boolean> | null = null;
  const held = new Set<string>();
  const listeners = new Set<() => void>();

  const setRecordings = (next: ReadonlyArray<PendingVoiceRecording>) => {
    recordings = next;
    for (const listener of listeners) listener();
  };

  const ensureLoaded = () => {
    loading ??= dependencies.storage.load().then(setRecordings, () => undefined);
    return loading;
  };

  const remove = async (id: string) => {
    setRecordings(recordings.filter((recording) => recording.id !== id));
    await dependencies.storage.remove(id).catch(() => undefined);
  };

  const setTranscript = async (id: string, transcript: string) => {
    const recording = recordings.find((candidate) => candidate.id === id);
    if (!recording) return;
    if (transcript.trim().length === 0) {
      await remove(id);
      return;
    }
    const next = { ...recording, transcript: transcript.trim() };
    setRecordings(recordings.map((candidate) => (candidate.id === id ? next : candidate)));
    await dependencies.storage.update(next);
  };

  const deliverOne = async (recording: PendingVoiceRecording): Promise<boolean> => {
    let transcript = recording.transcript;
    if (transcript === null) {
      const transcriber = dependencies.getTranscriber();
      if (!transcriber) return false;
      const signal = new AbortController().signal;
      try {
        const prepared = await transcriber.prepare({ signal });
        transcript = await prepared.transcribe(dependencies.storage.audioUri(recording.id), {
          signal,
        });
      } catch {
        return false;
      }
      await setTranscript(recording.id, transcript);
      if (transcript.trim().length === 0) return true;
    }
    // Discarded while it was transcribing.
    if (!recordings.some((candidate) => candidate.id === recording.id)) return true;
    const draft = dependencies.readDraftText(recording.draftKey);
    const separator = draft.length === 0 || /\s$/.test(draft) ? "" : " ";
    dependencies.appendDraftText(recording.draftKey, `${separator}${transcript.trim()}`);
    await remove(recording.id);
    return true;
  };

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      void ensureLoaded();
      return () => listeners.delete(listener);
    },

    snapshot(): ReadonlyArray<PendingVoiceRecording> {
      return recordings;
    },

    /** Persists a recording before transcription and holds it for its composer. */
    async keep(sourceUri: string, draftKey: string): Promise<string | null> {
      await ensureLoaded();
      const recording: PendingVoiceRecording = {
        id: dependencies.createId(),
        draftKey,
        createdAt: dependencies.now().toISOString(),
        transcript: null,
      };
      try {
        await dependencies.storage.save(recording, sourceUri);
      } catch {
        return null;
      }
      held.add(recording.id);
      setRecordings([...recordings, recording]);
      return recording.id;
    },

    setTranscript,

    /** The composer inserted the transcript itself. */
    complete: remove,

    discard: remove,

    release(id: string): void {
      held.delete(id);
    },

    /** Transcribes and delivers unheld recordings. Resolves false if any are still waiting. */
    deliver(): Promise<boolean> {
      delivering ??= (async () => {
        await ensureLoaded();
        let allDelivered = true;
        for (const recording of recordings) {
          if (held.has(recording.id)) continue;
          held.add(recording.id);
          try {
            if (!(await deliverOne(recording))) allDelivered = false;
          } finally {
            held.delete(recording.id);
          }
        }
        return allDelivered;
      })().finally(() => {
        delivering = null;
      });
      return delivering;
    },
  };
}

export type VoiceRecordingOutbox = ReturnType<typeof createVoiceRecordingOutbox>;
