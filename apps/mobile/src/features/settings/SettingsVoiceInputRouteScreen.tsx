import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  DEFAULT_CLOUD_TRANSCRIPTION,
  saveCloudTranscriptionSettings,
  useCloudTranscriptionSettings,
} from "../voice-input/voiceTranscriptionSettings";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSection } from "./components/SettingsSection";

// Locales Apple's on-device transcriber supports; its native module does not expose the list.
const LANGUAGES = [
  { locale: undefined, label: "Automatic", description: "Uses the app's language." },
  { locale: "en-US", label: "English (US)", description: "English (United States)" },
  { locale: "en-GB", label: "English (UK)", description: "English (United Kingdom)" },
  { locale: "es-ES", label: "Español (España)", description: "Spanish (Spain)" },
  { locale: "es-MX", label: "Español (México)", description: "Spanish (Mexico)" },
  { locale: "fr-FR", label: "Français", description: "French" },
  { locale: "de-DE", label: "Deutsch", description: "German" },
  { locale: "it-IT", label: "Italiano", description: "Italian" },
  { locale: "pt-BR", label: "Português (Brasil)", description: "Portuguese (Brazil)" },
  { locale: "ja-JP", label: "日本語", description: "Japanese" },
  { locale: "ko-KR", label: "한국어", description: "Korean" },
  { locale: "zh-CN", label: "中文（普通话）", description: "Chinese (Mandarin)" },
] as const;

const EMPTY_SERVICE = { ...DEFAULT_CLOUD_TRANSCRIPTION, apiKey: "" };

export function SettingsVoiceInputRouteScreen() {
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null;
  const cloudSelected = preferences?.voiceInputCloud === true;
  const saved = useCloudTranscriptionSettings();
  const [draft, setDraft] = useState(() => saved ?? EMPTY_SERVICE);

  // Like other settings fields, the service saves when editing ends, once it is complete.
  const commit = () => {
    const settings = {
      url: draft.url.trim(),
      model: draft.model.trim(),
      apiKey: draft.apiKey.trim(),
    };
    const complete = settings.url.startsWith("https://") && settings.model && settings.apiKey;
    if (!complete || JSON.stringify(settings) === JSON.stringify(saved)) return;
    saveCloudTranscriptionSettings(settings).catch(() =>
      Alert.alert("Could not save", "The key could not be stored on this device."),
    );
  };

  const removeKey = () =>
    Alert.alert("Remove API key?", "Voice input uses on-device transcription until you add one.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove key",
        style: "destructive",
        onPress: () => {
          saveCloudTranscriptionSettings(null)
            .then(() => setDraft(EMPTY_SERVICE))
            .catch(() => Alert.alert("Could not remove the key", "Try again."));
        },
      },
    ]);

  const field = (key: keyof typeof draft, label: string, placeholder: string) => (
    <View className="gap-2 px-4 py-3">
      <Text className="text-sm font-t3-medium text-foreground-muted">{label}</Text>
      <AppTextInput
        accessibilityLabel={label}
        className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
        placeholder={placeholder}
        secureTextEntry={key === "apiKey"}
        keyboardType={key === "url" ? "url" : "default"}
        autoCapitalize="none"
        autoCorrect={false}
        value={draft[key]}
        // A new endpoint must not inherit the previous service's key.
        onChangeText={(value) =>
          setDraft({ ...draft, ...(key === "url" && { apiKey: "" }), [key]: value })
        }
        onEndEditing={commit}
      />
    </View>
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Transcription">
          <SettingsChoiceRow
            label="On this device"
            description={
              getLocalVoiceTranscriber()
                ? "Uses the device's speech recognition."
                : "Not available on this device."
            }
            selected={preferences !== null && !cloudSelected}
            separated={false}
            disabled={!preferencesReady}
            onPress={() => savePreferences({ voiceInputCloud: false })}
          />
          <SettingsChoiceRow
            label="Cloud service"
            description="Sends recordings to an OpenAI-compatible transcription API with your key."
            selected={cloudSelected}
            separated
            disabled={!preferencesReady}
            onPress={() => savePreferences({ voiceInputCloud: true })}
          />
        </SettingsSection>
        {cloudSelected ? (
          <>
            <SettingsSection title="Service">
              {field("url", "Endpoint", DEFAULT_CLOUD_TRANSCRIPTION.url)}
              {field("model", "Model", DEFAULT_CLOUD_TRANSCRIPTION.model)}
              {field("apiKey", "API key", "sk-…")}
            </SettingsSection>
            <Text className="px-2 text-sm text-foreground-muted">
              Saved once all three are filled in, and the endpoint must use https. Until a service
              is saved, voice input uses on-device transcription. Your key stays in this device's
              secure storage and is only sent to this service.
            </Text>
            {saved ? (
              <SettingsSection>
                <SettingsActionRow
                  icon="trash"
                  label="Remove API key"
                  tone="danger"
                  onPress={removeKey}
                />
              </SettingsSection>
            ) : null}
          </>
        ) : (
          <>
            <SettingsSection title="Language">
              {LANGUAGES.map((option, index) => (
                <SettingsChoiceRow
                  key={option.label}
                  label={option.label}
                  description={option.description}
                  selected={preferences?.voiceInputLanguage === option.locale}
                  separated={index > 0}
                  disabled={!preferencesReady}
                  onPress={() => savePreferences({ voiceInputLanguage: option.locale })}
                />
              ))}
            </SettingsSection>
            <Text className="px-2 text-sm text-foreground-muted">
              The language you speak when dictating on this device.
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}
