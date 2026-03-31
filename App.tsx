/**
 * VoiceNote — WhatsApp Audio Analyzer
 * Alles in-app, kein Overlay, Samsung-kompatibel
 */

import React, {
  useEffect, useState, useRef, useCallback, createContext, useContext,
} from 'react';
import {
  View, Text, StyleSheet, Animated, TouchableOpacity, ScrollView,
  TextInput, Alert, StatusBar, Dimensions, Linking, KeyboardAvoidingView,
  Platform, Switch, BackHandler, AppState, ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

// ─── TYPES ───────────────────────────────────
interface AnalysisResult {
  id: string;
  timestamp: number;
  duration_seconds: number;
  summary_short: string;
  summary_keypoints: string[];
  summary_full: string;
  deadline: string | null;
  importance: number;
}
type DetailLevel = 'short' | 'keypoints' | 'full';
type Screen = 'home' | 'result' | 'settings';
type ThemeMode = 'dark' | 'light';

// ─── THEME ───────────────────────────────────
const DARK = {
  bg: '#0B0E11',
  card: '#1A1E24',
  cardBorder: '#252B33',
  text: '#E9EDEF',
  textSub: '#8696A0',
  textDim: '#3D4A54',
  accent: '#00A884',
  accentDark: '#008069',
  accentLight: '#25D366',
  msgBubble: '#005C4B',
  msgBubbleBorder: '#007A63',
  danger: '#FF6B6B',
  warning: '#FFB74D',
  success: '#25D366',
  divider: '#1E242C',
  statusBar: 'light-content' as const,
};
const LIGHT = {
  bg: '#F0F2F5',
  card: '#FFFFFF',
  cardBorder: '#E9EDEF',
  text: '#111B21',
  textSub: '#54656F',
  textDim: '#B0BEC5',
  accent: '#00A884',
  accentDark: '#008069',
  accentLight: '#128C7E',
  msgBubble: '#DCF8C6',
  msgBubbleBorder: '#B5E8A0',
  danger: '#E53935',
  warning: '#E65100',
  success: '#2E7D32',
  divider: '#E9EDEF',
  statusBar: 'dark-content' as const,
};

const ThemeCtx = createContext<{ T: typeof DARK; mode: ThemeMode; toggle: () => void }>({
  T: DARK, mode: 'dark', toggle: () => {},
});
const useTheme = () => useContext(ThemeCtx);

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>('dark');
  useEffect(() => {
    AsyncStorage.getItem('theme_mode').then(v => {
      if (v === 'light' || v === 'dark') setMode(v);
    }).catch(() => {});
  }, []);
  const toggle = useCallback(() => {
    setMode(m => {
      const next = m === 'dark' ? 'light' : 'dark';
      AsyncStorage.setItem('theme_mode', next).catch(() => {});
      return next;
    });
  }, []);
  return (
    <ThemeCtx.Provider value={{ T: mode === 'dark' ? DARK : LIGHT, mode, toggle }}>
      {children}
    </ThemeCtx.Provider>
  );
}

// ─── GEMINI ───────────────────────────────────
const MODEL = 'gemini-2.5-flash-lite-preview-09-2025';

function getMime(path: string): string {
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  return ({
    ogg: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mp3',
    wav: 'audio/wav', m4a: 'audio/aac', aac: 'audio/aac',
    flac: 'audio/flac', '3gp': 'audio/3gpp',
  } as any)[ext] ?? 'audio/ogg';
}

async function resolveUri(uri: string): Promise<string> {
  if (!uri) throw new Error('Kein Dateipfad erhalten.');
  if (uri.startsWith('content://')) {
    const ext = uri.includes('.ogg') ? 'ogg'
      : uri.includes('.mp3') ? 'mp3'
      : uri.includes('.m4a') ? 'm4a'
      : uri.includes('.opus') ? 'ogg'
      : 'ogg';
    const dest = `${FileSystem.cacheDirectory}voice_${Date.now()}.${ext}`;
    await FileSystem.copyAsync({ from: uri, to: dest });
    return dest;
  }
  if (uri.startsWith('/')) return 'file://' + uri;
  return uri;
}

