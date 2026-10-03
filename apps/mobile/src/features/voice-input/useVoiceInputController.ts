import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  useAudioRecorder,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AppState } from "react-native";
import { useSharedValue } from "react-native-reanimated";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { getVoiceTranscriber } from "./voiceTranscriber";
import {
  deliverPendingVoiceRecordings,
  holdVoiceRecordingDelivery,
  usePendingVoiceRecordings,
  voiceRecordingOutbox,
} from "./voiceRecordingOutboxStore";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import {
  VoiceInputController,
  VOICE_RECORDING_LIMIT_SECONDS,
  voiceInputBlocksSubmission,
  voiceInputFreezesEditor,
  type VoiceDraftSnapshot,
  type VoiceInputState,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { normalizeVoiceInputDecibels, VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";

const INITIAL_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const VOICE_METERING_INTERVAL_MS = 80;
const VOICE_RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
};

async function releaseVoiceRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({ allowsRecording: false });
  } finally {
    // Expo does not deactivate AVAudioSession when recording stops or its
    // category changes. Explicit deactivation resumes interrupted app audio.
    await setIsAudioActiveAsync(false);
  }
}

async function configureVoiceRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({
      allowsRecording: true,
      interruptionMode: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    });
    await setIsAudioActiveAsync(true);
  } catch (error) {
    try {
      await releaseVoiceRecordingAudio();
    } catch {
      // Keep the setup error. The controller has not started a recorder yet.
    }
    throw error;
  }
}

/**
 * Keeps each recording in the outbox until the composer inserts its transcript.
 * Failed, cancelled-by-navigation, and stale transcriptions reach the draft later.
 */
function keepRecordingsUntilInserted(
  transcriber: VoiceTranscriber,
  draftKey: string,
  pendingIdRef: { current: string | null },
  onKept: () => void,
): VoiceTranscriber {
  return {
    prepare: async (options) => {
      const prepared = await transcriber.prepare(options);
      return {
        locale: prepared.locale,
        transcribe: async (uri, transcribeOptions) => {
          const id = await voiceRecordingOutbox.keep(uri, draftKey);
          pendingIdRef.current = id;
          try {
            const transcript = await prepared.transcribe(uri, transcribeOptions);
            if (id) await voiceRecordingOutbox.setTranscript(id, transcript);
            return transcript;
          } finally {
            // The controller commits the transcript in the microtasks that follow.
            setTimeout(() => {
              if (!id) return;
              voiceRecordingOutbox.release(id);
              if (pendingIdRef.current === id) pendingIdRef.current = null;
              if (voiceRecordingOutbox.snapshot().some((recording) => recording.id === id)) {
                onKept();
              }
              deliverPendingVoiceRecordings();
            }, 0);
          }
        },
      };
    },
  };
}

