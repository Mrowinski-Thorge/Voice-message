# 🎙️ VoiceNote Analyzer

Sprachnachricht von WhatsApp weiterleiten → KI analysiert sofort → Bottom Sheet mit Zusammenfassung, Deadline & Wichtigkeit.

---

## 📋 Voraussetzungen

- Node.js ≥ 18
- Android Studio (für den ersten Build)
- Expo CLI: `npm install -g expo-cli eas-cli`
- Gemini API Key: https://aistudio.google.com/apikey (kostenlos!)

---

## 🚀 Setup

```bash
# 1. Ins Projektverzeichnis
cd VoiceAnalyzer

# 2. Dependencies installieren
npm install

# 3. Expo Prebuild (generiert Android-Ordner)
npx expo prebuild --platform android

# 4. App auf Smartphone deployen (USB-Debugging aktivieren!)
npx expo run:android
```

> **Hinweis:** Beim ersten `prebuild` wird `android/` generiert. Danach nicht mehr löschen!

---

## 📱 APK bauen (ohne USB)

```bash
# EAS einrichten (einmalig)
eas login
eas build:configure

# APK bauen (lädt hoch, baut in Cloud, gibt Download-Link)
eas build --platform android --profile preview
```

In `eas.json` ist `preview` bereits als APK-Profil konfiguriert.

---

## 🎯 Benutzung

1. **API Key eintragen**: In der App → Tab "Einstellungen" → Gemini API Key eingeben
2. **Sprachnachricht in WhatsApp**: Lang drücken → Weiterleiten → "VoiceNote Analyzer" auswählen
3. **Fertig!** Die App öffnet sich, analysiert automatisch, zeigt Bottom Sheet

---

## 🔧 WhatsApp Share aktivieren

WhatsApp fragt beim ersten Mal, ob es die App als Ziel nutzen darf. Einmal bestätigen. Danach erscheint die App im Share-Menü.

---

## 📦 Genutzte Packages

| Package | Zweck |
|---|---|
| `react-native-receive-sharing-intent` | Audio von WhatsApp empfangen |
| `expo-file-system` | Audio-Datei als Base64 lesen |
| `@react-native-async-storage/async-storage` | Verlauf & API-Key speichern |
| `@react-navigation/bottom-tabs` | Tab-Navigation |
| `react-native-reanimated` | Smooth Bottom Sheet Animation |
