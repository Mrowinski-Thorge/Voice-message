/**
 * VoiceNote Analyzer
 * Sprachnachricht von WhatsApp → Gemini 2.5 Flash-Lite → Zusammenfassung
 */

import React, {
  useEffect,
  useState,
  useRef,
  useCallback,
} from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  TouchableOpacity,
  TouchableWithoutFeedback,
  ScrollView,
  TextInput,
  Alert,
  StatusBar,
  Dimensions,
  Platform,
  Linking,
  ActivityIndicator,
  KeyboardAvoidingView,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import ReceiveSharingIntent from 'react-native-receive-sharing-intent';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

export interface AnalysisResult {
  id: string;
  timestamp: number;
  duration_seconds: number;
  summary_short: string;
  summary_keypoints: string[];
  summary_full: string;
  deadline: string | null;
  importance: number; // 1–10
  language: string;
  file_name: string;
}

type DetailLevel = 'short' | 'keypoints' | 'full';

// ─────────────────────────────────────────────
// CONSTANTS & COLORS
// ─────────────────────────────────────────────

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const SHEET_HEIGHT = SCREEN_HEIGHT * 0.72;

const C = {
  bg: '#0f0f0f',
  surface: '#1a1a1a',
  card: '#222222',
  border: '#2e2e2e',
  accent: '#6c63ff',
  accentLight: '#8b83ff',
  green: '#22c55e',
  orange: '#f97316',
  red: '#ef4444',
  text: '#f2f2f2',
  textMuted: '#888888',
  textDim: '#555555',
  white: '#ffffff',
};

// ─────────────────────────────────────────────
// GEMINI API
// ─────────────────────────────────────────────

const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    mp3: 'audio/mp3',
    wav: 'audio/wav',
    m4a: 'audio/aac',
    aac: 'audio/aac',
    flac: 'audio/flac',
    aiff: 'audio/aiff',
  };
  return map[ext] ?? 'audio/ogg';
}