export function useVoiceInputController(input: {
  readonly ownerKey: string | null;
  /** Draft that receives transcripts recovered after this composer is gone. */
  readonly draftKey?: string | null;
  readonly draftMessage: string;
  readonly selection: ComposerEditorSelection;
  readonly disabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
}) {
  const [state, setState] = useState<VoiceInputState>(INITIAL_STATE);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const keepAwakeId = useId();
  const keepAwakeSessionRef = useRef(0);
  const elapsedSecondsRef = useRef(0);
  const audioLevelsRef = useRef(Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0));
  const audioLevels = useSharedValue(audioLevelsRef.current);
  const controllerRef = useRef<VoiceInputController | null>(null);
  const previousDraftRef = useRef({ ownerKey: input.ownerKey, text: input.draftMessage });
  const revisionRef = useRef(0);
  if (
    previousDraftRef.current.ownerKey !== input.ownerKey ||
    previousDraftRef.current.text !== input.draftMessage
  ) {
    previousDraftRef.current = { ownerKey: input.ownerKey, text: input.draftMessage };
    revisionRef.current += 1;
  }
  const latestInputRef = useRef(input);
  latestInputRef.current = input;
  const pendingIdRef = useRef<string | null>(null);
  const pendingRecordings = usePendingVoiceRecordings(input.draftKey ?? null);

  const handleRecorderStatus = useCallback((status: RecordingStatus) => {
    controllerRef.current?.handleRecorderStatus({
      isFinished: status.isFinished,
      hasError: status.hasError || status.mediaServicesDidReset === true,
      error: status.error,
      url: status.url,
    });
  }, []);
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS, handleRecorderStatus);

  if (!controllerRef.current) {
    controllerRef.current = new VoiceInputController({
      recorder,
      getTranscriber: () => {
        const transcriber = getVoiceTranscriber();
        const draftKey = latestInputRef.current.draftKey;
        // A kept recording shows as pending, so its transcription error is redundant.
        const clearError = () => {
          const current = controllerRef.current;
          if (current?.currentState.phase === "error") current.cancel();
        };
        return transcriber && draftKey
          ? keepRecordingsUntilInserted(transcriber, draftKey, pendingIdRef, clearError)
          : transcriber;
      },
      requestPermission: async () => {
        const permission = await requestRecordingPermissionsAsync();
        return { granted: permission.granted, canAskAgain: permission.canAskAgain };
      },
      configureRecording: configureVoiceRecordingAudio,
      releaseRecording: releaseVoiceRecordingAudio,
      deleteRecording: (uri) => new File(uri).delete(),
      readDraft: (): VoiceDraftSnapshot | null => {
        const current = latestInputRef.current;
        if (!current.ownerKey) return null;
        return {
          ownerKey: current.ownerKey,
          text: current.draftMessage,
          selection: current.selection,
          revision: revisionRef.current,
        };
      },
      commitDraft: (text, selection) => {
        const current = latestInputRef.current;
        current.onChangeSelection(selection);
        current.onChangeDraftMessage(text);
        const pendingId = pendingIdRef.current;
        pendingIdRef.current = null;
        if (pendingId) void voiceRecordingOutbox.complete(pendingId);
      },
      onStateChange: setState,
    });
  }

  const controller = controllerRef.current;
  const previousOwnerRef = useRef(input.ownerKey);
  useEffect(() => {
    if (previousOwnerRef.current === input.ownerKey) return;
    previousOwnerRef.current = input.ownerKey;
    controller.ownerChanged();
  }, [controller, input.ownerKey]);

  useFocusEffect(
    useCallback(
      () => () => {
        controller.dispose();
      },
      [controller],
    ),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      // iOS reports `inactive` while its permission dialog is open. Only the
      // real background state cancels preparation; recorder status handles
      // calls and route interruptions during capture. A recording in progress
      // finishes instead of being discarded; the outbox keeps it if the
      // transcription cannot complete in the background.
      if (nextState !== "background") return;
      if (controller.currentState.phase === "recording" && latestInputRef.current.draftKey) {
        void controller.stop();
      } else {
        controller.appMovedToBackground();
      }
    });
    return () => subscription.remove();
  }, [controller]);

  useEffect(() => () => controller.dispose(), [controller]);

  const isVoiceSessionActive = voiceInputBlocksSubmission(state);
  useEffect(() => {
    if (isVoiceSessionActive) return holdVoiceRecordingDelivery();
  }, [isVoiceSessionActive]);

  useEffect(() => {
    if (state.phase !== "recording") return;

    const tag = `voice-input:${keepAwakeId}:${++keepAwakeSessionRef.current}`;
    const activation = activateKeepAwakeAsync(tag);
    void activation.catch(() => {});
    return () => {
      // Release after activation settles, even if the recording ends immediately.
      void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
    };
  }, [keepAwakeId, state.phase]);

  useEffect(() => {
    if (state.phase !== "preparing" && state.phase !== "recording") return;

    if (audioLevelsRef.current.some((level) => level !== 0)) {
      audioLevelsRef.current = Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0);
      audioLevels.value = audioLevelsRef.current;
    }
    if (elapsedSecondsRef.current !== 0) {
      elapsedSecondsRef.current = 0;
      setElapsedSeconds(0);
    }
    if (state.phase !== "recording") return;

    const sampleRecording = () => {
      if (controller.currentState.phase !== "recording") return;
      const status = recorder.getStatus();
      if (!status.isRecording) return;

      const level = normalizeVoiceInputDecibels(status.metering);
      const history = audioLevelsRef.current;
      if (level !== 0 || history.some((sample) => sample !== 0)) {
        const nextLevels = [...history.slice(1), level];
        audioLevelsRef.current = nextLevels;
        audioLevels.value = nextLevels;
      }

      const nextElapsedSeconds = Math.min(
        VOICE_RECORDING_LIMIT_SECONDS,
        Math.max(0, Math.floor(status.durationMillis / 1_000)),
      );
      if (nextElapsedSeconds !== elapsedSecondsRef.current) {
        elapsedSecondsRef.current = nextElapsedSeconds;
        setElapsedSeconds(nextElapsedSeconds);
      }
    };

    sampleRecording();
    const intervalId = setInterval(sampleRecording, VOICE_METERING_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [audioLevels, controller, recorder, state.phase]);

  const start = useCallback(() => {
    if (!latestInputRef.current.disabled) void controller.start();
  }, [controller]);
  const stop = useCallback(() => controller.stop(), [controller]);
  const cancel = useCallback(() => {
    // Cancelling a transcription is a choice to drop it, unlike leaving the thread.
    const pendingId = pendingIdRef.current;
    if (controller.currentState.phase === "transcribing" && pendingId) {
      pendingIdRef.current = null;
      void voiceRecordingOutbox.discard(pendingId);
    }
    controller.cancel();
  }, [controller]);
  const retryPending = useCallback(() => deliverPendingVoiceRecordings(), []);
  const discardPending = useCallback(() => {
    for (const recording of pendingRecordings) void voiceRecordingOutbox.discard(recording.id);
  }, [pendingRecordings]);

  return {
    // Store screenshots show the dictation button even on simulators, whose
    // on-device transcription is unavailable.
    isAvailable: getVoiceTranscriber() !== null || getNativeShowcaseScene() !== null,
    state,
    audioLevels,
    elapsedSeconds,
    isBusy: voiceInputBlocksSubmission(state),
    freezesEditor: voiceInputFreezesEditor(state),
    blocksSubmission: voiceInputBlocksSubmission(state),
    start,
    stop,
    cancel,
    pendingCount: pendingRecordings.length,
    retryPending,
    discardPending,
  };
}