async function analyzeAudio(fileUri: string, apiKey: string): Promise<AnalysisResult> {
  const localUri = await resolveUri(fileUri);
  const b64 = await FileSystem.readAsStringAsync(localUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  if (!b64 || b64.length < 50) throw new Error('Audio-Datei ist leer.');

  const prompt = `Analysiere diese WhatsApp-Sprachnachricht. Antworte NUR mit JSON, keine Backticks:
{"summary_short":"Ein Satz max 100 Zeichen","summary_keypoints":["Punkt 1","Punkt 2","Punkt 3"],"summary_full":"2-3 Sätze ausführlich","deadline":"Termin oder null","importance":6,"duration_seconds":30}
importance 1-10. Antworte auf Deutsch wenn Nachricht deutsch.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: getMime(localUri), data: b64 } },
          { text: prompt },
        ]}],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
      }),
    }
  );

  if (!res.ok) {
    if (res.status === 403) throw new Error('API-Key ungültig. Bitte in Einstellungen prüfen.');
    if (res.status === 400) throw new Error('Audio-Format nicht erkannt.');
    if (res.status === 429) throw new Error('API-Limit erreicht. Kurz warten.');
    throw new Error(`Fehler ${res.status}`);
  }

  const data = await res.json();
  const raw: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const clean = raw.replace(/```json|```/g, '').trim();
  const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
  if (s === -1) throw new Error('Ungültige KI-Antwort.');
  const parsed = JSON.parse(clean.slice(s, e + 1));

  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    duration_seconds: Math.max(1, Math.round(Number(parsed.duration_seconds) || 30)),
    summary_short: String(parsed.summary_short || '–').slice(0, 120),
    summary_keypoints: Array.isArray(parsed.summary_keypoints) ? parsed.summary_keypoints : [],
    summary_full: String(parsed.summary_full || parsed.summary_short || '–'),
    deadline: parsed.deadline && parsed.deadline !== 'null' ? String(parsed.deadline) : null,
    importance: Math.min(10, Math.max(1, Math.round(Number(parsed.importance) || 5))),
  };
}

// ─── STORAGE ─────────────────────────────────
async function saveResult(r: AnalysisResult) {
  try {
    const raw = await AsyncStorage.getItem('history');
    const list: AnalysisResult[] = raw ? JSON.parse(raw) : [];
    await AsyncStorage.setItem('history', JSON.stringify([r, ...list].slice(0, 50)));
  } catch {}
}
async function loadHistory(): Promise<AnalysisResult[]> {
  try { return JSON.parse((await AsyncStorage.getItem('history')) ?? '[]'); }
  catch { return []; }
}
async function deleteItem(id: string): Promise<AnalysisResult[]> {
  const list = await loadHistory();
  const updated = list.filter(x => x.id !== id);
  await AsyncStorage.setItem('history', JSON.stringify(updated)).catch(() => {});
  return updated;
}
async function getApiKey() {
  try { return (await AsyncStorage.getItem('api_key')) ?? ''; } catch { return ''; }
}
async function saveApiKey(k: string) {
  await AsyncStorage.setItem('api_key', k).catch(() => {});
}

// ─── HELPERS ─────────────────────────────────
function fmtSec(s: number) { return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; }
function fmtDate(ts: number) {
  const d = new Date(ts), n = new Date();
  const hm = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  if (d.toDateString() === n.toDateString()) return `Heute · ${hm}`;
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Gestern · ${hm}`;
  return d.toLocaleDateString('de-DE', { day:'2-digit', month:'short' }) + ` · ${hm}`;
}
function impColor(imp: number, T: typeof DARK) {
  if (imp >= 8) return T.danger;
  if (imp >= 5) return T.warning;
  return T.success;
}
function impLabel(imp: number) {
  if (imp >= 8) return 'Dringend';
  if (imp >= 5) return 'Wichtig';
  return 'Normal';
}

// ─── RESULT SCREEN ────────────────────────────
function ResultScreen({ result, onBack }: { result: AnalysisResult; onBack: () => void }) {
  const { T, mode } = useTheme();
  const insets = useSafeAreaInsets();
  const [detail, setDetail] = useState<DetailLevel>('short');
  const bubbleTxt = mode === 'dark' ? '#D9F5EC' : '#1A3C2A';

  return (
    <View style={[s.screen, { backgroundColor: T.bg }]}>
      <StatusBar barStyle={T.statusBar} backgroundColor={T.bg} />
      <View style={[s.topBar, { paddingTop: insets.top + 10, borderBottomColor: T.divider }]}>
        <TouchableOpacity onPress={onBack} style={s.topBtn}>
          <Text style={[s.backArrow, { color: T.accent }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[s.topTitle, { color: T.text }]}>Analyse</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>

        {/* Meta */}
        <Text style={[s.metaLine, { color: T.textSub }]}>
          {fmtSec(result.duration_seconds)}  ·  {fmtDate(result.timestamp)}
        </Text>

        {/* Importance + Deadline */}
        <View style={s.chips}>
          <View style={[s.chip, { backgroundColor: impColor(result.importance, T) + '20', borderColor: impColor(result.importance, T) + '60' }]}>
            <View style={[s.chipDot, { backgroundColor: impColor(result.importance, T) }]} />
            <Text style={[s.chipTxt, { color: impColor(result.importance, T) }]}>
              {impLabel(result.importance)}  {result.importance}/10
            </Text>
          </View>
          {!!result.deadline && (
            <View style={[s.chip, { backgroundColor: T.accent + '18', borderColor: T.accent + '55' }]}>
              <Text style={[s.chipTxt, { color: T.accent }]}>{result.deadline}</Text>
            </View>
          )}
        </View>

        {/* Detail toggle */}
        <View style={[s.tabs, { backgroundColor: T.card, borderColor: T.cardBorder, marginTop: 20 }]}>
          {(['short','keypoints','full'] as DetailLevel[]).map(lv => {
            const lbl = { short: 'Kurz', keypoints: 'Key Points', full: 'Ausführlich' }[lv];
            const active = detail === lv;
            return (
              <TouchableOpacity key={lv}
                style={[s.tab, active && { backgroundColor: T.accent }]}
                onPress={() => setDetail(lv)}>
                <Text style={[s.tabTxt, { color: active ? '#fff' : T.textSub }]}>{lbl}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* WhatsApp bubble */}
        <View style={[s.bubble, { backgroundColor: T.msgBubble, borderColor: T.msgBubbleBorder, marginTop: 14 }]}>
          {detail === 'short' && (
            <Text style={[s.bubbleTxt, { color: bubbleTxt }]}>{result.summary_short}</Text>
          )}
          {detail === 'keypoints' && (
            (result.summary_keypoints.length > 0 ? result.summary_keypoints : [result.summary_short]).map((p, i) => (
              <View key={i} style={s.kpRow}>
                <View style={[s.kpDot, { backgroundColor: T.accentLight }]} />
                <Text style={[s.kpTxt, { color: bubbleTxt }]}>{p}</Text>
              </View>
            ))
          )}
          {detail === 'full' && (
            <Text style={[s.bubbleTxt, { color: bubbleTxt, fontSize: 14, lineHeight: 22 }]}>{result.summary_full}</Text>
          )}
        </View>

        {/* Importance bar */}
        <View style={{ marginTop: 24 }}>
          <View style={s.barHeader}>
            <Text style={[s.barLabel, { color: T.textSub }]}>WICHTIGKEIT</Text>
            <Text style={[s.barVal, { color: impColor(result.importance, T) }]}>{result.importance}/10</Text>
          </View>
          <View style={[s.barTrack, { backgroundColor: T.card }]}>
            <View style={[s.barFill, { width: `${result.importance * 10}%`, backgroundColor: impColor(result.importance, T) }]} />
          </View>
        </View>

        <TouchableOpacity style={[s.btn, { backgroundColor: T.accent, marginTop: 32 }]} onPress={onBack}>
          <Text style={s.btnTxt}>Fertig</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

// ─── LOADING SCREEN ───────────────────────────
function LoadingScreen({ onBack }: { onBack: () => void }) {
  const { T } = useTheme();
  const insets = useSafeAreaInsets();
  const bars = [0,1,2,3,4,5];
  const anims = useRef(bars.map(() => new Animated.Value(8))).current;

  useEffect(() => {
    const loops = anims.map((a, i) =>
      Animated.loop(Animated.sequence([
        Animated.timing(a, { toValue: 30, duration: 350, delay: i * 70, useNativeDriver: false }),
        Animated.timing(a, { toValue: 8, duration: 350, useNativeDriver: false }),
      ]))
    );
    loops.forEach(l => l.start());
    return () => loops.forEach(l => l.stop());
  }, []);

  return (
    <View style={[s.screen, { backgroundColor: T.bg, alignItems: 'center', justifyContent: 'center' }]}>
      <StatusBar barStyle={T.statusBar} backgroundColor={T.bg} />
      <View style={s.waveRow}>
        {anims.map((a, i) => (
          <Animated.View key={i} style={{
            width: 4, height: a, borderRadius: 2,
            backgroundColor: T.accentLight, marginHorizontal: 3,
          }} />
        ))}
      </View>
      <Text style={[s.loadTitle, { color: T.text }]}>Analysiere…</Text>
      <Text style={[s.loadSub, { color: T.textSub }]}>Gemini hört zu</Text>
      <TouchableOpacity style={[s.btn, { backgroundColor: T.card, borderColor: T.cardBorder, borderWidth: 1, marginTop: 40 }]} onPress={onBack}>
        <Text style={[s.btnTxt, { color: T.textSub }]}>Abbrechen</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── ERROR SCREEN ─────────────────────────────
function ErrorScreen({ message, onBack }: { message: string; onBack: () => void }) {
  const { T } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.screen, { backgroundColor: T.bg, alignItems: 'center', justifyContent: 'center', padding: 32 }]}>
      <StatusBar barStyle={T.statusBar} backgroundColor={T.bg} />
      <View style={[s.iconCircle, { backgroundColor: T.danger + '20' }]}>
        <Text style={{ fontSize: 32 }}>⚠</Text>
      </View>
      <Text style={[s.loadTitle, { color: T.danger, marginTop: 20 }]}>Fehler</Text>
      <Text style={[s.loadSub, { color: T.textSub, textAlign: 'center', marginTop: 10, lineHeight: 22 }]}>{message}</Text>
      <TouchableOpacity style={[s.btn, { backgroundColor: T.accent, marginTop: 32 }]} onPress={onBack}>
        <Text style={s.btnTxt}>Zurück</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── SETTINGS SCREEN ─────────────────────────
function SettingsScreen({ onBack }: { onBack: () => void }) {
  const { T, mode, toggle } = useTheme();
  const insets = useSafeAreaInsets();
  const [apiKey, setKey] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { getApiKey().then(setKey); }, []);
  const save = async () => {
    if (!apiKey.trim()) { Alert.alert('Fehler', 'API-Key eingeben.'); return; }
    await saveApiKey(apiKey.trim());
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  return (
    <KeyboardAvoidingView style={[s.screen, { backgroundColor: T.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar barStyle={T.statusBar} backgroundColor={T.bg} />
      <View style={[s.topBar, { paddingTop: insets.top + 10, borderBottomColor: T.divider }]}>
        <TouchableOpacity onPress={onBack} style={s.topBtn}>
          <Text style={[s.backArrow, { color: T.accent }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[s.topTitle, { color: T.text }]}>Einstellungen</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
        {/* Dark/Light */}
        <View style={[s.settRow, { backgroundColor: T.card, borderColor: T.cardBorder }]}>
          <View style={{ flex: 1 }}>
            <Text style={[s.settTitle, { color: T.text }]}>
              {mode === 'dark' ? 'Dunkler Modus' : 'Heller Modus'}
            </Text>
            <Text style={[s.settSub, { color: T.textSub }]}>WhatsApp-Farbstil</Text>
          </View>
          <Switch value={mode === 'dark'} onValueChange={toggle}
            trackColor={{ false: T.cardBorder, true: T.accent }} thumbColor="#fff" />
        </View>

        {/* API Key */}
        <Text style={[s.secLabel, { color: T.textSub }]}>GEMINI API KEY</Text>
        <View style={[s.settBlock, { backgroundColor: T.card, borderColor: T.cardBorder }]}>
          <Text style={[s.settSub, { color: T.textSub, marginBottom: 12 }]}>
            Kostenlos:{' '}
            <Text style={{ color: T.accent, fontWeight: '600' }}
              onPress={() => Linking.openURL('https://aistudio.google.com/apikey')}>
              aistudio.google.com
            </Text>
          </Text>
          <TextInput
            style={[s.input, { color: T.text, backgroundColor: T.bg, borderColor: T.cardBorder }]}
            value={apiKey} onChangeText={setKey} placeholder="AIzaSy..."
            placeholderTextColor={T.textDim} secureTextEntry
            autoCapitalize="none" autoCorrect={false}
          />
          <TouchableOpacity style={[s.btn, { backgroundColor: saved ? T.success : T.accent }]} onPress={save}>
            <Text style={s.btnTxt}>{saved ? 'Gespeichert ✓' : 'Speichern'}</Text>
          </TouchableOpacity>
        </View>

        {/* Anleitung */}
        <Text style={[s.secLabel, { color: T.textSub }]}>ANLEITUNG</Text>
        <View style={[s.settBlock, { backgroundColor: T.card, borderColor: T.cardBorder }]}>
          {[
            ['Sprachnachricht teilen', 'WhatsApp → lang drücken → Weiterleiten → VoiceNote'],
            ['Analyse', 'Gemini analysiert direkt — kein Tippen nötig'],
            ['Verlauf', 'Lang drücken auf Eintrag zum Löschen'],
          ].map(([title, desc], i, arr) => (
            <View key={i} style={[s.infoRow, {
              borderBottomColor: T.divider,
              borderBottomWidth: i < arr.length - 1 ? StyleSheet.hairlineWidth : 0,
            }]}>
              <Text style={[s.settTitle, { color: T.text }]}>{title}</Text>
              <Text style={[s.settSub, { color: T.textSub, marginTop: 3 }]}>{desc}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─── HOME SCREEN ──────────────────────────────
function HomeScreen({ sharedUri, onSettings, onResult }: {
  sharedUri: string | null;
  onSettings: () => void;
  onResult: (r: AnalysisResult) => void;
}) {
  const { T, mode } = useTheme();
  const insets = useSafeAreaInsets();
  const [history, setHistory] = useState<AnalysisResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const processed = useRef<string | null>(null);

  useEffect(() => { loadHistory().then(setHistory); }, []);
  useEffect(() => { MediaLibrary.requestPermissionsAsync().catch(() => {}); }, []);

  const process = useCallback(async (uri: string) => {
    if (processed.current === uri) return;
    processed.current = uri;
    const apiKey = await getApiKey();
    if (!apiKey) {
      setError('Kein API-Key gesetzt.\nBitte in Einstellungen eintragen.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const r = await analyzeAudio(uri, apiKey);
      await saveResult(r);
      setHistory(prev => [r, ...prev]);
      onResult(r);
    } catch (e: any) {
      setError(e?.message ?? 'Unbekannter Fehler');
    } finally {
      setLoading(false);
    }
  }, [onResult]);

  useEffect(() => {
    if (sharedUri && sharedUri !== processed.current) process(sharedUri);
  }, [sharedUri]);

  const totalMin = Math.floor(history.reduce((s, h) => s + h.duration_seconds, 0) / 60);
  const bubbleValColor = mode === 'dark' ? '#E0F5EC' : '#1B4332';
  const bubbleLabelColor = mode === 'dark' ? '#7BC8A4' : '#2D6A4F';
  const heroNumColor = mode === 'dark' ? T.accentLight : T.accentDark;

  if (loading) return <LoadingScreen onBack={() => { setLoading(false); processed.current = null; }} />;
  if (error) return <ErrorScreen message={error} onBack={() => setError(null)} />;

  return (
    <View style={[s.screen, { backgroundColor: T.bg }]}>
      <StatusBar barStyle={T.statusBar} backgroundColor={T.bg} />
      <View style={[s.topBar, { paddingTop: insets.top + 10, borderBottomColor: T.divider }]}>
        <Text style={[s.topTitle, { color: T.text, fontSize: 22 }]}>VoiceNote</Text>
        <TouchableOpacity onPress={onSettings} style={s.topBtn}>
          {/* Settings icon — gear using unicode */}
          <View style={[s.gearBtn, { backgroundColor: T.card, borderColor: T.cardBorder }]}>
            <Text style={{ fontSize: 17, color: T.textSub }}>⚙</Text>
          </View>
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 16, paddingBottom: 36 }}>

        {/* Hero — only minutes */}
        <View style={[s.hero, { backgroundColor: T.msgBubble, borderColor: T.msgBubbleBorder }]}>
          <Text style={[s.heroNum, { color: heroNumColor }]}>{totalMin}</Text>
          <Text style={[s.heroUnit, { color: bubbleLabelColor }]}>Minuten gespart</Text>
        </View>

        {/* History */}
        {history.length > 0 && (
          <View style={{ marginTop: 24 }}>
            <Text style={[s.secLabel, { color: T.textSub }]}>VERLAUF</Text>
            {history.map(item => (
              <TouchableOpacity key={item.id}
                style={[s.card, { backgroundColor: T.card, borderColor: T.cardBorder }]}
                activeOpacity={0.75}
                onPress={() => onResult(item)}
                onLongPress={() => Alert.alert('Löschen?', item.summary_short.slice(0, 80), [
                  { text: 'Abbrechen', style: 'cancel' },
                  { text: 'Löschen', style: 'destructive', onPress: async () => setHistory(await deleteItem(item.id)) },
                ])}>
                <View style={[s.stripe, { backgroundColor: impColor(item.importance, T) }]} />
                <View style={s.cardInner}>
                  <View style={s.cardTop}>
                    <Text style={[s.cardDate, { color: T.textSub }]}>{fmtDate(item.timestamp)}</Text>
                    <View style={[s.impChip, { backgroundColor: impColor(item.importance, T) + '20' }]}>
                      <Text style={[s.impChipTxt, { color: impColor(item.importance, T) }]}>
                        {item.importance}/10
                      </Text>
                    </View>
                  </View>
                  <Text style={[s.cardSum, { color: T.text }]} numberOfLines={2}>
                    {item.summary_short}
                  </Text>
                  {!!item.deadline && (
                    <View style={[s.deadlineChip, { backgroundColor: T.accent + '15', borderColor: T.accent + '40' }]}>
                      <Text style={[s.deadlineChipTxt, { color: T.accent }]}>{item.deadline}</Text>
                    </View>
                  )}
                  <Text style={[s.cardDur, { color: T.textDim }]}>{fmtSec(item.duration_seconds)}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Empty */}
        {history.length === 0 && (
          <View style={s.empty}>
            <Text style={{ fontSize: 60, marginBottom: 20 }}>🎙️</Text>
            <Text style={[s.emptyTitle, { color: T.text }]}>Noch keine Analysen</Text>
            <Text style={[s.emptySub, { color: T.textSub }]}>
              Sprachnachricht in WhatsApp{'\n'}lang drücken → Weiterleiten → VoiceNote
            </Text>
            <View style={[s.stepsBox, { backgroundColor: T.card, borderColor: T.cardBorder }]}>
              {[
                'WhatsApp Sprachnachricht lang drücken',
                'Weiterleiten antippen',
                'VoiceNote auswählen',
                'Analyse erscheint sofort',
              ].map((t, i, arr) => (
                <View key={i} style={[s.stepRow, {
                  borderBottomColor: T.divider,
                  borderBottomWidth: i < arr.length - 1 ? StyleSheet.hairlineWidth : 0,
                }]}>
                  <View style={[s.stepNum, { backgroundColor: T.accent + '20', borderColor: T.accent + '40' }]}>
                    <Text style={[s.stepNumTxt, { color: T.accent }]}>{i + 1}</Text>
                  </View>
                  <Text style={[s.stepTxt, { color: T.textSub }]}>{t}</Text>
                </View>
              ))}
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ─── ROOT ─────────────────────────────────────
function AppInner() {
  const [sharedUri, setSharedUri] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>('home');
  const [activeResult, setActiveResult] = useState<AnalysisResult | null>(null);
  const processedUrl = useRef<string | null>(null);

  const handleUrl = useCallback((url: string) => {
    if (!url || url === processedUrl.current) return;
    processedUrl.current = url;
    let uri = url;
    if (url.startsWith('voicenote://')) {
      uri = decodeURIComponent(url.replace('voicenote://', ''));
    }
    if (uri) {
      setSharedUri(uri);
      setScreen('home');
    }
  }, []);

  useEffect(() => {
    Linking.getInitialURL().then(url => { if (url) handleUrl(url); }).catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }) => { if (url) handleUrl(url); });
    return () => sub.remove();
  }, [handleUrl]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        Linking.getInitialURL().then(url => { if (url) handleUrl(url); }).catch(() => {});
      }
    });
    return () => sub.remove();
  }, [handleUrl]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen === 'settings' || screen === 'result') {
        setScreen('home'); return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [screen]);

  if (screen === 'settings') return <SettingsScreen onBack={() => setScreen('home')} />;
  if (screen === 'result' && activeResult) return (
    <ResultScreen result={activeResult} onBack={() => setScreen('home')} />
  );
  return (
    <HomeScreen
      sharedUri={sharedUri}
      onSettings={() => setScreen('settings')}
      onResult={r => { setActiveResult(r); setScreen('result'); }}
    />
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <AppInner />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// ─── STYLES ───────────────────────────────────
const s = StyleSheet.create({
  screen: { flex: 1 },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  topTitle: { fontSize: 20, fontWeight: '700', letterSpacing: -0.4 },
  topBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backArrow: { fontSize: 32, lineHeight: 36, fontWeight: '300' },
  gearBtn: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },

  // Hero
  hero: {
    borderRadius: 20, borderWidth: 1, padding: 24,
    alignItems: 'center', marginBottom: 4,
  },
  heroNum: { fontSize: 64, fontWeight: '800', letterSpacing: -3, lineHeight: 68 },
  heroUnit: { fontSize: 14, fontWeight: '600', marginTop: 6, letterSpacing: 0.2 },

  secLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 10 },

  // History card
  card: {
    borderRadius: 16, borderWidth: 1, marginBottom: 10,
    flexDirection: 'row', overflow: 'hidden',
  },
  stripe: { width: 4 },
  cardInner: { flex: 1, padding: 14 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  cardDate: { fontSize: 12 },
  impChip: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  impChipTxt: { fontSize: 11, fontWeight: '700' },
  cardSum: { fontSize: 14, lineHeight: 20, fontWeight: '500' },
  cardDur: { fontSize: 11, marginTop: 8 },
  deadlineChip: { marginTop: 8, alignSelf: 'flex-start', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1 },
  deadlineChipTxt: { fontSize: 12, fontWeight: '600' },

  // Empty
  empty: { alignItems: 'center', paddingTop: 32, paddingHorizontal: 8 },
  emptyTitle: { fontSize: 22, fontWeight: '700', marginBottom: 10 },
  emptySub: { fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 28 },
  stepsBox: { width: '100%', borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  stepRow: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 14 },
  stepNum: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  stepNumTxt: { fontSize: 13, fontWeight: '700' },
  stepTxt: { flex: 1, fontSize: 13, lineHeight: 18 },

  // Loading / Error
  waveRow: { flexDirection: 'row', alignItems: 'center', height: 40, marginBottom: 24 },
  loadTitle: { fontSize: 20, fontWeight: '700' },
  loadSub: { fontSize: 14, marginTop: 6 },
  iconCircle: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },

  // Result
  metaLine: { fontSize: 13, marginBottom: 4 },
  chips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 },
  chip: { flexDirection: 'row', alignItems: 'center', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, gap: 6 },
  chipDot: { width: 7, height: 7, borderRadius: 4 },
  chipTxt: { fontSize: 12, fontWeight: '700' },
  tabs: { flexDirection: 'row', borderRadius: 12, padding: 4, borderWidth: 1, gap: 4 },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: 'center' },
  tabTxt: { fontSize: 12, fontWeight: '600' },
  bubble: { borderRadius: 16, borderTopLeftRadius: 4, padding: 18, borderWidth: 1 },
  bubbleTxt: { fontSize: 17, lineHeight: 26, fontWeight: '500' },
  kpRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10, gap: 12 },
  kpDot: { width: 6, height: 6, borderRadius: 3, marginTop: 8 },
  kpTxt: { flex: 1, fontSize: 14, lineHeight: 22 },
  barHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  barLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  barVal: { fontSize: 12, fontWeight: '700' },
  barTrack: { height: 7, borderRadius: 4, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 4 },

  // Buttons
  btn: { borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  btnTxt: { fontSize: 16, fontWeight: '700', color: '#fff' },

  // Settings
  settRow: { borderRadius: 14, borderWidth: 1, padding: 16, flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  settBlock: { borderRadius: 14, borderWidth: 1, padding: 16, marginBottom: 16 },
  settTitle: { fontSize: 15, fontWeight: '600' },
  settSub: { fontSize: 13, lineHeight: 18 },
  input: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 13, fontSize: 14, marginBottom: 12 },
  infoRow: { paddingVertical: 14 },
});
