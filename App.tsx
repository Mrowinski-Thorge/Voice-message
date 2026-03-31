/**
 * VoiceNote — WhatsApp Audio Analyzer
 * Samsung Galaxy / Android 16 kompatibel
 * Nutzt Linking statt expo-share-intent
 */

import React, {
  useEffect, useState, useRef, useCallback, createContext, useContext,
} from 'react';
import {
  View, Text, StyleSheet, Animated, TouchableOpacity, TouchableWithoutFeedback,
  ScrollView, TextInput, Alert, StatusBar, Dimensions, Linking,
  KeyboardAvoidingView, Platform, PanResponder, Switch, BackHandler,
  NativeEventEmitter, NativeModules, AppState,
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
type Screen = 'home' | 'settings';
type ThemeMode = 'dark' | 'light';

// ─── THEME ───────────────────────────────────
const DARK = {
  bg: '#0B0E11',
  card: '#1A1E24',
  cardBorder: '#252B33',
  sheet: '#13171E',
  sheetHandle: '#2D3540',
  text: '#E9EDEF',
  textSub: '#8696A0',
  textDim: '#3D4A54',
  accent: '#00A884',
  accentDark: '#008069',
  accentLight: '#25D366',
  accentGlow: '#00A88430',
  msgBubble: '#005C4B',
  msgBubbleBorder: '#007A63',
  danger: '#FF6B6B',
  warning: '#FFB74D',
  success: '#25D366',
  statusBar: 'light-content' as const,
};
const LIGHT = {
  bg: '#F0F2F5',
  card: '#FFFFFF',
  cardBorder: '#E9EDEF',
  sheet: '#FFFFFF',
  sheetHandle: '#C4C9CC',
  text: '#111B21',
  textSub: '#54656F',
  textDim: '#B0BEC5',
  accent: '#00A884',
  accentDark: '#008069',
  accentLight: '#128C7E',
  accentGlow: '#00A88420',
  msgBubble: '#DCF8C6',
  msgBubbleBorder: '#B5E8A0',
  danger: '#E53935',
  warning: '#E65100',
  success: '#2E7D32',
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
  const map: Record<string, string> = {
    ogg: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mp3',
    wav: 'audio/wav', m4a: 'audio/aac', aac: 'audio/aac',
    flac: 'audio/flac', '3gp': 'audio/3gpp',
  };
  return map[ext] ?? 'audio/ogg';
}

async function resolveUri(uri: string): Promise<string> {
  // Samsung / Android: content:// URI muss in Cache kopiert werden
  if (!uri) throw new Error('Kein Dateipfad erhalten.');

  try {
    if (uri.startsWith('content://')) {
      const ext = uri.includes('.ogg') ? 'ogg' : uri.includes('.mp3') ? 'mp3' : uri.includes('.m4a') ? 'm4a' : 'ogg';
      const dest = `${FileSystem.cacheDirectory}voice_${Date.now()}.${ext}`;
      await FileSystem.copyAsync({ from: uri, to: dest });
      return dest;
    }
    if (uri.startsWith('/')) return 'file://' + uri;
    return uri;
  } catch (e: any) {
    throw new Error('Datei konnte nicht gelesen werden. Bitte Berechtigung erteilen.\n\n' + (e?.message ?? ''));
  }
}

async function analyzeAudio(fileUri: string, apiKey: string): Promise<AnalysisResult> {
  const localUri = await resolveUri(fileUri);

  let b64: string;
  try {
    b64 = await FileSystem.readAsStringAsync(localUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
  } catch (e: any) {
    throw new Error('Audio-Datei nicht lesbar: ' + (e?.message ?? ''));
  }

  if (!b64 || b64.length < 100) {
    throw new Error('Audio-Datei ist leer oder zu klein.');
  }

  const prompt = `Analysiere diese WhatsApp-Sprachnachricht. Antworte NUR mit validem JSON, keine Backticks, kein Text davor oder danach:
{"summary_short":"Ein präziser Satz max 100 Zeichen","summary_keypoints":["Punkt 1","Punkt 2","Punkt 3"],"summary_full":"2-3 Sätze ausführlich mit allen Details","deadline":"Erkannter Termin wie Morgen 14 Uhr oder null","importance":6,"duration_seconds":30}
Regeln: importance 1-10 (10=extrem dringend). +3 bei Termin/Frist, +2 bei dringender Sprache. Antworte auf Deutsch wenn Nachricht deutsch.`;

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
    const body = await res.text().catch(() => '');
    if (res.status === 403) throw new Error('API-Key ungültig.\nBitte in ⚙ Einstellungen prüfen.');
    if (res.status === 400) throw new Error('Audio-Format nicht erkannt.\nNur WhatsApp-Sprachnachrichten.');
    if (res.status === 429) throw new Error('API-Limit erreicht. Kurz warten und erneut versuchen.');
    throw new Error(`Gemini Fehler ${res.status}`);
  }

  const data = await res.json();
  const raw: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!raw) throw new Error('Keine Antwort von Gemini erhalten.');

  const clean = raw.replace(/```json|```/g, '').trim();
  // Find JSON object
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Antwort konnte nicht verarbeitet werden.');
  const jsonStr = clean.slice(start, end + 1);

  let parsed: any;
  try { parsed = JSON.parse(jsonStr); }
  catch { throw new Error('JSON-Parsing fehlgeschlagen.'); }

  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    duration_seconds: Math.max(1, Math.round(Number(parsed.duration_seconds) || 30)),
    summary_short: String(parsed.summary_short || '–').slice(0, 120),
    summary_keypoints: Array.isArray(parsed.summary_keypoints) ? parsed.summary_keypoints.slice(0, 5) : [],
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
  try { return JSON.parse((await AsyncStorage.getItem('history')) ?? '[]'); } catch { return []; }
}
async function deleteItem(id: string): Promise<AnalysisResult[]> {
  const list = await loadHistory();
  const updated = list.filter(x => x.id !== id);
  await AsyncStorage.setItem('history', JSON.stringify(updated)).catch(() => {});
  return updated;
}
async function getApiKey() { try { return (await AsyncStorage.getItem('api_key')) ?? ''; } catch { return ''; } }
async function saveApiKey(k: string) { await AsyncStorage.setItem('api_key', k).catch(() => {}); }

