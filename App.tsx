/**
 * VoiceNote — WhatsApp Audio Analyzer
 * Clean, no tab bar, overlay sheet, no crashes
 */

import React, {
  useEffect, useState, useRef, useCallback,
  createContext, useContext,
} from 'react';
import {
  View, Text, StyleSheet, Animated, TouchableOpacity,
  TouchableWithoutFeedback, ScrollView, TextInput, Alert,
  StatusBar, Dimensions, Linking, ActivityIndicator,
  KeyboardAvoidingView, Platform, PanResponder, Switch,
  BackHandler,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useShareIntent, ShareIntentProvider } from 'expo-share-intent';

// TYPES
interface AnalysisResult {
  id: string;
  timestamp: number;
  duration_seconds: number;
  summary_short: string;
  summary_keypoints: string[];
  summary_full: string;
  deadline: string | null;
  importance: number;
  file_name: string;
}
type DetailLevel = 'short' | 'keypoints' | 'full';
type Screen = 'home' | 'settings';
type ThemeMode = 'dark' | 'light';

// THEME
const DARK = {
  bg: '#0B0E11', surface: '#111418', card: '#1A1E24', cardBorder: '#252B33',
  sheet: '#161B22', sheetHandle: '#2D3540', text: '#E9EDEF', textSub: '#8696A0',
  textDim: '#3D4A54', accent: '#00A884', accentDark: '#008069', accentLight: '#25D366',
  msgBubble: '#005C4B', msgBubbleBorder: '#007A63', danger: '#FF6B6B', warning: '#FFB74D',
  statusBar: 'light-content' as const,
};
const LIGHT = {
  bg: '#F0F2F5', surface: '#FFFFFF', card: '#FFFFFF', cardBorder: '#E9EDEF',
  sheet: '#FFFFFF', sheetHandle: '#C4C9CC', text: '#111B21', textSub: '#54656F',
  textDim: '#B0BEC5', accent: '#00A884', accentDark: '#008069', accentLight: '#25D366',
  msgBubble: '#DCF8C6', msgBubbleBorder: '#C5E8B0', danger: '#E53935', warning: '#F57C00',
  statusBar: 'dark-content' as const,
};

const ThemeCtx = createContext<{ theme: typeof DARK; mode: ThemeMode; toggle: () => void }>({
  theme: DARK, mode: 'dark', toggle: () => {},
});
const useTheme = () => useContext(ThemeCtx);

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>('dark');
  useEffect(() => {
    AsyncStorage.getItem('theme_mode').then(v => {
      if (v === 'light' || v === 'dark') setMode(v);
    });
  }, []);
  const toggle = useCallback(() => {
    setMode(m => {
      const next = m === 'dark' ? 'light' : 'dark';
      AsyncStorage.setItem('theme_mode', next);
      return next;
    });
  }, []);
  return (
    <ThemeCtx.Provider value={{ theme: mode === 'dark' ? DARK : LIGHT, mode, toggle }}>
      {children}
    </ThemeCtx.Provider>
  );
}

// GEMINI
const GEMINI_MODEL = 'gemini-2.5-flash-lite-preview-09-2025';

function getMime(path: string): string {
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  const map: Record<string, string> = {
    ogg: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mp3',
    wav: 'audio/wav', m4a: 'audio/aac', aac: 'audio/aac', flac: 'audio/flac',
  };
  return map[ext] ?? 'audio/ogg';
}

