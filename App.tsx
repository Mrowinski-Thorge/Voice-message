/**
 * VoiceNote Analyzer
 * WhatsApp Sprachnachricht → Gemini 2.5 Flash-Lite → Sofort-Zusammenfassung
 */

import React, { useEffect, useState, useRef, useCallback, createContext, useContext } from 'react';
import {
  View, Text, StyleSheet, Animated, TouchableOpacity, TouchableWithoutFeedback,
  ScrollView, TextInput, Alert, StatusBar, Dimensions, Linking, ActivityIndicator,
  KeyboardAvoidingView, Platform, PanResponder, Switch,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useShareIntent, ShareIntentProvider } from 'expo-share-intent';

// ─── TYPES ───────────────────────────────────
export interface AnalysisResult {
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
type ThemeMode = 'dark' | 'light';

// ─── THEME ───────────────────────────────────
const DARK = {
  bg: '#0B0E11',
  surface: '#111418',
  card: '#1A1E24',
  cardBorder: '#252B33',
  sheet: '#161B22',
  sheetHandle: '#2D3540',
  text: '#E9EDEF',
  textSub: '#8696A0',
  textDim: '#3D4A54',
  accent: '#00A884',       // WhatsApp Grün
  accentDark: '#008069',
  accentLight: '#25D366',
  msgBubble: '#005C4B',    // WhatsApp gesendete Nachricht
  msgBubbleBorder: '#007A63',
  tabBar: '#1F262E',
  tabBarBorder: '#2D3540',
  danger: '#FF6B6B',
  warning: '#FFB74D',
  statusBar: 'light-content' as const,
};

const LIGHT = {
  bg: '#F0F2F5',
  surface: '#FFFFFF',
  card: '#FFFFFF',
  cardBorder: '#E9EDEF',
  sheet: '#FFFFFF',
  sheetHandle: '#C4C9CC',
  text: '#111B21',
  textSub: '#54656F',
  textDim: '#B0BEC5',
  accent: '#00A884',
  accentDark: '#008069',
  accentLight: '#25D366',
  msgBubble: '#DCF8C6',    // WhatsApp empfangene Nachricht hell
  msgBubbleBorder: '#C5E8B0',
  tabBar: '#FFFFFF',
  tabBarBorder: '#E9EDEF',
  danger: '#E53935',
  warning: '#F57C00',
  statusBar: 'dark-content' as const,
};

// ─── THEME CONTEXT ───────────────────────────
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

  const theme = mode === 'dark' ? DARK : LIGHT;
  return <ThemeCtx.Provider value={{ theme, mode, toggle }}>{children}</ThemeCtx.Provider>;
}

// ─── GEMINI API ───────────────────────────────
const GEMINI_MODEL = 'gemini-2.5-flash-lite-preview-09-2025';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function getMime(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return ({ ogg: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mp3', wav: 'audio/wav',
    m4a: 'audio/aac', aac: 'audio/aac', flac: 'audio/flac' } as any)[ext] ?? 'audio/ogg';
}

