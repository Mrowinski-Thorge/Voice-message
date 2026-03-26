# 🎙️ VoiceNote Analyzer

WhatsApp Sprachnachricht weiterleiten → Gemini analysiert → Overlay von unten.

## Deploy (alles im Browser / Smartphone möglich)

### 1. GitHub Repo
- github.com → New repository → "VoiceNote"
- "uploading an existing file" → alle 6 Dateien hochladen
- Commit changes

### 2. Expo Account
- expo.dev → Sign up (kostenlos)
- Terminal oder Expo Dashboard

### 3. EAS Build (APK, kein PC nötig)
```bash
npm install -g eas-cli
eas login
cd VoiceNote
npm install
eas build:configure
eas build --platform android --profile preview
```
→ Nach ~15 Min: Download-Link für die APK

### 4. API Key
- aistudio.google.com/apikey → kostenlos
- In der App: ⚙️ Einstellungen → API-Key eintragen

## Nutzung
1. WhatsApp Sprachnachricht lang drücken
2. "Weiterleiten" → "VoiceNote" auswählen
3. App öffnet sich → Sheet von unten → fertig

## Features
- Dark / Light Mode (WhatsApp-Farbstil)
- Zusammenfassung: Kurz / Key Points / Ausführlich
- Deadline-Erkennung
- Wichtigkeit 1-10
- Verlauf mit "X Minuten gespart"
- Drag-to-expand Sheet