async function analyzeAudio(fileUri: string, apiKey: string): Promise<AnalysisResult> {
  let b64: string;
  try {
    b64 = await FileSystem.readAsStringAsync(fileUri, { encoding: FileSystem.EncodingType.Base64 });
  } catch {
    throw new Error('Datei nicht lesbar. Bitte Dateizugriff erlauben.');
  }
  const prompt = `Analysiere diese WhatsApp-Sprachnachricht. Antworte NUR mit validem JSON ohne Backticks:
{"summary_short":"Ein Satz max 100 Zeichen","summary_keypoints":["Punkt 1","Punkt 2","Punkt 3"],"summary_full":"2-3 Sätze ausführlich","deadline":"Termin oder null","importance":6,"duration_seconds":30}
importance 1-10. Deutsch wenn Nachricht deutsch.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: getMime(fileUri), data: b64 } },
          { text: prompt },
        ]}],
        generationConfig: { temperature: 0.1, maxOutputTokens: 800 },
      }),
    }
  );
  if (!res.ok) {
    if (res.status === 403) throw new Error('API-Key ungültig. Bitte in Einstellungen prüfen.');
    throw new Error(`Gemini Fehler ${res.status}`);
  }
  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const clean = raw.replace(/```json|```/g, '').trim();
  let parsed: any;
  try { parsed = JSON.parse(clean); }
  catch { throw new Error('Antwort konnte nicht verarbeitet werden.'); }
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    duration_seconds: typeof parsed.duration_seconds === 'number' ? parsed.duration_seconds : 30,
    summary_short: parsed.summary_short ?? '–',
    summary_keypoints: Array.isArray(parsed.summary_keypoints) ? parsed.summary_keypoints : [],
    summary_full: parsed.summary_full ?? parsed.summary_short ?? '–',
    deadline: parsed.deadline ?? null,
    importance: typeof parsed.importance === 'number' ? Math.min(10, Math.max(1, Math.round(parsed.importance))) : 5,
    file_name: fileUri.split('/').pop() ?? 'voice.ogg',
  };
}

// STORAGE
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
  await AsyncStorage.setItem('history', JSON.stringify(updated));
  return updated;
}
async function getApiKey() { return (await AsyncStorage.getItem('api_key')) ?? ''; }
async function saveApiKey(k: string) { await AsyncStorage.setItem('api_key', k); }

// HELPERS
const { height: SH } = Dimensions.get('window');
const SHEET_SMALL = SH * 0.44;
const SHEET_BIG = SH * 0.82;

function fmtSec(s: number) { return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; }
function fmtDate(ts: number) {
  const d = new Date(ts), n = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === n.toDateString()) return `Heute ${hm}`;
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Gestern ${hm}`;
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short' }) + ` ${hm}`;
}
function impColor(imp: number, C: typeof DARK) {
  if (imp >= 8) return C.danger;
  if (imp >= 5) return C.warning;
  return C.accentLight;
}
function impLabel(imp: number) {
  if (imp >= 8) return 'Dringend';
  if (imp >= 5) return 'Wichtig';
  return 'Normal';
}