async function analyzeAudio(fileUri: string, apiKey: string): Promise<AnalysisResult> {
  let b64: string;
  try {
    b64 = await FileSystem.readAsStringAsync(fileUri, { encoding: FileSystem.EncodingType.Base64 });
  } catch (e) {
    throw new Error(`Datei nicht lesbar. Bitte Dateizugriff erlauben.`);
  }

  const prompt = `Analysiere diese WhatsApp-Sprachnachricht. Antworte NUR mit validem JSON, ohne Backticks, ohne Erklärungen:
{
  "summary_short": "Ein präziser Satz max 100 Zeichen",
  "summary_keypoints": ["Punkt 1", "Punkt 2", "Punkt 3"],
  "summary_full": "2-3 Sätze ausführlich mit allen Details",
  "deadline": "Erkannter Termin wie 'Morgen 14:00 Uhr' oder null",
  "importance": 6,
  "duration_seconds": 30
}
Regeln: importance 1-10 (10=extrem dringend). Erhöhe bei Terminen/Fristen +3, dringender Sprache +2, Aufgaben +1. Antworte auf Deutsch wenn die Nachricht deutsch ist.`;

  const res = await fetch(`${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: getMime(fileUri), data: b64 } },
        { text: prompt }
      ]}],
      generationConfig: { temperature: 0.1, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    if (res.status === 403) throw new Error('API-Key ungültig. Bitte in ⚙️ Einstellungen prüfen.');
    if (res.status === 400) throw new Error('Audio-Format nicht erkannt. Nur WhatsApp-Sprachnachrichten.');
    throw new Error(`Gemini Fehler ${res.status}`);
  }

  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const clean = raw.replace(/```json|```/g, '').trim();

  let parsed: any;
  try { parsed = JSON.parse(clean); }
  catch { throw new Error('KI-Antwort konnte nicht verarbeitet werden.'); }

  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
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

// ─── STORAGE ──────────────────────────────────
async function saveResult(r: AnalysisResult) {
  const raw = await AsyncStorage.getItem('history');
  const list: AnalysisResult[] = raw ? JSON.parse(raw) : [];
  await AsyncStorage.setItem('history', JSON.stringify([r, ...list].slice(0, 50)));
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
async function setApiKeyStorage(k: string) { await AsyncStorage.setItem('api_key', k); }

// ─── HELPERS ──────────────────────────────────
const { height: SH, width: SW } = Dimensions.get('window');
const SHEET_SNAP = { collapsed: SH * 0.38, expanded: SH * 0.76 };

function fmtSec(s: number) { return s < 60 ? `${s}s` : `${Math.floor(s/60)}m ${s%60}s`; }
function fmtDate(ts: number) {
  const d = new Date(ts), n = new Date();
  const isTday = d.toDateString() === n.toDateString();
  const yest = new Date(n); yest.setDate(n.getDate()-1);
  const isYest = d.toDateString() === yest.toDateString();
  const hm = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
  if (isTday) return `Heute ${hm}`;
  if (isYest) return `Gestern ${hm}`;
  return d.toLocaleDateString('de-DE', { day:'2-digit', month:'short' }) + ` ${hm}`;
}
function impColor(imp: number, t: typeof DARK) {
  if (imp >= 8) return t.danger;
  if (imp >= 5) return t.warning;
  return t.accentLight;
}
function impLabel(imp: number) {
  if (imp >= 8) return 'Dringend';
  if (imp >= 5) return 'Wichtig';
  return 'Normal';
}

// ─── BOTTOM SHEET ────────────────────────────
const SHEET_HEIGHT_COLLAPSED = SH * 0.42;
const SHEET_HEIGHT_EXPANDED  = SH * 0.80;

interface SheetProps {
  result: AnalysisResult | null;
  loading: boolean;
  error: string | null;
  onDismiss: () => void;
}

function BottomSheet({ result, loading, error, onDismiss }: SheetProps) {
  const { theme, mode } = useTheme();
  const insets = useSafeAreaInsets();
  const [detail, setDetail] = useState<DetailLevel>('short');
  const [expanded, setExpanded] = useState(false);

  // Animation
  const translateY = useRef(new Animated.Value(SH)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;
  const sheetH = useRef(new Animated.Value(SHEET_HEIGHT_COLLAPSED)).current;

  const visible = loading || !!result || !!error;

  useEffect(() => {
    if (visible) {
      setExpanded(false);
      setDetail('short');
      Animated.parallel([
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true, tension: 70, friction: 12 }),
        Animated.timing(backdropAnim, { toValue: 1, duration: 250, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(translateY, { toValue: SH, duration: 280, useNativeDriver: true }),
        Animated.timing(backdropAnim, { toValue: 0, duration: 250, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  useEffect(() => {
    Animated.spring(sheetH, {
      toValue: expanded ? SHEET_HEIGHT_EXPANDED : SHEET_HEIGHT_COLLAPSED,
      useNativeDriver: false, tension: 60, friction: 12,
    }).start();
  }, [expanded]);

  // Pan responder for drag
  const panY = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 5,
    onPanResponderMove: (_, g) => { if (g.dy > 0) panY.setValue(g.dy); },
    onPanResponderRelease: (_, g) => {
      if (g.dy > 80) {
        if (expanded) { setExpanded(false); panY.setValue(0); }
        else { onDismiss(); }
      } else if (g.dy < -60) {
        setExpanded(true); panY.setValue(0);
      } else {
        Animated.spring(panY, { toValue: 0, useNativeDriver: false }).start();
      }
    },
  })).current;

  if (!visible) return null;

  const C = theme;

  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="box-none">
      <TouchableWithoutFeedback onPress={onDismiss}>
        <Animated.View style={[s.backdrop, { opacity: backdropAnim }]} />
      </TouchableWithoutFeedback>

      <Animated.View
        style={[s.sheet, {
          backgroundColor: C.sheet,
          height: sheetH,
          paddingBottom: insets.bottom + 12,
          transform: [
            { translateY: Animated.add(translateY, panY) }
          ],
        }]}
      >
        {/* Drag Handle */}
        <View {...panResponder.panHandlers} style={s.dragArea}>
          <View style={[s.handle, { backgroundColor: C.sheetHandle }]} />
        </View>

        {loading && (
          <View style={s.centerBox}>
            <View style={[s.waveContainer]}>
              {[0,1,2,3,4].map(i => (
                <WaveBar key={i} delay={i * 120} color={C.accentLight} />
              ))}
            </View>
            <Text style={[s.loadTitle, { color: C.text }]}>Analysiere…</Text>
            <Text style={[s.loadSub, { color: C.textSub }]}>Gemini 2.5 Flash-Lite hört zu</Text>
          </View>
        )}

        {error && !loading && (
          <View style={s.centerBox}>
            <Text style={{ fontSize: 40, marginBottom: 12 }}>⚠️</Text>
            <Text style={[s.loadTitle, { color: C.danger }]}>Fehler</Text>
            <Text style={[s.errorMsg, { color: C.textSub }]}>{error}</Text>
            <TouchableOpacity style={[s.pill, { backgroundColor: C.card, borderColor: C.cardBorder, marginTop: 20 }]} onPress={onDismiss}>
              <Text style={{ color: C.text, fontSize: 15, fontWeight: '600' }}>Schließen</Text>
            </TouchableOpacity>
          </View>
        )}

        {result && !loading && (
          <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20 }}>
            {/* Header */}
            <View style={s.sheetRow}>
              <View style={{ flex: 1 }}>
                <Text style={[s.sheetTitle, { color: C.text }]}>🎙️ Sprachnachricht</Text>
                <Text style={[s.sheetMeta, { color: C.textSub }]}>{fmtSec(result.duration_seconds)} · {fmtDate(result.timestamp)}</Text>
              </View>
              <TouchableOpacity onPress={onDismiss} style={[s.closeBtn, { backgroundColor: C.card, borderColor: C.cardBorder }]}>
                <Text style={{ color: C.textSub, fontSize: 16 }}>✕</Text>
              </TouchableOpacity>
            </View>

            {/* Badges */}
            <View style={s.badgeRow}>
              <View style={[s.badge, { backgroundColor: impColor(result.importance, C) + '20', borderColor: impColor(result.importance, C) + '50' }]}>
                <View style={[s.dot, { backgroundColor: impColor(result.importance, C) }]} />
                <Text style={[s.badgeTxt, { color: impColor(result.importance, C) }]}>{impLabel(result.importance)} · {result.importance}/10</Text>
              </View>
              {result.deadline && (
                <View style={[s.badge, { backgroundColor: C.accent + '20', borderColor: C.accent + '50' }]}>
                  <Text style={[s.badgeTxt, { color: C.accent }]}>📅 {result.deadline}</Text>
                </View>
              )}
            </View>

            {/* Detail Toggle */}
            <View style={[s.toggle, { backgroundColor: C.card, borderColor: C.cardBorder }]}>
              {(['short','keypoints','full'] as DetailLevel[]).map(lv => {
                const lbl = { short:'Kurz', keypoints:'Key Points', full:'Ausführlich' }[lv];
                const active = detail === lv;
                return (
                  <TouchableOpacity key={lv} style={[s.toggleBtn, active && { backgroundColor: C.accent }]} onPress={() => setDetail(lv)}>
                    <Text style={[s.toggleTxt, { color: active ? '#fff' : C.textSub }]}>{lbl}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Message Bubble */}
            <View style={[s.bubble, { backgroundColor: C.msgBubble, borderColor: C.msgBubbleBorder }]}>
              {detail === 'short' && <Text style={[s.bubbleTxt, { color: mode === 'dark' ? '#E9F5F0' : '#111B21' }]}>{result.summary_short}</Text>}
              {detail === 'keypoints' && (
                <View>
                  {result.summary_keypoints.map((p, i) => (
                    <View key={i} style={s.kpRow}>
                      <View style={[s.kpDot, { backgroundColor: C.accentLight }]} />
                      <Text style={[s.kpTxt, { color: mode === 'dark' ? '#E9F5F0' : '#111B21' }]}>{p}</Text>
                    </View>
                  ))}
                  {result.summary_keypoints.length === 0 && (
                    <Text style={[s.bubbleTxt, { color: mode === 'dark' ? '#E9F5F0' : '#111B21' }]}>{result.summary_short}</Text>
                  )}
                </View>
              )}
              {detail === 'full' && <Text style={[s.bubbleFullTxt, { color: mode === 'dark' ? '#E9F5F0' : '#111B21' }]}>{result.summary_full}</Text>}
              {/* WhatsApp tick */}
              <Text style={[s.bubbleTick, { color: C.accentLight }]}>✓✓</Text>
            </View>

            {/* Importance Bar */}
            <View style={{ marginTop: 16 }}>
              <Text style={[s.barLabel, { color: C.textSub }]}>Wichtigkeit</Text>
              <View style={[s.barBg, { backgroundColor: C.card }]}>
                <View style={[s.barFill, { width: `${result.importance * 10}%`, backgroundColor: impColor(result.importance, C) }]} />
              </View>
              <View style={s.barNums}>
                {Array.from({length:10},(_,i)=>i+1).map(n => (
                  <Text key={n} style={[s.barNum, { color: n === result.importance ? impColor(result.importance, C) : C.textDim }]}>{n}</Text>
                ))}
              </View>
            </View>

            <TouchableOpacity
              style={[s.doneBtn, { backgroundColor: C.accent }]}
              onPress={onDismiss}
            >
              <Text style={s.doneTxt}>Fertig ✓</Text>
            </TouchableOpacity>
          </ScrollView>
        )}
      </Animated.View>
    </View>
  );
}

// Wave animation bar
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
      width: 4, height: 28, borderRadius: 2,
      backgroundColor: color, marginHorizontal: 3,
      transform: [{ scaleY: anim }],
    }} />
  );
}

// ─── HISTORY SCREEN ───────────────────────────
function HistoryScreen({ sharedUri }: { sharedUri: string | null }) {
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
      setError('Kein API-Key gesetzt.\nBitte in ⚙️ Einstellungen eintragen.');
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
  const last3 = history.slice(0, 3);

  return (
    <View style={[s.screen, { backgroundColor: C.bg, paddingTop: insets.top }]}>
      <StatusBar barStyle={C.statusBar} backgroundColor={C.bg} />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32 }}>

        {/* Header */}
        <View style={s.header}>
          <View>
            <Text style={[s.appName, { color: C.text }]}>VoiceNote</Text>
            <Text style={[s.appSub, { color: C.textSub }]}>KI-Zusammenfassung</Text>
          </View>
          <View style={[s.headerBadge, { backgroundColor: C.accent + '20', borderColor: C.accent + '40' }]}>
            <Text style={[s.headerBadgeTxt, { color: C.accentLight }]}>🤖 Flash-Lite</Text>
          </View>
        </View>

        {/* Stats: "Du hast X Minuten Sprachnachrichten gespart" */}
        <View style={[s.heroCard, { backgroundColor: C.msgBubble, borderColor: C.msgBubbleBorder }]}>
          <Text style={[s.heroNum, { color: mode === 'dark' ? C.accentLight : C.accentDark }]}>{totalMin} min</Text>
          <Text style={[s.heroTxt, { color: mode === 'dark' ? '#C8E6DA' : '#2D6A4F' }]}>
            Sprachnachrichten{'\n'}gespart ✓✓
          </Text>
          <View style={s.heroStats}>
            <View style={s.heroStat}>
              <Text style={[s.heroStatNum, { color: mode === 'dark' ? '#E9F5F0' : '#111B21' }]}>{history.length}</Text>
              <Text style={[s.heroStatLbl, { color: mode === 'dark' ? '#A8D5C2' : '#3D7A5C' }]}>Nachrichten</Text>
            </View>
            <View style={[s.heroStatDiv, { backgroundColor: mode === 'dark' ? '#3D7A5C' : '#A8D5C2' }]} />
            <View style={s.heroStat}>
              <Text style={[s.heroStatNum, { color: mode === 'dark' ? '#E9F5F0' : '#111B21' }]}>
                {history.length > 0 ? (history.reduce((a,h)=>a+h.importance,0)/history.length).toFixed(1) : '–'}
              </Text>
              <Text style={[s.heroStatLbl, { color: mode === 'dark' ? '#A8D5C2' : '#3D7A5C' }]}>Ø Wichtigkeit</Text>
            </View>
          </View>
        </View>

        {/* Last 3 preview */}
        {last3.length > 0 && (
          <View style={{ marginTop: 20 }}>
            <Text style={[s.secTitle, { color: C.textSub }]}>ZULETZT</Text>
            {last3.map(item => (
              <TouchableOpacity
                key={item.id}
                style={[s.card, { backgroundColor: C.card, borderColor: C.cardBorder }]}
                onPress={() => { setResult(item); setSheetOpen(true); }}
                onLongPress={() => Alert.alert('Löschen?', item.summary_short.slice(0, 60) + '…', [
                  { text: 'Abbrechen', style: 'cancel' },
                  { text: 'Löschen', style: 'destructive', onPress: async () => setHistory(await deleteItem(item.id)) },
                ])}
              >
                <View style={s.cardTop}>
                  <View style={[s.dot, { backgroundColor: impColor(item.importance, C), width: 8, height: 8 }]} />
                  <Text style={[s.cardDate, { color: C.textSub }]}>{fmtDate(item.timestamp)}</Text>
                  <Text style={[s.cardDur, { color: C.textDim }]}>{fmtSec(item.duration_seconds)}</Text>
                  <Text style={[s.cardImp, { color: impColor(item.importance, C) }]}>{item.importance}/10</Text>
                </View>
                <Text style={[s.cardSum, { color: C.text }]} numberOfLines={2}>{item.summary_short}</Text>
                {item.deadline && (
                  <View style={[s.deadlineBadge, { backgroundColor: C.accent + '15', borderColor: C.accent + '40' }]}>
                    <Text style={[s.deadlineTxt, { color: C.accent }]}>📅 {item.deadline}</Text>
                  </View>
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Empty */}
        {history.length === 0 && (
          <View style={s.empty}>
            <Text style={{ fontSize: 52 }}>🎙️</Text>
            <Text style={[s.emptyTitle, { color: C.text }]}>Noch keine Nachrichten</Text>
            <Text style={[s.emptySub, { color: C.textSub }]}>
              Sprachnachricht in WhatsApp{'\n'}lang drücken → Weiterleiten → VoiceNote
            </Text>
            <View style={[s.tipBox, { backgroundColor: C.card, borderColor: C.cardBorder }]}>
              {['① WhatsApp Sprachnachricht lang drücken','② „Weiterleiten" antippen','③ „VoiceNote" auswählen','④ Zusammenfassung erscheint sofort ✓'].map((t,i) => (
                <Text key={i} style={[s.tipTxt, { color: C.textSub, borderBottomColor: i < 3 ? C.cardBorder : 'transparent' }]}>{t}</Text>
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

// ─── SETTINGS SCREEN ─────────────────────────
function SettingsScreen() {
  const { theme: C, mode, toggle } = useTheme();
  const insets = useSafeAreaInsets();
  const [apiKey, setKey] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => { getApiKey().then(setKey); }, []);

  const save = async () => {
    if (!apiKey.trim()) { Alert.alert('Fehler', 'API-Key eingeben.'); return; }
    await setApiKeyStorage(apiKey.trim());
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  return (
    <KeyboardAvoidingView style={[s.screen, { backgroundColor: C.bg, paddingTop: insets.top }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
        <Text style={[s.settTitle, { color: C.text }]}>Einstellungen</Text>

        {/* Dark / Light Mode */}
        <View style={[s.settCard, { backgroundColor: C.card, borderColor: C.cardBorder }]}>
          <View style={{ flex: 1 }}>
            <Text style={[s.settLabel, { color: C.text }]}>{mode === 'dark' ? '🌙 Dunkler Modus' : '☀️ Heller Modus'}</Text>
            <Text style={[s.settSub, { color: C.textSub }]}>WhatsApp-Farbstil</Text>
          </View>
          <Switch
            value={mode === 'dark'}
            onValueChange={toggle}
            trackColor={{ false: C.cardBorder, true: C.accent }}
            thumbColor="#fff"
          />
        </View>

        {/* API Key */}
        <Text style={[s.secTitle, { color: C.textSub, marginTop: 24 }]}>GEMINI API KEY</Text>
        <View style={[s.settCard, { backgroundColor: C.card, borderColor: C.cardBorder, flexDirection: 'column', alignItems: 'stretch' }]}>
          <Text style={[s.settSub, { color: C.textSub, marginBottom: 10 }]}>
            Kostenlos:{' '}
            <Text style={{ color: C.accent }} onPress={() => Linking.openURL('https://aistudio.google.com/apikey')}>
              aistudio.google.com/apikey
            </Text>
          </Text>
          <TextInput
            style={[s.input, { color: C.text, backgroundColor: C.bg, borderColor: C.cardBorder }]}
            value={apiKey}
            onChangeText={setKey}
            placeholder="AIzaSy..."
            placeholderTextColor={C.textDim}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity style={[s.saveBtn, { backgroundColor: saved ? C.accentLight : C.accent }]} onPress={save}>
            <Text style={s.saveTxt}>{saved ? '✓ Gespeichert' : 'Speichern'}</Text>
          </TouchableOpacity>
        </View>

        {/* Model info */}
        <Text style={[s.secTitle, { color: C.textSub, marginTop: 24 }]}>MODELL</Text>
        <View style={[s.settCard, { backgroundColor: C.card, borderColor: C.cardBorder, flexDirection: 'column', alignItems: 'stretch' }]}>
          <Text style={[s.settLabel, { color: C.text }]}>gemini-2.5-flash-lite-preview-09-2025</Text>
          <Text style={[s.settSub, { color: C.textSub, marginTop: 4 }]}>Googles schnellstes Modell · Audio-nativ · ~0,00007$/Min</Text>
        </View>

        {/* How it works */}
        <Text style={[s.secTitle, { color: C.textSub, marginTop: 24 }]}>SO FUNKTIONIERT ES</Text>
        <View style={[s.settCard, { backgroundColor: C.card, borderColor: C.cardBorder, flexDirection: 'column', alignItems: 'stretch' }]}>
          {[
            ['🎙️', 'Sprachnachricht teilen', 'In WhatsApp lang drücken → Weiterleiten → VoiceNote'],
            ['🤖', 'KI analysiert', 'Gemini hört direkt — keine Transkription nötig'],
            ['📋', 'Overlay erscheint', 'Bottom Sheet von unten mit Zusammenfassung'],
            ['📊', 'Verlauf', 'Alle Analysen gespart + Minuten-Statistik'],
          ].map(([icon, title, desc], i) => (
            <View key={i} style={[s.howRow, { borderBottomColor: i < 3 ? C.cardBorder : 'transparent' }]}>
              <Text style={{ fontSize: 22 }}>{icon}</Text>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={[s.settLabel, { color: C.text }]}>{title}</Text>
                <Text style={[s.settSub, { color: C.textSub }]}>{desc}</Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─── NAVIGATION ───────────────────────────────
const Tab = createBottomTabNavigator();

function AppInner() {
  const { theme: C } = useTheme();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();
  const [sharedUri, setSharedUri] = useState<string | null>(null);

  useEffect(() => {
    if (hasShareIntent && shareIntent?.files?.length) {
      const f = shareIntent.files[0] as any;
      const uri = f.path ?? f.filePath ?? f.contentUri ?? null;
      if (uri) setSharedUri(uri);
      resetShareIntent();
    }
  }, [hasShareIntent]);

  return (
    <NavigationContainer theme={{ dark: C === DARK, colors: {
      primary: C.accent, background: C.bg, card: C.tabBar,
      text: C.text, border: C.tabBarBorder, notification: C.accent,
    }}}>
      <Tab.Navigator screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: { backgroundColor: C.tabBar, borderTopColor: C.tabBarBorder, height: 58, paddingBottom: 6 },
        tabBarActiveTintColor: C.accentLight,
        tabBarInactiveTintColor: C.textDim,
        tabBarLabel: route.name === 'Home' ? 'Nachrichten' : 'Einstellungen',
        tabBarIcon: ({ focused }) => (
          <Text style={{ fontSize: 22, opacity: focused ? 1 : 0.45 }}>
            {route.name === 'Home' ? '🎙️' : '⚙️'}
          </Text>
        ),
      })}>
        <Tab.Screen name="Home">{() => <HistoryScreen sharedUri={sharedUri} />}</Tab.Screen>
        <Tab.Screen name="Settings" component={SettingsScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
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

// ─── STYLES ───────────────────────────────────
const s = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 16 },

  // Header
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 20, paddingBottom: 16 },
  appName: { fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  appSub: { fontSize: 12, marginTop: 1 },
  headerBadge: { borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1 },
  headerBadgeTxt: { fontSize: 12, fontWeight: '600' },

  // Hero Card (WhatsApp bubble style)
  heroCard: { borderRadius: 16, padding: 18, borderWidth: 1, marginBottom: 4 },
  heroNum: { fontSize: 42, fontWeight: '800', letterSpacing: -1 },
  heroTxt: { fontSize: 14, marginTop: 2, lineHeight: 20 },
  heroStats: { flexDirection: 'row', alignItems: 'center', marginTop: 16 },
  heroStat: { alignItems: 'center', flex: 1 },
  heroStatNum: { fontSize: 20, fontWeight: '700' },
  heroStatLbl: { fontSize: 11, marginTop: 2 },
  heroStatDiv: { width: 1, height: 32, marginHorizontal: 12 },

  // Section title
  secTitle: { fontSize: 11, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 },

  // Card
  card: { borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  cardDate: { flex: 1, fontSize: 12 },
  cardDur: { fontSize: 12 },
  cardImp: { fontSize: 12, fontWeight: '700' },
  cardSum: { fontSize: 14, lineHeight: 20 },
  deadlineBadge: { marginTop: 8, alignSelf: 'flex-start', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1 },
  deadlineTxt: { fontSize: 12, fontWeight: '500' },

  // Empty
  empty: { alignItems: 'center', paddingTop: 40, paddingHorizontal: 20 },
  emptyTitle: { fontSize: 20, fontWeight: '700', marginTop: 16, marginBottom: 8 },
  emptySub: { fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 24 },
  tipBox: { width: '100%', borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  tipTxt: { fontSize: 13, padding: 14, borderBottomWidth: 1 },

  // Bottom Sheet
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.60)' },
  sheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    shadowColor: '#000', shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.4, shadowRadius: 16, elevation: 24,
  },
  dragArea: { alignItems: 'center', paddingVertical: 12 },
  handle: { width: 36, height: 4, borderRadius: 2 },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  waveContainer: { flexDirection: 'row', alignItems: 'center', height: 40, marginBottom: 20 },
  loadTitle: { fontSize: 18, fontWeight: '700', marginBottom: 6 },
  loadSub: { fontSize: 13 },
  errorMsg: { fontSize: 14, textAlign: 'center', lineHeight: 21, marginTop: 6 },
  pill: { borderRadius: 20, paddingHorizontal: 24, paddingVertical: 10, borderWidth: 1 },
  sheetRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 14 },
  sheetTitle: { fontSize: 17, fontWeight: '700' },
  sheetMeta: { fontSize: 12, marginTop: 3 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  badgeRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 14 },
  badge: { flexDirection: 'row', alignItems: 'center', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, gap: 5 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  badgeTxt: { fontSize: 12, fontWeight: '600' },
  toggle: { flexDirection: 'row', borderRadius: 12, padding: 4, marginBottom: 14, borderWidth: 1, gap: 4 },
  toggleBtn: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center' },
  toggleTxt: { fontSize: 12, fontWeight: '600' },
  bubble: { borderRadius: 14, borderTopLeftRadius: 4, padding: 16, borderWidth: 1, marginBottom: 4 },
  bubbleTxt: { fontSize: 16, lineHeight: 24, fontWeight: '500' },
  bubbleFullTxt: { fontSize: 14, lineHeight: 22 },
  bubbleTick: { fontSize: 11, textAlign: 'right', marginTop: 6 },
  kpRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10, gap: 10 },
  kpDot: { width: 6, height: 6, borderRadius: 3, marginTop: 7 },
  kpTxt: { flex: 1, fontSize: 14, lineHeight: 21 },
  barLabel: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 },
  barBg: { height: 6, borderRadius: 3, overflow: 'hidden', marginBottom: 6 },
  barFill: { height: '100%', borderRadius: 3 },
  barNums: { flexDirection: 'row', justifyContent: 'space-between' },
  barNum: { fontSize: 10, width: 16, textAlign: 'center' },
  doneBtn: { borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
  doneTxt: { color: '#fff', fontSize: 16, fontWeight: '700' },

  // Settings
  settTitle: { fontSize: 26, fontWeight: '800', marginTop: 20, marginBottom: 20, letterSpacing: -0.5 },
  settCard: { borderRadius: 14, padding: 16, borderWidth: 1, flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  settLabel: { fontSize: 15, fontWeight: '600' },
  settSub: { fontSize: 12, marginTop: 2, lineHeight: 18 },
  input: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, marginBottom: 12 },
  saveBtn: { borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  saveTxt: { color: '#fff', fontSize: 15, fontWeight: '700' },
  howRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 14, borderBottomWidth: 1 },
});
