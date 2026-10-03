import { useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import {
  DEFAULT_CLOUD_TRANSCRIPTION,
  saveCloudTranscriptionSettings,
  useCloudTranscriptionSettings,
} from "../voice-input/voiceTranscriptionSettings";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSection } from "./components/SettingsSection";

const EMPTY_SERVICE = { ...DEFAULT_CLOUD_TRANSCRIPTION, apiKey: "" };

export function SettingsVoiceInputRouteScreen() {
  const insets = useSafeAreaInsets();
  const saved = useCloudTranscriptionSettings();
  const [cloudSelected, setCloudSelected] = useState(saved !== null);
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

  const chooseOnDevice = () => {
    if (!saved) {
      // Leaving a field may have started a save; deleting after it keeps on-device selected.
      setCloudSelected(false);
      void saveCloudTranscriptionSettings(null);
      return;
    }
    Alert.alert("Use on-device transcription?", "This removes your API key from this device.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove key",
        style: "destructive",
        onPress: () => {
          saveCloudTranscriptionSettings(null)
            .then(() => {
              setCloudSelected(false);
              setDraft(EMPTY_SERVICE);
            })
            .catch(() => Alert.alert("Could not remove the key", "Try again."));
        },
      },
    ]);
  };

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
            selected={!cloudSelected}
            separated={false}
            disabled={false}
            onPress={chooseOnDevice}
          />
          <SettingsChoiceRow
            label="Cloud service"
            description="Sends recordings to an OpenAI-compatible transcription API with your key."
            selected={cloudSelected}
            separated
            disabled={false}
            onPress={() => setCloudSelected(true)}
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
              Saved once all three are filled in, and the endpoint must use https; until then, any
              previously saved service stays in use. Your key stays in this device's secure storage
              and is only sent to this service.
            </Text>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