// ─── HELPERS ─────────────────────────────────
const { height: SH, width: SW } = Dimensions.get('window');
const SHEET_SM = SH * 0.46;
const SHEET_LG = SH * 0.85;

function fmtSec(s: number) { return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; }
function fmtDate(ts: number) {
  const d = new Date(ts), n = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === n.toDateString()) return `Heute · ${hm}`;
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Gestern · ${hm}`;
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short' }) + ` · ${hm}`;
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

// ─── WAVE BARS ───────────────────────────────
function WaveBar({ delay, color }: { delay: number; color: string }) {
  const h = useRef(new Animated.Value(8)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(h, { toValue: 28, duration: 350, delay, useNativeDriver: false }),
      Animated.timing(h, { toValue: 8, duration: 350, useNativeDriver: false }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);
  return <Animated.View style={{ width: 3, height: h, borderRadius: 2, backgroundColor: color, marginHorizontal: 2 }} />;
}

// ─── BOTTOM SHEET ────────────────────────────
interface SheetProps {
  result: AnalysisResult | null;
  loading: boolean;
  error: string | null;
  onDismiss: () => void;
}

function BottomSheet({ result, loading, error, onDismiss }: SheetProps) {
  const { T, mode } = useTheme();
  const insets = useSafeAreaInsets();
  const [detail, setDetail] = useState<DetailLevel>('short');
  const [expanded, setExpanded] = useState(false);

  const slideY = useRef(new Animated.Value(SH)).current;
  const fadeBack = useRef(new Animated.Value(0)).current;
  const sheetH = useRef(new Animated.Value(SHEET_SM)).current;
  const dragDelta = useRef(new Animated.Value(0)).current;
  const visible = loading || !!result || !!error;

  useEffect(() => {
    if (visible) {
      setExpanded(false); setDetail('short'); dragDelta.setValue(0);
      Animated.parallel([
        Animated.spring(slideY, { toValue: 0, useNativeDriver: true, mass: 0.8, stiffness: 180, damping: 24 }),
        Animated.timing(fadeBack, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.spring(slideY, { toValue: SH, useNativeDriver: true, mass: 0.8, stiffness: 180, damping: 24 }),
        Animated.timing(fadeBack, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  useEffect(() => {
    Animated.spring(sheetH, {
      toValue: expanded ? SHEET_LG : SHEET_SM,
      useNativeDriver: false, mass: 0.8, stiffness: 180, damping: 24,
    }).start();
  }, [expanded]);

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 5,
    onPanResponderMove: (_, g) => {
      if (g.dy > 0) dragDelta.setValue(g.dy);
    },
    onPanResponderRelease: (_, g) => {
      if (g.dy > 60 || g.vy > 0.8) {
        if (expanded) {
          setExpanded(false);
          Animated.spring(dragDelta, { toValue: 0, useNativeDriver: false }).start();
        } else {
          Animated.spring(dragDelta, { toValue: 0, useNativeDriver: false }).start();
          onDismiss();
        }
      } else if (g.dy < -40 || g.vy < -0.6) {
        setExpanded(true);
        Animated.spring(dragDelta, { toValue: 0, useNativeDriver: false }).start();
      } else {
        Animated.spring(dragDelta, { toValue: 0, useNativeDriver: false }).start();
      }
    },
  })).current;

  if (!visible) return null;

  const bubbleTxt = mode === 'dark' ? '#D9F5EC' : '#1A3C2A';

  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="box-none">
      <TouchableWithoutFeedback onPress={onDismiss}>
        <Animated.View style={[st.backdrop, { opacity: fadeBack }]} />
      </TouchableWithoutFeedback>

      <Animated.View style={[st.sheet, {
        backgroundColor: T.sheet,
        height: sheetH,
        paddingBottom: Math.max(insets.bottom, 16),
        transform: [{ translateY: Animated.add(slideY, dragDelta) }],
        borderTopColor: T.cardBorder,
      }]}>
        {/* Drag zone */}
        <View {...pan.panHandlers} style={st.dragZone}>
          <View style={[st.pill, { backgroundColor: T.sheetHandle }]} />
        </View>

        {/* Back button */}
        <TouchableOpacity style={[st.sheetBack, { backgroundColor: T.card }]} onPress={onDismiss}>
          <Text style={[st.sheetBackTxt, { color: T.textSub }]}>✕</Text>
        </TouchableOpacity>

        {/* LOADING */}
        {loading && (
          <View style={st.center}>
            <View style={st.waveBox}>
              {[0,1,2,3,4,5].map(i => <WaveBar key={i} delay={i * 80} color={T.accentLight} />)}
            </View>
            <Text style={[st.centerTitle, { color: T.text }]}>Analysiere…</Text>
            <Text style={[st.centerSub, { color: T.textSub }]}>Gemini hört zu</Text>
          </View>
        )}

        {/* ERROR */}
        {!!error && !loading && (
          <View style={st.center}>
            <View style={[st.iconCircle, { backgroundColor: T.danger + '20' }]}>
              <Text style={{ fontSize: 28 }}>⚠</Text>
            </View>
            <Text style={[st.centerTitle, { color: T.danger, marginTop: 14 }]}>Fehler</Text>
            <Text style={[st.centerSub, { color: T.textSub, textAlign: 'center', marginTop: 8, paddingHorizontal: 24 }]}>
              {error}
            </Text>
            <TouchableOpacity style={[st.btn, { backgroundColor: T.card, borderColor: T.cardBorder, borderWidth: 1, marginTop: 24 }]} onPress={onDismiss}>
              <Text style={[st.btnTxt, { color: T.text }]}>Schließen</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* RESULT */}
        {!!result && !loading && (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 32, paddingTop: 4 }}
          >
            {/* Title */}
            <Text style={[st.sheetTitle, { color: T.text }]}>Sprachnachricht</Text>
            <Text style={[st.sheetMeta, { color: T.textSub }]}>
              {fmtSec(result.duration_seconds)}  ·  {fmtDate(result.timestamp)}
            </Text>

            {/* Badges */}
            <View style={[st.badgeRow, { marginTop: 16 }]}>
              <View style={[st.badge, {
                backgroundColor: impColor(result.importance, T) + '18',
                borderColor: impColor(result.importance, T) + '60',
              }]}>
                <View style={[st.badgeDot, { backgroundColor: impColor(result.importance, T) }]} />
                <Text style={[st.badgeTxt, { color: impColor(result.importance, T) }]}>
                  {impLabel(result.importance)}  {result.importance}/10
                </Text>
              </View>
              {!!result.deadline && (
                <View style={[st.badge, { backgroundColor: T.accent + '18', borderColor: T.accent + '60' }]}>
                  <Text style={[st.badgeTxt, { color: T.accent }]}>
                    {result.deadline}
                  </Text>
                </View>
              )}
            </View>

            {/* Toggle tabs */}
            <View style={[st.tabs, { backgroundColor: T.card, borderColor: T.cardBorder, marginTop: 16 }]}>
              {(['short', 'keypoints', 'full'] as DetailLevel[]).map(lv => {
                const labels = { short: 'Kurz', keypoints: 'Key Points', full: 'Ausführlich' };
                const active = detail === lv;
                return (
                  <TouchableOpacity
                    key={lv}
                    style={[st.tab, active && { backgroundColor: T.accent }]}
                    onPress={() => setDetail(lv)}
                  >
                    <Text style={[st.tabTxt, { color: active ? '#fff' : T.textSub }]}>
                      {labels[lv]}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* WhatsApp bubble */}
            <View style={[st.bubble, {
              backgroundColor: T.msgBubble,
              borderColor: T.msgBubbleBorder,
              marginTop: 14,
            }]}>
              {detail === 'short' && (
                <Text style={[st.bubbleTxt, { color: bubbleTxt }]}>{result.summary_short}</Text>
              )}
              {detail === 'keypoints' && (result.summary_keypoints.length > 0
                ? result.summary_keypoints
                : [result.summary_short]
              ).map((p, i) => (
                <View key={i} style={st.kpRow}>
                  <View style={[st.kpDot, { backgroundColor: T.accentLight }]} />
                  <Text style={[st.kpTxt, { color: bubbleTxt }]}>{p}</Text>
                </View>
              ))}
              {detail === 'full' && (
                <Text style={[st.bubbleTxt, { color: bubbleTxt, fontSize: 14, lineHeight: 22 }]}>
                  {result.summary_full}
                </Text>
              )}
            </View>

            {/* Importance bar */}
            <View style={{ marginTop: 20 }}>
              <View style={st.barHeader}>
                <Text style={[st.barLabel, { color: T.textSub }]}>WICHTIGKEIT</Text>
                <Text style={[st.barValue, { color: impColor(result.importance, T) }]}>
                  {result.importance} / 10
                </Text>
              </View>
              <View style={[st.barTrack, { backgroundColor: T.card }]}>
                <Animated.View style={[st.barFill, {
                  width: `${result.importance * 10}%`,
                  backgroundColor: impColor(result.importance, T),
                }]} />
              </View>
            </View>

            <TouchableOpacity
              style={[st.btn, { backgroundColor: T.accent, marginTop: 24 }]}
              onPress={onDismiss}
            >
              <Text style={[st.btnTxt, { color: '#fff' }]}>Fertig</Text>
            </TouchableOpacity>
          </ScrollView>
        )}
      </Animated.View>
    </View>
  );
}

// ─── SETTINGS ────────────────────────────────
function SettingsScreen({ onBack }: { onBack: () => void }) {
  const { T, mode, toggle } = useTheme();
  const insets = useSafeAreaInsets();
  const [apiKey, setKey] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { getApiKey().then(setKey); }, []);
  const save = async () => {
    if (!apiKey.trim()) { Alert.alert('Fehler', 'Bitte API-Key eingeben.'); return; }
    await saveApiKey(apiKey.trim());
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  return (
    <KeyboardAvoidingView style={[st.screen, { backgroundColor: T.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar barStyle={T.statusBar} backgroundColor={T.bg} />
      <View style={[st.topBar, { paddingTop: insets.top + 10, borderBottomColor: T.cardBorder }]}>
        <TouchableOpacity onPress={onBack} style={st.topBtn}>
          <Text style={[st.topBtnTxt, { color: T.accent }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[st.topTitle, { color: T.text }]}>Einstellungen</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>

        {/* Theme toggle */}
        <View style={[st.settRow, { backgroundColor: T.card, borderColor: T.cardBorder }]}>
          <View style={{ flex: 1 }}>
            <Text style={[st.settTitle2, { color: T.text }]}>
              {mode === 'dark' ? 'Dunkler Modus' : 'Heller Modus'}
            </Text>
            <Text style={[st.settSub, { color: T.textSub }]}>WhatsApp-Farbstil</Text>
          </View>
          <Switch
            value={mode === 'dark'}
            onValueChange={toggle}
            trackColor={{ false: T.cardBorder, true: T.accent }}
            thumbColor="#fff"
          />
        </View>

        {/* API Key */}
        <Text style={[st.sectionLabel, { color: T.textSub }]}>GEMINI API KEY</Text>
        <View style={[st.settBlock, { backgroundColor: T.card, borderColor: T.cardBorder }]}>
          <Text style={[st.settSub, { color: T.textSub, marginBottom: 12 }]}>
            Kostenlos unter{' '}
            <Text style={{ color: T.accent, fontWeight: '600' }}
              onPress={() => Linking.openURL('https://aistudio.google.com/apikey')}>
              aistudio.google.com
            </Text>
          </Text>
          <TextInput
            style={[st.input, { color: T.text, backgroundColor: T.bg, borderColor: T.cardBorder }]}
            value={apiKey} onChangeText={setKey}
            placeholder="AIzaSy..." placeholderTextColor={T.textDim}
            secureTextEntry autoCapitalize="none" autoCorrect={false}
          />
          <TouchableOpacity
            style={[st.btn, { backgroundColor: saved ? T.success : T.accent }]}
            onPress={save}
          >
            <Text style={[st.btnTxt, { color: '#fff' }]}>{saved ? 'Gespeichert ✓' : 'Speichern'}</Text>
          </TouchableOpacity>
        </View>

        {/* Anleitung */}
        <Text style={[st.sectionLabel, { color: T.textSub }]}>ANLEITUNG</Text>
        <View style={[st.settBlock, { backgroundColor: T.card, borderColor: T.cardBorder }]}>
          {[
            ['Sprachnachricht teilen', 'In WhatsApp lang drücken → Weiterleiten → VoiceNote'],
            ['Analyse', 'Gemini hört direkt — keine manuelle Transkription'],
            ['Overlay', 'Sheet öffnet von unten, nach oben ziehen für mehr'],
            ['Verlauf', 'Lang drücken auf Eintrag zum Löschen'],
          ].map(([title, desc], i, arr) => (
            <View key={i} style={[st.infoRow, {
              borderBottomColor: T.cardBorder,
              borderBottomWidth: i < arr.length - 1 ? StyleSheet.hairlineWidth : 0,
            }]}>
              <Text style={[st.settTitle2, { color: T.text }]}>{title}</Text>
              <Text style={[st.settSub, { color: T.textSub, marginTop: 2 }]}>{desc}</Text>
            </View>
          ))}
        </View>

      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─── HOME ─────────────────────────────────────
function HomeScreen({ sharedUri, onSettings }: {
  sharedUri: string | null;
  onSettings: () => void;
}) {
  const { T, mode } = useTheme();
  const insets = useSafeAreaInsets();
  const [history, setHistory] = useState<AnalysisResult[]>([]);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const processed = useRef<string | null>(null);

  useEffect(() => { loadHistory().then(setHistory); }, []);

  // Permissions
  useEffect(() => {
    MediaLibrary.requestPermissionsAsync().catch(() => {});
  }, []);

  const process = useCallback(async (uri: string) => {
    if (processed.current === uri) return;
    processed.current = uri;
    const apiKey = await getApiKey();
    if (!apiKey) {
      setError('Kein API-Key gesetzt.\nBitte in Einstellungen eintragen.');
      setResult(null); setLoading(false); setSheetOpen(true);
      return;
    }
    setResult(null); setError(null); setLoading(true); setSheetOpen(true);
    try {
      const r = await analyzeAudio(uri, apiKey);
      await saveResult(r);
      setResult(r);
      setHistory(prev => [r, ...prev]);
    } catch (e: any) {
      setError(e?.message ?? 'Unbekannter Fehler');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sharedUri && sharedUri !== processed.current) {
      process(sharedUri);
    }
  }, [sharedUri]);

  const totalMin = Math.floor(history.reduce((s, h) => s + h.duration_seconds, 0) / 60);
  const bubbleValColor = mode === 'dark' ? '#E0F5EC' : '#1B4332';
  const bubbleLabelColor = mode === 'dark' ? '#7BC8A4' : '#2D6A4F';

  return (
    <View style={[st.screen, { backgroundColor: T.bg }]}>
      <StatusBar barStyle={T.statusBar} backgroundColor={T.bg} />

      {/* Top bar */}
      <View style={[st.topBar, { paddingTop: insets.top + 10, borderBottomColor: T.cardBorder }]}>
        <Text style={[st.topTitle, { color: T.text, fontSize: 22 }]}>VoiceNote</Text>
        <TouchableOpacity onPress={onSettings} style={st.topBtn}>
          <Text style={{ fontSize: 22, color: T.textSub }}>⚙</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 16, paddingBottom: 36 }}
      >
        {/* Stats hero — WhatsApp chat bubble style */}
        <View style={[st.hero, { backgroundColor: T.msgBubble, borderColor: T.msgBubbleBorder }]}>
          <View style={st.heroLeft}>
            <Text style={[st.heroNum, { color: mode === 'dark' ? T.accentLight : T.accentDark }]}>
              {totalMin}
            </Text>
            <Text style={[st.heroUnit, { color: bubbleLabelColor }]}>Minuten gespart</Text>
          </View>
          <View style={st.heroDivider} />
          <View style={st.heroRight}>
            <View style={st.heroStat}>
              <Text style={[st.heroStatNum, { color: bubbleValColor }]}>{history.length}</Text>
              <Text style={[st.heroStatLabel, { color: bubbleLabelColor }]}>Nachrichten</Text>
            </View>
            <View style={[st.heroStatDivider, { backgroundColor: bubbleLabelColor + '40' }]} />
            <View style={st.heroStat}>
              <Text style={[st.heroStatNum, { color: bubbleValColor }]}>
                {history.length > 0
                  ? (history.reduce((a, h) => a + h.importance, 0) / history.length).toFixed(1)
                  : '–'}
              </Text>
              <Text style={[st.heroStatLabel, { color: bubbleLabelColor }]}>Wichtigkeit</Text>
            </View>
          </View>
        </View>

        {/* History list */}
        {history.length > 0 && (
          <View style={{ marginTop: 24 }}>
            <Text style={[st.sectionLabel, { color: T.textSub }]}>VERLAUF</Text>
            {history.map(item => (
              <TouchableOpacity
                key={item.id}
                style={[st.histCard, { backgroundColor: T.card, borderColor: T.cardBorder }]}
                activeOpacity={0.75}
                onPress={() => { setResult(item); setError(null); setLoading(false); setSheetOpen(true); }}
                onLongPress={() => Alert.alert(
                  'Eintrag löschen?',
                  item.summary_short.slice(0, 80),
                  [
                    { text: 'Abbrechen', style: 'cancel' },
                    { text: 'Löschen', style: 'destructive', onPress: async () => setHistory(await deleteItem(item.id)) },
                  ]
                )}
              >
                {/* Importance stripe */}
                <View style={[st.stripe, { backgroundColor: impColor(item.importance, T) }]} />
                <View style={st.histCardInner}>
                  <View style={st.histTop}>
                    <Text style={[st.histDate, { color: T.textSub }]}>{fmtDate(item.timestamp)}</Text>
                    <View style={[st.impBadge, { backgroundColor: impColor(item.importance, T) + '20' }]}>
                      <Text style={[st.impBadgeTxt, { color: impColor(item.importance, T) }]}>
                        {item.importance}/10
                      </Text>
                    </View>
                  </View>
                  <Text style={[st.histSummary, { color: T.text }]} numberOfLines={2}>
                    {item.summary_short}
                  </Text>
                  {!!item.deadline && (
                    <View style={[st.deadlineChip, { backgroundColor: T.accent + '15', borderColor: T.accent + '40' }]}>
                      <Text style={[st.deadlineChipTxt, { color: T.accent }]}>
                        {item.deadline}
                      </Text>
                    </View>
                  )}
                  <Text style={[st.histDur, { color: T.textDim }]}>{fmtSec(item.duration_seconds)}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Empty state */}
        {history.length === 0 && (
          <View style={st.empty}>
            <Text style={{ fontSize: 60, marginBottom: 16 }}>🎙️</Text>
            <Text style={[st.emptyTitle, { color: T.text }]}>Noch keine Analysen</Text>
            <Text style={[st.emptySub, { color: T.textSub }]}>
              Sprachnachricht in WhatsApp{'\n'}lang drücken → Weiterleiten → VoiceNote
            </Text>
            <View style={[st.stepsBox, { backgroundColor: T.card, borderColor: T.cardBorder }]}>
              {[
                'WhatsApp Sprachnachricht lang drücken',
                'Weiterleiten antippen',
                'VoiceNote aus der Liste wählen',
                'Analyse erscheint sofort als Overlay',
              ].map((t, i, arr) => (
                <View key={i} style={[st.stepRow, {
                  borderBottomColor: T.cardBorder,
                  borderBottomWidth: i < arr.length - 1 ? StyleSheet.hairlineWidth : 0,
                }]}>
                  <View style={[st.stepNum, { backgroundColor: T.accentGlow, borderColor: T.accent + '40' }]}>
                    <Text style={[st.stepNumTxt, { color: T.accent }]}>{i + 1}</Text>
                  </View>
                  <Text style={[st.stepTxt, { color: T.textSub }]}>{t}</Text>
                </View>
              ))}
            </View>
          </View>
        )}
      </ScrollView>

      {/* Bottom Sheet Overlay */}
      {sheetOpen && (
        <BottomSheet
          result={result}
          loading={loading}
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

// ─── ROOT ─────────────────────────────────────
function AppInner() {
  const [sharedUri, setSharedUri] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>('home');
  const processed = useRef<string | null>(null);

  // Handle share intent via Linking
  useEffect(() => {
    // Get initial URL (app opened via share)
    Linking.getInitialURL().then(url => {
      if (url) handleUrl(url);
    }).catch(() => {});

    // Listen for URLs while app is open
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (url) handleUrl(url);
    });

    return () => sub.remove();
  }, []);

  // Also handle via AppState (Samsung sometimes sends intent differently)
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        Linking.getInitialURL().then(url => {
          if (url && url !== processed.current) handleUrl(url);
        }).catch(() => {});
      }
    });
    return () => sub.remove();
  }, []);

  const handleUrl = (url: string) => {
    if (!url || url === processed.current) return;
    // Extract file path from URL
    let uri = url;
    if (url.startsWith('voicenote://')) {
      uri = decodeURIComponent(url.replace('voicenote://', ''));
    }
    if (uri && (uri.includes('audio') || uri.includes('.ogg') || uri.includes('.mp3') || uri.includes('.m4a') || uri.startsWith('content://'))) {
      setSharedUri(uri);
      setScreen('home');
    }
  };

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen === 'settings') { setScreen('home'); return true; }
      return false;
    });
    return () => sub.remove();
  }, [screen]);

  if (screen === 'settings') return <SettingsScreen onBack={() => setScreen('home')} />;
  return <HomeScreen sharedUri={sharedUri} onSettings={() => setScreen('settings')} />;
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
const st = StyleSheet.create({
  screen: { flex: 1 },

  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  topTitle: { fontSize: 20, fontWeight: '700', letterSpacing: -0.4 },
  topBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  topBtnTxt: { fontSize: 32, lineHeight: 36, fontWeight: '300' },

  hero: {
    borderRadius: 18, borderWidth: 1, padding: 20, marginBottom: 4,
    flexDirection: 'row', alignItems: 'center',
  },
  heroLeft: { flex: 1, alignItems: 'center' },
  heroNum: { fontSize: 48, fontWeight: '800', letterSpacing: -2, lineHeight: 52 },
  heroUnit: { fontSize: 12, fontWeight: '500', marginTop: 4 },
  heroDivider: { width: StyleSheet.hairlineWidth, height: 60, backgroundColor: '#FFFFFF30', marginHorizontal: 16 },
  heroRight: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  heroStat: { alignItems: 'center', flex: 1 },
  heroStatNum: { fontSize: 22, fontWeight: '700' },
  heroStatLabel: { fontSize: 11, marginTop: 3 },
  heroStatDivider: { width: StyleSheet.hairlineWidth, height: 32, marginHorizontal: 8 },

  sectionLabel: {
    fontSize: 11, fontWeight: '700', letterSpacing: 1.2,
    textTransform: 'uppercase', marginBottom: 10, marginTop: 4,
  },

  histCard: {
    borderRadius: 16, borderWidth: 1, marginBottom: 10,
    flexDirection: 'row', overflow: 'hidden',
  },
  stripe: { width: 4 },
  histCardInner: { flex: 1, padding: 14 },
  histTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  histDate: { fontSize: 12 },
  impBadge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  impBadgeTxt: { fontSize: 11, fontWeight: '700' },
  histSummary: { fontSize: 14, lineHeight: 20, fontWeight: '500' },
  histDur: { fontSize: 11, marginTop: 8 },
  deadlineChip: {
    marginTop: 8, alignSelf: 'flex-start',
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1,
  },
  deadlineChipTxt: { fontSize: 12, fontWeight: '600' },

  empty: { alignItems: 'center', paddingTop: 40, paddingHorizontal: 8 },
  emptyTitle: { fontSize: 22, fontWeight: '700', marginBottom: 8 },
  emptySub: { fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 28 },
  stepsBox: { width: '100%', borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  stepRow: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 14 },
  stepNum: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  stepNumTxt: { fontSize: 13, fontWeight: '700' },
  stepTxt: { flex: 1, fontSize: 13, lineHeight: 18 },

  // Sheet
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.65)' },
  sheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    borderTopLeftRadius: 26, borderTopRightRadius: 26,
    borderTopWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000', shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.35, shadowRadius: 20, elevation: 30,
  },
  dragZone: { alignItems: 'center', paddingTop: 12, paddingBottom: 6 },
  pill: { width: 40, height: 4, borderRadius: 2 },
  sheetBack: {
    position: 'absolute', top: 44, right: 18,
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', zIndex: 10,
  },
  sheetBackTxt: { fontSize: 15, fontWeight: '500' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  waveBox: { flexDirection: 'row', alignItems: 'center', height: 36, marginBottom: 20 },
  iconCircle: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  centerTitle: { fontSize: 19, fontWeight: '700' },
  centerSub: { fontSize: 14, marginTop: 4 },
  sheetTitle: { fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
  sheetMeta: { fontSize: 12, marginTop: 4 },
  badgeRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  badge: { flexDirection: 'row', alignItems: 'center', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, gap: 6 },
  badgeDot: { width: 7, height: 7, borderRadius: 4 },
  badgeTxt: { fontSize: 12, fontWeight: '700' },
  tabs: { flexDirection: 'row', borderRadius: 12, padding: 4, borderWidth: 1, gap: 4 },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: 'center' },
  tabTxt: { fontSize: 12, fontWeight: '600' },
  bubble: { borderRadius: 16, borderTopLeftRadius: 4, padding: 16, borderWidth: 1 },
  bubbleTxt: { fontSize: 16, lineHeight: 25, fontWeight: '500' },
  kpRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10, gap: 10 },
  kpDot: { width: 6, height: 6, borderRadius: 3, marginTop: 8 },
  kpTxt: { flex: 1, fontSize: 14, lineHeight: 22 },
  barHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  barLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  barValue: { fontSize: 12, fontWeight: '700' },
  barTrack: { height: 7, borderRadius: 4, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 4 },
  btn: { borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  btnTxt: { fontSize: 16, fontWeight: '700' },

  // Settings
  settRow: { borderRadius: 14, borderWidth: 1, padding: 16, flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  settBlock: { borderRadius: 14, borderWidth: 1, padding: 16, marginBottom: 16 },
  settTitle2: { fontSize: 15, fontWeight: '600' },
  settSub: { fontSize: 13, lineHeight: 18 },
  input: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, marginBottom: 12 },
  infoRow: { paddingVertical: 14 },
});