async function analyzeAudioWithGemini(
  fileUri: string,
  apiKey: string,
  detailLevel: DetailLevel = 'short'
): Promise<AnalysisResult> {
  // Read audio file as Base64
  let base64Data: string;
  try {
    base64Data = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
  } catch (e) {
    throw new Error(`Datei konnte nicht gelesen werden: ${e}`);
  }

  const mimeType = getMimeType(fileUri);

  const prompt = `Du bist ein KI-Assistent, der WhatsApp-Sprachnachrichten analysiert.
Analysiere diese Sprachnachricht und antworte NUR mit validem JSON, ohne Markdown-Backticks, ohne Präambel, nur reines JSON.

JSON-Format:
{
  "summary_short": "Eine einzige präzise Zusammenfassung in einem Satz (max 120 Zeichen)",
  "summary_keypoints": ["Wichtigster Punkt 1", "Wichtigster Punkt 2", "Wichtigster Punkt 3"],
  "summary_full": "Ausführliche Zusammenfassung in 2-3 Sätzen mit allen wichtigen Details",
  "deadline": "Erkannter Termin/Datum im Format 'Morgen 14:00 Uhr' oder null wenn keiner genannt",
  "importance": 7,
  "duration_seconds": 45,
  "language": "de"
}

Regeln:
- importance: 1-10 (10 = extrem dringend/wichtig, 1 = Smalltalk)
- Erhöhe importance wenn: Termin/Frist erwähnt (+3), dringende Formulierung (+2), Action-Item (+2)
- duration_seconds: Schätze die Dauer der Aufnahme
- language: Sprachcode der Nachricht (de, en, etc.)
- Antworte auf Deutsch falls die Nachricht auf Deutsch ist, sonst auf Englisch`;

  const response = await fetch(
    `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                inline_data: {
                  mime_type: mimeType,
                  data: base64Data,
                },
              },
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1024,
        },
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    if (response.status === 400) throw new Error('Ungültiges Audio-Format oder API-Key fehlt.');
    if (response.status === 403) throw new Error('API-Key ungültig. Bitte in Einstellungen prüfen.');
    throw new Error(`Gemini API Fehler (${response.status}): ${err.slice(0, 200)}`);
  }

  const data = await response.json();
  const rawText: string =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  // Strip potential markdown fences
  const clean = rawText.replace(/```json|```/g, '').trim();

  let parsed: any;
  try {
    parsed = JSON.parse(clean);
  } catch {
    throw new Error('Gemini hat kein gültiges JSON zurückgegeben.');
  }

  const fileName = fileUri.split('/').pop() ?? 'voice_note';

  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    duration_seconds: typeof parsed.duration_seconds === 'number' ? parsed.duration_seconds : 30,
    summary_short: parsed.summary_short ?? 'Keine Zusammenfassung verfügbar.',
    summary_keypoints: Array.isArray(parsed.summary_keypoints) ? parsed.summary_keypoints : [],
    summary_full: parsed.summary_full ?? parsed.summary_short ?? '',
    deadline: parsed.deadline ?? null,
    importance: typeof parsed.importance === 'number'
      ? Math.min(10, Math.max(1, Math.round(parsed.importance)))
      : 5,
    language: parsed.language ?? 'de',
    file_name: fileName,
  };
}

// ─────────────────────────────────────────────
// STORAGE
// ─────────────────────────────────────────────

const STORAGE_KEYS = {
  history: 'voice_history',
  apiKey: 'gemini_api_key',
};

async function saveResult(result: AnalysisResult): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.history);
    const existing: AnalysisResult[] = raw ? JSON.parse(raw) : [];
    const updated = [result, ...existing].slice(0, 50); // Max 50 Einträge
    await AsyncStorage.setItem(STORAGE_KEYS.history, JSON.stringify(updated));
  } catch (e) {
    console.error('Storage save error:', e);
  }
}

async function loadHistory(): Promise<AnalysisResult[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.history);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function getApiKey(): Promise<string> {
  try {
    return (await AsyncStorage.getItem(STORAGE_KEYS.apiKey)) ?? '';
  } catch {
    return '';
  }
}

async function setApiKey(key: string): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEYS.apiKey, key);
}

async function deleteHistoryItem(id: string): Promise<AnalysisResult[]> {
  const history = await loadHistory();
  const updated = history.filter((h) => h.id !== id);
  await AsyncStorage.setItem(STORAGE_KEYS.history, JSON.stringify(updated));
  return updated;
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function formatSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  if (isToday) return `Heute ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')} Uhr`;
  if (isYesterday) return `Gestern ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')} Uhr`;
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function importanceColor(imp: number): string {
  if (imp >= 8) return C.red;
  if (imp >= 5) return C.orange;
  return C.green;
}

function importanceLabel(imp: number): string {
  if (imp >= 8) return 'Dringend';
  if (imp >= 5) return 'Wichtig';
  return 'Normal';
}

// ─────────────────────────────────────────────
// ANALYSIS BOTTOM SHEET
// ─────────────────────────────────────────────

interface BottomSheetProps {
  result: AnalysisResult | null;
  loading: boolean;
  error: string | null;
  onDismiss: () => void;
}

function AnalysisBottomSheet({ result, loading, error, onDismiss }: BottomSheetProps) {
  const translateY = useRef(new Animated.Value(SHEET_HEIGHT)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const [detailLevel, setDetailLevel] = useState<DetailLevel>('short');
  const insets = useSafeAreaInsets();

  const visible = loading || !!result || !!error;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0,
          useNativeDriver: true,
          tension: 65,
          friction: 11,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: SHEET_HEIGHT,
          duration: 280,
          useNativeDriver: true,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 0,
          duration: 250,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible]);

  if (!visible) return null;

  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="box-none">
      {/* Backdrop */}
      <TouchableWithoutFeedback onPress={onDismiss}>
        <Animated.View
          style={[
            styles.backdrop,
            { opacity: backdropOpacity },
          ]}
        />
      </TouchableWithoutFeedback>

      {/* Sheet */}
      <Animated.View
        style={[
          styles.sheet,
          {
            height: SHEET_HEIGHT,
            paddingBottom: insets.bottom + 8,
            transform: [{ translateY }],
          },
        ]}
      >
        {/* Handle */}
        <View style={styles.sheetHandle} />

        {loading && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={C.accent} />
            <Text style={styles.loadingTitle}>Analysiere Sprachnachricht…</Text>
            <Text style={styles.loadingSubtitle}>Gemini 2.5 Flash-Lite hört zu</Text>
          </View>
        )}

        {error && !loading && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorIcon}>⚠️</Text>
            <Text style={styles.errorTitle}>Fehler</Text>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity style={styles.dismissBtn} onPress={onDismiss}>
              <Text style={styles.dismissBtnText}>Schließen</Text>
            </TouchableOpacity>
          </View>
        )}

        {result && !loading && (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 16 }}
          >
            {/* Header Row */}
            <View style={styles.sheetHeader}>
              <View>
                <Text style={styles.sheetTitle}>🎙️ Sprachnachricht</Text>
                <Text style={styles.sheetMeta}>
                  {formatSeconds(result.duration_seconds)} • {formatDate(result.timestamp)}
                </Text>
              </View>
              <TouchableOpacity onPress={onDismiss} style={styles.closeBtn}>
                <Text style={styles.closeBtnText}>✕</Text>
              </TouchableOpacity>
            </View>

            {/* Importance + Deadline Row */}
            <View style={styles.badgeRow}>
              <View style={[styles.badge, { backgroundColor: importanceColor(result.importance) + '22', borderColor: importanceColor(result.importance) + '55' }]}>
                <View style={[styles.badgeDot, { backgroundColor: importanceColor(result.importance) }]} />
                <Text style={[styles.badgeText, { color: importanceColor(result.importance) }]}>
                  {importanceLabel(result.importance)} · {result.importance}/10
                </Text>
              </View>
              {result.deadline && (
                <View style={[styles.badge, { backgroundColor: '#6c63ff22', borderColor: '#6c63ff55' }]}>
                  <Text style={[styles.badgeText, { color: C.accentLight }]}>
                    📅 {result.deadline}
                  </Text>
                </View>
              )}
            </View>

            {/* Detail Level Toggle */}
            <View style={styles.toggleRow}>
              {(['short', 'keypoints', 'full'] as DetailLevel[]).map((level) => {
                const labels: Record<DetailLevel, string> = {
                  short: 'Kurz',
                  keypoints: 'Key Points',
                  full: 'Ausführlich',
                };
                return (
                  <TouchableOpacity
                    key={level}
                    style={[
                      styles.toggleBtn,
                      detailLevel === level && styles.toggleBtnActive,
                    ]}
                    onPress={() => setDetailLevel(level)}
                  >
                    <Text
                      style={[
                        styles.toggleBtnText,
                        detailLevel === level && styles.toggleBtnTextActive,
                      ]}
                    >
                      {labels[level]}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Summary Content */}
            <View style={styles.summaryBox}>
              {detailLevel === 'short' && (
                <Text style={styles.summaryShort}>{result.summary_short}</Text>
              )}

              {detailLevel === 'keypoints' && (
                <View>
                  {result.summary_keypoints.map((point, i) => (
                    <View key={i} style={styles.keypointRow}>
                      <View style={styles.keypointDot} />
                      <Text style={styles.keypointText}>{point}</Text>
                    </View>
                  ))}
                  {result.summary_keypoints.length === 0 && (
                    <Text style={styles.summaryShort}>{result.summary_short}</Text>
                  )}
                </View>
              )}

              {detailLevel === 'full' && (
                <Text style={styles.summaryFull}>{result.summary_full}</Text>
              )}
            </View>

            {/* Importance Bar */}
            <View style={styles.importanceSection}>
              <Text style={styles.importanceLabel}>Wichtigkeit</Text>
              <View style={styles.importanceBarBg}>
                <View
                  style={[
                    styles.importanceBarFill,
                    {
                      width: `${result.importance * 10}%` as any,
                      backgroundColor: importanceColor(result.importance),
                    },
                  ]}
                />
              </View>
              <View style={styles.importanceNumbers}>
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <Text
                    key={n}
                    style={[
                      styles.importanceNum,
                      n === result.importance && { color: importanceColor(result.importance) },
                    ]}
                  >
                    {n}
                  </Text>
                ))}
              </View>
            </View>

            {/* Dismiss */}
            <TouchableOpacity style={styles.mainDismissBtn} onPress={onDismiss}>
              <Text style={styles.mainDismissBtnText}>Fertig ✓</Text>
            </TouchableOpacity>
          </ScrollView>
        )}
      </Animated.View>
    </View>
  );
}

