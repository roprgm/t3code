import { Directory, File, Paths } from "expo-file-system";
import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { appendComposerDraftText, getComposerDraftSnapshot } from "../../state/use-composer-drafts";
import { getVoiceTranscriber } from "./voiceTranscriber";

/** A recording whose transcript has not reached its draft. Its file name holds the draft key. */
type PendingRecording = { readonly file: File; readonly draftKey: string };

let recordings: ReadonlyArray<PendingRecording> | null = null;
let delivering = false;
let paused = 0;
const listeners = new Set<() => void>();

function outboxDirectory(): Directory {
  const directory = new Directory(Paths.document, "voice-outbox");
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

function pendingRecordings(): ReadonlyArray<PendingRecording> {
  recordings ??= outboxDirectory()
    .list()
    .flatMap((entry) => {
      const match = entry instanceof File ? /^\d+_(.+)\.\w+$/.exec(entry.name) : null;
      return match?.[1] ? [{ file: entry as File, draftKey: decodeURIComponent(match[1]) }] : [];
    })
    .sort((a, b) => a.file.name.localeCompare(b.file.name));
  return recordings;
}

function setRecordings(next: ReadonlyArray<PendingRecording>): void {
  recordings = next;
  for (const listener of listeners) listener();
}

function remove(recording: PendingRecording): void {
  if (recording.file.exists) recording.file.delete();
  setRecordings(pendingRecordings().filter((candidate) => candidate !== recording));
}

/** Moves a recording whose transcript did not reach its draft into the outbox. */
export function keepRecording(uri: string, draftKey: string): void {
  const source = new File(uri);
  if (!source.exists) return;
  const extension = /\.\w+$/.exec(source.name)?.[0] ?? ".m4a";
  const name = `${Date.now()}_${encodeURIComponent(draftKey).replaceAll(".", "%2E")}${extension}`;
  const pending = pendingRecordings(); // Load before moving so the new file is not listed twice.
  const file = new File(outboxDirectory(), name);
  source.moveSync(file);
  setRecordings([...pending, { file, draftKey }]);
}

/** Transcribes waiting recordings in order and appends each transcript to its draft. */
export function deliverPendingRecordings(): void {
  if (delivering || paused > 0) return;
  delivering = true;
  void (async () => {
    for (const recording of pendingRecordings()) {
      const transcriber = getVoiceTranscriber();
      if (!transcriber) return;
      const signal = new AbortController().signal;
      let transcript: string;
      try {
        const prepared = await transcriber.prepare({ signal });
        transcript = (await prepared.transcribe(recording.file.uri, { signal })).trim();
      } catch {
        return; // Retried when the app returns to the foreground or a composer opens.
      }
      if (transcript && recording.file.exists) {
        const draft = getComposerDraftSnapshot(recording.draftKey).text;
        const separator = draft.length === 0 || /\s$/.test(draft) ? "" : " ";
        appendComposerDraftText(recording.draftKey, `${separator}${transcript}`);
      }
      remove(recording);
    }
  })().finally(() => {
    delivering = false;
  });
}

/** On-device transcription runs one operation at a time, so delivery waits for capture to end. */
export function pauseRecordingDelivery(): () => void {
  paused += 1;
  return () => {
    paused -= 1;
    deliverPendingRecordings();
  };
}

export function discardPendingRecordings(draftKey: string): void {
  for (const recording of pendingRecordings()) {
    if (recording.draftKey === draftKey) remove(recording);
  }
}

let foregroundListener: { remove: () => void } | null = null;

/** How many recordings wait for this draft; delivery retries when a composer opens or the app returns. */
export function usePendingRecordingCount(draftKey: string | null): number {
  const pending = useSyncExternalStore(subscribe, pendingRecordings);
  useEffect(() => {
    if (!draftKey) return;
    foregroundListener ??= AppState.addEventListener("change", (state) => {
      if (state === "active") deliverPendingRecordings();
    });
    deliverPendingRecordings();
  }, [draftKey]);
  return draftKey ? pending.filter((recording) => recording.draftKey === draftKey).length : 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
