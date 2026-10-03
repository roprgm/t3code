# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
client input that stays on the device, and only normal message submission sends
the resulting text. Shipped builds transcribe locally on supported iOS devices. Self-built apps
can instead send recordings to an OpenAI-compatible service configured at build
time (see the [mobile README](../../apps/mobile/README.md#voice-transcription-service));
environment-backed transcription is not implemented.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced.

The controller deletes its recording once an operation ends, whatever the outcome.
On mobile, the [recording outbox](../../apps/mobile/src/features/voice-input/voiceRecordingOutbox.ts)
copies each recording before transcription and removes the copy only after the
composer inserts the transcript. A failed, abandoned, or stale transcription is
retried later and appended to its draft instead of being lost.

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results.