// ─────────────────────────────────────────────
// HISTORY SCREEN
// ─────────────────────────────────────────────

function HistoryScreen({ sharedFileUri }: { sharedFileUri: string | null }) {
  const [history, setHistory] = useState<AnalysisResult[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const processedUri = useRef<string | null>(null);

  const insets = useSafeAreaInsets();

  useEffect(() => {
    loadHistory().then(setHistory);
  }, []);

  const processAudio = useCallback(async (fileUri: string) => {
    if (processedUri.current === fileUri) return;
    processedUri.current = fileUri;

    const apiKey = await getApiKey();
    if (!apiKey) {
      setError('Kein Gemini API-Key gesetzt. Bitte in Einstellungen eintragen.');
      setSheetOpen(true);
      return;
    }

    setResult(null);
    setError(null);
    setAnalyzing(true);
    setSheetOpen(true);

    try {
      const res = await analyzeAudioWithGemini(fileUri, apiKey);
      await saveResult(res);
      setResult(res);
      setHistory((prev) => [res, ...prev]);
    } catch (e: any) {
      setError(e?.message ?? 'Unbekannter Fehler');
    } finally {
      setAnalyzing(false);
    }
  }, []);

  // Trigger analysis when a file is shared
  useEffect(() => {
    if (sharedFileUri && sharedFileUri !== processedUri.current) {
      processAudio(sharedFileUri);
    }
  }, [sharedFileUri, processAudio]);

  const totalSecondsHeard = history.reduce((sum, h) => sum + h.duration_seconds, 0);
  const totalMinutes = Math.floor(totalSecondsHeard / 60);

  const handleDelete = async (id: string) => {
    const updated = await deleteHistoryItem(id);
    setHistory(updated);
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32 }}>
        {/* Stats Header */}
        <View style={styles.statsHeader}>
          <Text style={styles.appTitle}>VoiceNote Analyzer</Text>
          <View style={styles.statsRow}>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{history.length}</Text>
              <Text style={styles.statLabel}>Nachrichten</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{totalMinutes}m</Text>
              <Text style={styles.statLabel}>Zeit gespart</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>
                {history.length > 0
                  ? (history.reduce((s, h) => s + h.importance, 0) / history.length).toFixed(1)
                  : '–'}
              </Text>
              <Text style={styles.statLabel}>Ø Wichtigkeit</Text>
            </View>
          </View>
        </View>

        {/* Empty State */}
        {history.length === 0 && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>🎙️</Text>
            <Text style={styles.emptyTitle}>Noch keine Nachrichten</Text>
            <Text style={styles.emptyText}>
              Leite eine WhatsApp-Sprachnachricht an diese App weiter, um loszulegen.
            </Text>
            <View style={styles.emptySteps}>
              <Text style={styles.emptyStep}>1. Sprachnachricht in WhatsApp lang drücken</Text>
              <Text style={styles.emptyStep}>2. "Weiterleiten" → "VoiceNote Analyzer"</Text>
              <Text style={styles.emptyStep}>3. Fertig! Zusammenfassung erscheint sofort</Text>
            </View>
          </View>
        )}

        {/* History List */}
        {history.length > 0 && (
          <View style={styles.historySection}>
            <Text style={styles.sectionTitle}>Verlauf</Text>
            {history.map((item) => (
              <TouchableOpacity
                key={item.id}
                style={styles.historyCard}
                onPress={() => {
                  setResult(item);
                  setSheetOpen(true);
                }}
                onLongPress={() => {
                  Alert.alert(
                    'Eintrag löschen',
                    'Diesen Eintrag aus dem Verlauf entfernen?',
                    [
                      { text: 'Abbrechen', style: 'cancel' },
                      { text: 'Löschen', style: 'destructive', onPress: () => handleDelete(item.id) },
                    ]
                  );
                }}
              >
                <View style={styles.historyCardHeader}>
                  <View style={styles.historyCardLeft}>
                    <View
                      style={[
                        styles.importanceDot,
                        { backgroundColor: importanceColor(item.importance) },
                      ]}
                    />
                    <Text style={styles.historyCardDate}>{formatDate(item.timestamp)}</Text>
                  </View>
                  <View style={styles.historyCardRight}>
                    <Text style={styles.historyCardDuration}>{formatSeconds(item.duration_seconds)}</Text>
                    <Text style={[styles.historyCardImp, { color: importanceColor(item.importance) }]}>
                      {item.importance}/10
                    </Text>
                  </View>
                </View>
                <Text style={styles.historyCardSummary} numberOfLines={2}>
                  {item.summary_short}
                </Text>
                {item.deadline && (
                  <View style={styles.historyDeadlineBadge}>
                    <Text style={styles.historyDeadlineText}>📅 {item.deadline}</Text>
                  </View>
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>

      {/* Bottom Sheet */}
      {sheetOpen && (
        <AnalysisBottomSheet
          result={result}
          loading={analyzing}
          error={error}
          onDismiss={() => {
            setSheetOpen(false);
            setResult(null);
            setError(null);
          }}
        />
      )}
    </View>
  );
}

// ─────────────────────────────────────────────
// SETTINGS SCREEN
// ─────────────────────────────────────────────

function SettingsScreen() {
  const [apiKey, setApiKeyState] = useState('');
  const [saved, setSaved] = useState(false);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    getApiKey().then(setApiKeyState);
  }, []);

  const handleSave = async () => {
    if (!apiKey.trim()) {
      Alert.alert('Fehler', 'Bitte einen gültigen API-Key eingeben.');
      return;
    }
    await setApiKey(apiKey.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
        <Text style={styles.settingsTitle}>Einstellungen</Text>

        {/* API Key Section */}
        <View style={styles.settingsSection}>
          <Text style={styles.settingsSectionTitle}>Gemini API Key</Text>
          <Text style={styles.settingsSectionDesc}>
            Kostenlos unter{' '}
            <Text
              style={{ color: C.accentLight }}
              onPress={() => Linking.openURL('https://aistudio.google.com/apikey')}
            >
              aistudio.google.com/apikey
            </Text>
          </Text>
          <View style={styles.apiKeyRow}>
            <TextInput
              style={styles.apiKeyInput}
              value={apiKey}
              onChangeText={setApiKeyState}
              placeholder="AIzaSy..."
              placeholderTextColor={C.textDim}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          <TouchableOpacity
            style={[styles.saveBtn, saved && styles.saveBtnSuccess]}
            onPress={handleSave}
          >
            <Text style={styles.saveBtnText}>{saved ? '✓ Gespeichert!' : 'API-Key speichern'}</Text>
          </TouchableOpacity>
        </View>

        {/* Model Info */}
        <View style={styles.settingsSection}>
          <Text style={styles.settingsSectionTitle}>KI-Modell</Text>
          <View style={styles.infoCard}>
            <Text style={styles.infoCardTitle}>Gemini 2.5 Flash-Lite</Text>
            <Text style={styles.infoCardDesc}>
              Googles schnellstes multimodales Modell. Versteht Audio direkt – keine Transkription nötig. Antwortet in unter 2 Sekunden.
            </Text>
            <Text style={styles.infoCardCost}>
              💰 ~0.000075$ pro Minute Audio (sehr günstig)
            </Text>
          </View>
        </View>

        {/* How it works */}
        <View style={styles.settingsSection}>
          <Text style={styles.settingsSectionTitle}>So funktioniert es</Text>
          <View style={styles.howItWorks}>
            {[
              ['🎙️', 'Sprachnachricht', 'In WhatsApp lang drücken → Weiterleiten → VoiceNote Analyzer'],
              ['🤖', 'KI-Analyse', 'Gemini hört die Nachricht und extrahiert Kerninfos'],
              ['📋', 'Ergebnis', 'Bottom Sheet zeigt Zusammenfassung, Deadline & Wichtigkeit'],
              ['📚', 'Verlauf', 'Alle Analysen werden gespeichert – Zeit gespart wird angezeigt'],
            ].map(([icon, title, desc], i) => (
              <View key={i} style={styles.howItWorksStep}>
                <Text style={styles.howItWorksIcon}>{icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.howItWorksTitle}>{title}</Text>
                  <Text style={styles.howItWorksDesc}>{desc}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─────────────────────────────────────────────
// TAB NAVIGATION
// ─────────────────────────────────────────────

const Tab = createBottomTabNavigator();

// ─────────────────────────────────────────────
// ROOT APP
// ─────────────────────────────────────────────

export default function App() {
  const [sharedFileUri, setSharedFileUri] = useState<string | null>(null);

  useEffect(() => {
    // Handle share intent when app launches
    ReceiveSharingIntent.getReceivedFiles(
      (files: any[]) => {
        if (files && files.length > 0) {
          const file = files[0];
          // filePath or contentUri depending on Android version
          const uri = file.filePath ?? file.contentUri ?? file.uri;
          if (uri) {
            setSharedFileUri(uri);
          }
        }
      },
      (error: any) => console.error('Share intent error:', error),
      'audio/*'
    );

    return () => {
      ReceiveSharingIntent.clearReceivedFiles();
    };
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <NavigationContainer
          theme={{
            dark: true,
            colors: {
              primary: C.accent,
              background: C.bg,
              card: C.surface,
              text: C.text,
              border: C.border,
              notification: C.accent,
            },
          }}
        >
          <Tab.Navigator
            screenOptions={({ route }) => ({
              headerShown: false,
              tabBarStyle: {
                backgroundColor: C.surface,
                borderTopColor: C.border,
                height: 60,
                paddingBottom: 8,
              },
              tabBarActiveTintColor: C.accentLight,
              tabBarInactiveTintColor: C.textDim,
              tabBarLabel: route.name === 'History' ? 'Verlauf' : 'Einstellungen',
              tabBarIcon: ({ focused, color }) => {
                const icon = route.name === 'History' ? '🎙️' : '⚙️';
                return (
                  <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.5 }}>{icon}</Text>
                );
              },
            })}
          >
            <Tab.Screen name="History">
              {() => <HistoryScreen sharedFileUri={sharedFileUri} />}
            </Tab.Screen>
            <Tab.Screen name="Settings" component={SettingsScreen} />
          </Tab.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// ─────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: C.bg,
    paddingHorizontal: 16,
  },

  // ── Stats Header ──
  statsHeader: {
    paddingTop: 20,
    paddingBottom: 8,
  },
  appTitle: {
    fontSize: 26,
    fontWeight: '700',
    color: C.text,
    marginBottom: 16,
    letterSpacing: -0.5,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 8,
  },
  statCard: {
    flex: 1,
    backgroundColor: C.card,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: C.border,
  },
  statValue: {
    fontSize: 22,
    fontWeight: '700',
    color: C.accentLight,
  },
  statLabel: {
    fontSize: 11,
    color: C.textMuted,
    marginTop: 2,
  },

  // ── Empty State ──
  emptyState: {
    alignItems: 'center',
    paddingVertical: 48,
    paddingHorizontal: 24,
  },
  emptyIcon: { fontSize: 56, marginBottom: 16 },
  emptyTitle: { fontSize: 20, fontWeight: '600', color: C.text, marginBottom: 8 },
  emptyText: { fontSize: 14, color: C.textMuted, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  emptySteps: { width: '100%', gap: 8 },
  emptyStep: {
    fontSize: 13,
    color: C.textDim,
    backgroundColor: C.card,
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: C.border,
  },

  // ── History ──
  historySection: { marginTop: 8 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: C.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 10,
  },
  historyCard: {
    backgroundColor: C.card,
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: C.border,
  },
  historyCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  historyCardLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  historyCardRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  importanceDot: { width: 8, height: 8, borderRadius: 4 },
  historyCardDate: { fontSize: 12, color: C.textMuted },
  historyCardDuration: { fontSize: 12, color: C.textDim },
  historyCardImp: { fontSize: 12, fontWeight: '600' },
  historyCardSummary: { fontSize: 14, color: C.text, lineHeight: 20 },
  historyDeadlineBadge: {
    marginTop: 8,
    alignSelf: 'flex-start',
    backgroundColor: C.accent + '22',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  historyDeadlineText: { fontSize: 12, color: C.accentLight },

  // ── Bottom Sheet ──
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingHorizontal: 20,
    paddingTop: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 20,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    backgroundColor: C.border,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 20,
  },

  // Loading
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
  },
  loadingTitle: { fontSize: 18, fontWeight: '600', color: C.text, marginTop: 20 },
  loadingSubtitle: { fontSize: 13, color: C.textMuted, marginTop: 6 },

  // Error
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  errorIcon: { fontSize: 40, marginBottom: 12 },
  errorTitle: { fontSize: 20, fontWeight: '700', color: C.red, marginBottom: 8 },
  errorText: { fontSize: 14, color: C.textMuted, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  dismissBtn: {
    backgroundColor: C.card,
    borderRadius: 12,
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: C.border,
  },
  dismissBtnText: { color: C.text, fontSize: 15, fontWeight: '600' },

  // Sheet Header
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 14,
  },
  sheetTitle: { fontSize: 18, fontWeight: '700', color: C.text },
  sheetMeta: { fontSize: 12, color: C.textMuted, marginTop: 3 },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: C.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnText: { color: C.textMuted, fontSize: 14 },

  // Badge Row
  badgeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
    flexWrap: 'wrap',
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    gap: 5,
  },
  badgeDot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { fontSize: 12, fontWeight: '600' },

  // Toggle
  toggleRow: {
    flexDirection: 'row',
    backgroundColor: C.card,
    borderRadius: 12,
    padding: 4,
    marginBottom: 16,
    gap: 4,
  },
  toggleBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 9,
    alignItems: 'center',
  },
  toggleBtnActive: { backgroundColor: C.accent },
  toggleBtnText: { fontSize: 13, color: C.textMuted, fontWeight: '500' },
  toggleBtnTextActive: { color: C.white, fontWeight: '700' },

  // Summary
  summaryBox: {
    backgroundColor: C.card,
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: C.border,
  },
  summaryShort: { fontSize: 16, color: C.text, lineHeight: 24, fontWeight: '500' },
  summaryFull: { fontSize: 14, color: C.text, lineHeight: 22 },
  keypointRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 10,
    gap: 10,
  },
  keypointDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: C.accentLight,
    marginTop: 7,
  },
  keypointText: { flex: 1, fontSize: 14, color: C.text, lineHeight: 21 },

  // Importance
  importanceSection: { marginBottom: 20 },
  importanceLabel: { fontSize: 12, color: C.textMuted, marginBottom: 8, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8 },
  importanceBarBg: {
    height: 8,
    backgroundColor: C.card,
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 6,
  },
  importanceBarFill: { height: '100%', borderRadius: 4 },
  importanceNumbers: { flexDirection: 'row', justifyContent: 'space-between' },
  importanceNum: { fontSize: 10, color: C.textDim, width: 14, textAlign: 'center' },

  // Main dismiss
  mainDismissBtn: {
    backgroundColor: C.accent,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  mainDismissBtnText: { color: C.white, fontSize: 16, fontWeight: '700' },

  // ── Settings ──
  settingsTitle: {
    fontSize: 26,
    fontWeight: '700',
    color: C.text,
    marginTop: 20,
    marginBottom: 24,
    letterSpacing: -0.5,
  },
  settingsSection: { marginBottom: 28 },
  settingsSectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: C.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 10,
  },
  settingsSectionDesc: { fontSize: 13, color: C.textDim, marginBottom: 12, lineHeight: 18 },
  apiKeyRow: { marginBottom: 12 },
  apiKeyInput: {
    backgroundColor: C.card,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 14,
    color: C.text,
    borderWidth: 1,
    borderColor: C.border,
  },
  saveBtn: {
    backgroundColor: C.accent,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
  },
  saveBtnSuccess: { backgroundColor: '#22c55e' },
  saveBtnText: { color: C.white, fontSize: 15, fontWeight: '700' },

  infoCard: {
    backgroundColor: C.card,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: C.border,
  },
  infoCardTitle: { fontSize: 15, fontWeight: '700', color: C.text, marginBottom: 6 },
  infoCardDesc: { fontSize: 13, color: C.textMuted, lineHeight: 19, marginBottom: 8 },
  infoCardCost: { fontSize: 12, color: C.green },

  howItWorks: { gap: 12 },
  howItWorksStep: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: C.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: C.border,
  },
  howItWorksIcon: { fontSize: 22 },
  howItWorksTitle: { fontSize: 14, fontWeight: '600', color: C.text, marginBottom: 3 },
  howItWorksDesc: { fontSize: 12, color: C.textMuted, lineHeight: 17 },
});