// WAVE
function WaveBar({ delay, color }: { delay: number; color: string }) {
  const anim = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(anim, { toValue: 1, duration: 400, delay, useNativeDriver: true }),
      Animated.timing(anim, { toValue: 0.3, duration: 400, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);
  return (
    <Animated.View style={{
      width: 4, height: 28, borderRadius: 2, backgroundColor: color,
      marginHorizontal: 3, transform: [{ scaleY: anim }],
    }} />
  );
}

// BOTTOM SHEET
interface SheetProps {
  result: AnalysisResult | null;
  loading: boolean;
  error: string | null;
  onDismiss: () => void;
}

function BottomSheet({ result, loading, error, onDismiss }: SheetProps) {
  const { theme: C, mode } = useTheme();
  const insets = useSafeAreaInsets();
  const [detail, setDetail] = useState<DetailLevel>('short');
  const [expanded, setExpanded] = useState(false);
  const translateY = useRef(new Animated.Value(SH)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;
  const sheetH = useRef(new Animated.Value(SHEET_SMALL)).current;
  const dragY = useRef(new Animated.Value(0)).current;
  const visible = loading || !!result || !!error;

  useEffect(() => {
    if (visible) {
      setExpanded(false); setDetail('short'); dragY.setValue(0);
      Animated.parallel([
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true, tension: 70, friction: 13 }),
        Animated.timing(backdropAnim, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(translateY, { toValue: SH, duration: 260, useNativeDriver: true }),
        Animated.timing(backdropAnim, { toValue: 0, duration: 220, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  useEffect(() => {
    Animated.spring(sheetH, {
      toValue: expanded ? SHEET_BIG : SHEET_SMALL,
      useNativeDriver: false, tension: 65, friction: 13,
    }).start();
  }, [expanded]);

  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 8,
    onPanResponderMove: (_, g) => { if (g.dy > 0) dragY.setValue(g.dy); },
    onPanResponderRelease: (_, g) => {
      if (g.dy > 90) {
        if (expanded) { setExpanded(false); Animated.spring(dragY, { toValue: 0, useNativeDriver: false }).start(); }
        else { onDismiss(); }
      } else if (g.dy < -60) {
        setExpanded(true); Animated.spring(dragY, { toValue: 0, useNativeDriver: false }).start();
      } else {
        Animated.spring(dragY, { toValue: 0, useNativeDriver: false }).start();
      }
    },
  })).current;

  if (!visible) return null;
  const txtColor = mode === 'dark' ? '#E9F5F0' : '#111B21';

  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="box-none">
      <TouchableWithoutFeedback onPress={onDismiss}>
        <Animated.View style={[st.backdrop, { opacity: backdropAnim }]} />
      </TouchableWithoutFeedback>
      <Animated.View style={[st.sheet, {
        backgroundColor: C.sheet,
        height: sheetH,
        paddingBottom: insets.bottom + 12,
        transform: [{ translateY: Animated.add(translateY, dragY) }],
      }]}>
        <View {...pan.panHandlers} style={st.dragArea}>
          <View style={[st.handle, { backgroundColor: C.sheetHandle }]} />
        </View>
        <TouchableOpacity style={st.backBtn} onPress={onDismiss}>
          <Text style={[st.backArrow, { color: C.textSub }]}>←</Text>
        </TouchableOpacity>

        {loading && (
          <View style={st.center}>
            <View style={st.waveRow}>
              {[0,1,2,3,4].map(i => <WaveBar key={i} delay={i * 120} color={C.accentLight} />)}
            </View>
            <Text style={[st.loadTitle, { color: C.text }]}>Analysiere…</Text>
            <Text style={[st.loadSub, { color: C.textSub }]}>Gemini hört zu</Text>
          </View>
        )}

        {error && !loading && (
          <View style={st.center}>
            <Text style={[st.loadTitle, { color: C.danger, marginBottom: 8 }]}>Fehler</Text>
            <Text style={[st.loadSub, { color: C.textSub, textAlign: 'center' }]}>{error}</Text>
          </View>
        )}

        {result && !loading && (
          <ScrollView showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24, paddingTop: 8 }}>
            <Text style={[st.sheetTitle, { color: C.text }]}>Sprachnachricht</Text>
            <Text style={[st.sheetMeta, { color: C.textSub, marginBottom: 14 }]}>
              {fmtSec(result.duration_seconds)} · {fmtDate(result.timestamp)}
            </Text>

            <View style={st.badgeRow}>
              <View style={[st.badge, {
                backgroundColor: impColor(result.importance, C) + '20',
                borderColor: impColor(result.importance, C) + '50',
              }]}>
                <View style={[st.dot, { backgroundColor: impColor(result.importance, C) }]} />
                <Text style={[st.badgeTxt, { color: impColor(result.importance, C) }]}>
                  {impLabel(result.importance)} · {result.importance}/10
                </Text>
              </View>
              {result.deadline && (
                <View style={[st.badge, { backgroundColor: C.accent + '20', borderColor: C.accent + '50' }]}>
                  <Text style={[st.badgeTxt, { color: C.accent }]}>{result.deadline}</Text>
                </View>
              )}
            </View>

            <View style={[st.toggle, { backgroundColor: C.card, borderColor: C.cardBorder }]}>
              {(['short', 'keypoints', 'full'] as DetailLevel[]).map(lv => {
                const lbl = { short: 'Kurz', keypoints: 'Key Points', full: 'Ausführlich' }[lv];
                const active = detail === lv;
                return (
                  <TouchableOpacity key={lv} style={[st.toggleBtn, active && { backgroundColor: C.accent }]}
                    onPress={() => setDetail(lv)}>
                    <Text style={[st.toggleTxt, { color: active ? '#fff' : C.textSub }]}>{lbl}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={[st.bubble, { backgroundColor: C.msgBubble, borderColor: C.msgBubbleBorder }]}>
              {detail === 'short' && (
                <Text style={[st.bubbleTxt, { color: txtColor }]}>{result.summary_short}</Text>
              )}
              {detail === 'keypoints' && (
                <View>
                  {(result.summary_keypoints.length > 0 ? result.summary_keypoints : [result.summary_short]).map((p, i) => (
                    <View key={i} style={st.kpRow}>
                      <View style={[st.kpDot, { backgroundColor: C.accentLight }]} />
                      <Text style={[st.kpTxt, { color: txtColor }]}>{p}</Text>
                    </View>
                  ))}
                </View>
              )}
              {detail === 'full' && (
                <Text style={[st.bubbleTxt, { color: txtColor, fontSize: 14 }]}>{result.summary_full}</Text>
              )}
            </View>

            <View style={{ marginTop: 16, marginBottom: 4 }}>
              <Text style={[st.barLabel, { color: C.textSub }]}>Wichtigkeit</Text>
              <View style={[st.barBg, { backgroundColor: C.card }]}>
                <View style={[st.barFill, { width: `${result.importance * 10}%`, backgroundColor: impColor(result.importance, C) }]} />
              </View>
            </View>

            <TouchableOpacity style={[st.doneBtn, { backgroundColor: C.accent }]} onPress={onDismiss}>
              <Text style={st.doneTxt}>Fertig</Text>
            </TouchableOpacity>
          </ScrollView>
        )}
      </Animated.View>
    </View>
  );
}

// SETTINGS
function SettingsScreen({ onBack }: { onBack: () => void }) {
  const { theme: C, mode, toggle } = useTheme();
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
    <KeyboardAvoidingView style={[st.screen, { backgroundColor: C.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar barStyle={C.statusBar} backgroundColor={C.bg} />
      <View style={[st.topBar, { paddingTop: insets.top + 8, borderBottomColor: C.cardBorder }]}>
        <TouchableOpacity onPress={onBack} style={st.topBackBtn}>
          <Text style={[st.backArrow, { color: C.text }]}>←</Text>
        </TouchableOpacity>
        <Text style={[st.topBarTitle, { color: C.text }]}>Einstellungen</Text>
        <View style={{ width: 40 }} />
      </View>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <View style={[st.settCard, { backgroundColor: C.card, borderColor: C.cardBorder }]}>
          <View style={{ flex: 1 }}>
            <Text style={[st.settLabel, { color: C.text }]}>{mode === 'dark' ? 'Dunkler Modus' : 'Heller Modus'}</Text>
            <Text style={[st.settSub, { color: C.textSub }]}>WhatsApp-Farbstil</Text>
          </View>
          <Switch value={mode === 'dark'} onValueChange={toggle}
            trackColor={{ false: C.cardBorder, true: C.accent }} thumbColor="#fff" />
        </View>

        <Text style={[st.secLabel, { color: C.textSub }]}>GEMINI API KEY</Text>
        <View style={[st.settCard, { backgroundColor: C.card, borderColor: C.cardBorder, flexDirection: 'column', alignItems: 'stretch' }]}>
          <Text style={[st.settSub, { color: C.textSub, marginBottom: 10 }]}>
            Kostenlos:{' '}
            <Text style={{ color: C.accent }} onPress={() => Linking.openURL('https://aistudio.google.com/apikey')}>
              aistudio.google.com/apikey
            </Text>
          </Text>
          <TextInput style={[st.input, { color: C.text, backgroundColor: C.bg, borderColor: C.cardBorder }]}
            value={apiKey} onChangeText={setKey} placeholder="AIzaSy..."
            placeholderTextColor={C.textDim} secureTextEntry autoCapitalize="none" autoCorrect={false} />
          <TouchableOpacity style={[st.saveBtn, { backgroundColor: saved ? C.accentLight : C.accent }]} onPress={save}>
            <Text style={st.saveTxt}>{saved ? 'Gespeichert' : 'Speichern'}</Text>
          </TouchableOpacity>
        </View>

        <Text style={[st.secLabel, { color: C.textSub }]}>SO FUNKTIONIERT ES</Text>
        <View style={[st.settCard, { backgroundColor: C.card, borderColor: C.cardBorder, flexDirection: 'column', alignItems: 'stretch' }]}>
          {[
            ['Sprachnachricht teilen', 'In WhatsApp lang drücken → Weiterleiten → VoiceNote'],
            ['Analyse', 'Gemini hört direkt — keine Transkription nötig'],
            ['Overlay', 'Sheet öffnet sich von unten, nach oben ziehen für mehr'],
            ['Verlauf', 'Alle Analysen mit Minuten-Statistik'],
          ].map(([title, desc], i, arr) => (
            <View key={i} style={[st.howRow, { borderBottomColor: C.cardBorder, borderBottomWidth: i < arr.length - 1 ? 1 : 0 }]}>
              <View style={{ flex: 1 }}>
                <Text style={[st.settLabel, { color: C.text }]}>{title}</Text>
                <Text style={[st.settSub, { color: C.textSub }]}>{desc}</Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// HOME
function HomeScreen({ sharedUri, onSettings }: { sharedUri: string | null; onSettings: () => void }) {
  const { theme: C, mode } = useTheme();
  const insets = useSafeAreaInsets();
  const [history, setHistory] = useState<AnalysisResult[]>([]);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const processed = useRef<string | null>(null);

  useEffect(() => { loadHistory().then(setHistory); }, []);

  const process = useCallback(async (uri: string) => {
    if (processed.current === uri) return;
    processed.current = uri;
    const apiKey = await getApiKey();
    if (!apiKey) {
      setError('Kein API-Key gesetzt.\nBitte in Einstellungen eintragen.');
      setSheetOpen(true); return;
    }
    setResult(null); setError(null); setLoading(true); setSheetOpen(true);
    try {
      const r = await analyzeAudio(uri, apiKey);
      await saveResult(r);
      setResult(r);
      setHistory(prev => [r, ...prev]);
    } catch (e: any) {
      setError(e?.message ?? 'Unbekannter Fehler');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (sharedUri && sharedUri !== processed.current) process(sharedUri);
  }, [sharedUri]);

  const totalMin = Math.floor(history.reduce((s, h) => s + h.duration_seconds, 0) / 60);
  const heroTxtColor = mode === 'dark' ? '#C8E6DA' : '#2D6A4F';
  const heroNumColor = mode === 'dark' ? C.accentLight : C.accentDark;
  const heroValColor = mode === 'dark' ? '#E9F5F0' : '#111B21';

  return (
    <View style={[st.screen, { backgroundColor: C.bg }]}>
      <StatusBar barStyle={C.statusBar} backgroundColor={C.bg} />
      <View style={[st.topBar, { paddingTop: insets.top + 8, borderBottomColor: C.cardBorder }]}>
        <Text style={[st.topBarTitle, { color: C.text }]}>VoiceNote</Text>
        <TouchableOpacity onPress={onSettings} style={st.gearBtn}>
          <Text style={[st.gearIcon, { color: C.textSub }]}>⚙</Text>
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
        <View style={[st.heroCard, { backgroundColor: C.msgBubble, borderColor: C.msgBubbleBorder }]}>
          <View style={st.heroTop}>
            <View style={{ flex: 1 }}>
              <Text style={[st.heroNum, { color: heroNumColor }]}>{totalMin} min</Text>
              <Text style={[st.heroTxt, { color: heroTxtColor }]}>gespart</Text>
            </View>
            <View style={st.heroStats}>
              <View style={st.heroStat}>
                <Text style={[st.heroStatNum, { color: heroValColor }]}>{history.length}</Text>
                <Text style={[st.heroStatLbl, { color: heroTxtColor }]}>Nachrichten</Text>
              </View>
              <View style={[st.heroDiv, { backgroundColor: heroTxtColor + '50' }]} />
              <View style={st.heroStat}>
                <Text style={[st.heroStatNum, { color: heroValColor }]}>
                  {history.length > 0 ? (history.reduce((a, h) => a + h.importance, 0) / history.length).toFixed(1) : '–'}
                </Text>
                <Text style={[st.heroStatLbl, { color: heroTxtColor }]}>Wichtigkeit</Text>
              </View>
            </View>
          </View>
        </View>

        {history.length > 0 && (
          <View style={{ marginTop: 20 }}>
            <Text style={[st.secLabel, { color: C.textSub }]}>VERLAUF</Text>
            {history.map(item => (
              <TouchableOpacity key={item.id}
                style={[st.card, { backgroundColor: C.card, borderColor: C.cardBorder }]}
                onPress={() => { setResult(item); setSheetOpen(true); }}
                onLongPress={() => Alert.alert('Löschen?', item.summary_short.slice(0, 60) + '…', [
                  { text: 'Abbrechen', style: 'cancel' },
                  { text: 'Löschen', style: 'destructive', onPress: async () => setHistory(await deleteItem(item.id)) },
                ])}>
                <View style={st.cardTop}>
                  <View style={[st.dot, { backgroundColor: impColor(item.importance, C) }]} />
                  <Text style={[st.cardDate, { color: C.textSub }]}>{fmtDate(item.timestamp)}</Text>
                  <Text style={[st.cardDur, { color: C.textDim }]}>{fmtSec(item.duration_seconds)}</Text>
                  <Text style={[st.cardImp, { color: impColor(item.importance, C) }]}>{item.importance}/10</Text>
                </View>
                <Text style={[st.cardSum, { color: C.text }]} numberOfLines={2}>{item.summary_short}</Text>
                {item.deadline && (
                  <View style={[st.deadlineBadge, { backgroundColor: C.accent + '15', borderColor: C.accent + '40' }]}>
                    <Text style={[st.deadlineTxt, { color: C.accent }]}>{item.deadline}</Text>
                  </View>
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}

        {history.length === 0 && (
          <View style={st.empty}>
            <Text style={{ fontSize: 56 }}>🎙️</Text>
            <Text style={[st.emptyTitle, { color: C.text }]}>Keine Nachrichten</Text>
            <Text style={[st.emptySub, { color: C.textSub }]}>
              Sprachnachricht in WhatsApp{'\n'}lang drücken → Weiterleiten → VoiceNote
            </Text>
            <View style={[st.tipBox, { backgroundColor: C.card, borderColor: C.cardBorder }]}>
              {[
                'WhatsApp Sprachnachricht lang drücken',
                'Weiterleiten antippen',
                'VoiceNote auswählen',
                'Zusammenfassung erscheint sofort',
              ].map((t, i, arr) => (
                <Text key={i} style={[st.tipTxt, { color: C.textSub, borderBottomWidth: i < arr.length - 1 ? 1 : 0, borderBottomColor: C.cardBorder }]}>
                  {i + 1}. {t}
                </Text>
              ))}
            </View>
          </View>
        )}
      </ScrollView>

      {sheetOpen && (
        <BottomSheet result={result} loading={loading} error={error}
          onDismiss={() => { setSheetOpen(false); setResult(null); setError(null); }} />
      )}
    </View>
  );
}

// ROOT
function AppInner() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();
  const [sharedUri, setSharedUri] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>('home');

  useEffect(() => {
    if (hasShareIntent && shareIntent?.files?.length) {
      const f = shareIntent.files[0] as any;
      const uri = f.path ?? f.filePath ?? f.contentUri ?? null;
      if (uri) { setSharedUri(uri); setScreen('home'); }
      resetShareIntent();
    }
  }, [hasShareIntent]);

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
          <ShareIntentProvider>
            <AppInner />
          </ShareIntentProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// STYLES
const st = StyleSheet.create({
  screen: { flex: 1 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  topBarTitle: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  topBackBtn: { width: 40, height: 40, justifyContent: 'center' },
  gearBtn: { width: 40, height: 40, alignItems: 'flex-end', justifyContent: 'center' },
  gearIcon: { fontSize: 22 },
  heroCard: { borderRadius: 16, padding: 18, borderWidth: 1, marginBottom: 4 },
  heroTop: { flexDirection: 'row', alignItems: 'center' },
  heroNum: { fontSize: 40, fontWeight: '800', letterSpacing: -1 },
  heroTxt: { fontSize: 13, marginTop: 2 },
  heroStats: { flexDirection: 'row', alignItems: 'center' },
  heroStat: { alignItems: 'center', paddingHorizontal: 12 },
  heroStatNum: { fontSize: 20, fontWeight: '700' },
  heroStatLbl: { fontSize: 11, marginTop: 2 },
  heroDiv: { width: 1, height: 28 },
  secLabel: { fontSize: 11, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 },
  card: { borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  cardDate: { flex: 1, fontSize: 12 },
  cardDur: { fontSize: 12 },
  cardImp: { fontSize: 12, fontWeight: '700' },
  cardSum: { fontSize: 14, lineHeight: 20 },
  deadlineBadge: { marginTop: 8, alignSelf: 'flex-start', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1 },
  deadlineTxt: { fontSize: 12, fontWeight: '500' },
  empty: { alignItems: 'center', paddingTop: 40, paddingHorizontal: 20 },
  emptyTitle: { fontSize: 20, fontWeight: '700', marginTop: 16, marginBottom: 8 },
  emptySub: { fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 24 },
  tipBox: { width: '100%', borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  tipTxt: { fontSize: 13, padding: 14 },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.60)' },
  sheet: { position: 'absolute', bottom: 0, left: 0, right: 0, borderTopLeftRadius: 24, borderTopRightRadius: 24, shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.4, shadowRadius: 16, elevation: 24 },
  dragArea: { alignItems: 'center', paddingTop: 12, paddingBottom: 4 },
  handle: { width: 36, height: 4, borderRadius: 2 },
  backBtn: { position: 'absolute', top: 44, left: 16, padding: 8, zIndex: 10 },
  backArrow: { fontSize: 24, fontWeight: '300' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  waveRow: { flexDirection: 'row', alignItems: 'center', height: 40, marginBottom: 20 },
  loadTitle: { fontSize: 18, fontWeight: '700', marginBottom: 6 },
  loadSub: { fontSize: 13 },
  sheetTitle: { fontSize: 17, fontWeight: '700' },
  sheetMeta: { fontSize: 12, marginTop: 3 },
  badgeRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 14 },
  badge: { flexDirection: 'row', alignItems: 'center', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, gap: 5 },
  badgeTxt: { fontSize: 12, fontWeight: '600' },
  toggle: { flexDirection: 'row', borderRadius: 12, padding: 4, marginBottom: 14, borderWidth: 1, gap: 4 },
  toggleBtn: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center' },
  toggleTxt: { fontSize: 12, fontWeight: '600' },
  bubble: { borderRadius: 14, borderTopLeftRadius: 4, padding: 16, borderWidth: 1, marginBottom: 4 },
  bubbleTxt: { fontSize: 16, lineHeight: 24, fontWeight: '500' },
  kpRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10, gap: 10 },
  kpDot: { width: 6, height: 6, borderRadius: 3, marginTop: 7 },
  kpTxt: { flex: 1, fontSize: 14, lineHeight: 21 },
  barLabel: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 },
  barBg: { height: 6, borderRadius: 3, overflow: 'hidden', marginBottom: 6 },
  barFill: { height: '100%', borderRadius: 3 },
  doneBtn: { borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
  doneTxt: { color: '#fff', fontSize: 16, fontWeight: '700' },
  settCard: { borderRadius: 14, padding: 16, borderWidth: 1, flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  settLabel: { fontSize: 15, fontWeight: '600' },
  settSub: { fontSize: 12, marginTop: 2, lineHeight: 18 },
  input: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, marginBottom: 12 },
  saveBtn: { borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  saveTxt: { color: '#fff', fontSize: 15, fontWeight: '700' },
  howRow: { paddingVertical: 14 },
});
