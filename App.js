// ╔══════════════════════════════════════════════════════════════════════════╗
// ║          GEMINI VERTEX AI CHAT APP  —  single file, Expo Go             ║
// ║  Ersetze DEIN_API_KEY und DEIN_PROJECT_ID unten ODER trag sie in der   ║
// ║  App unter ⚙️ Einstellungen ein.                                         ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import React, {
  useState, useRef, useCallback, useEffect,
} from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  ScrollView, StyleSheet, SafeAreaView, ActivityIndicator,
  KeyboardAvoidingView, Platform, Image, StatusBar,
  Alert, Dimensions, Animated,
} from 'react-native';

// ─── DESIGN TOKENS ────────────────────────────────────────────────────────────
const C = {
  bg:        '#07090d',
  surface:   '#0e1420',
  surface2:  '#151d2e',
  surface3:  '#1c2640',
  border:    '#1e2d44',
  teal:      '#0891b2',
  tealDark:  '#0e7490',
  tealGlow:  '#22d3ee22',
  purple:    '#7c3aed',
  amber:     '#d97706',
  pink:      '#db2777',
  orange:    '#ea580c',
  green:     '#059669',
  red:       '#dc2626',
  text:      '#e2e8f0',
  textMid:   '#94a3b8',
  textDim:   '#475569',
  userBubble:'#0c3d52',
  aiBubble:  '#111c2e',
};

const { width: W } = Dimensions.get('window');

// ─── MODELS ───────────────────────────────────────────────────────────────────
const CHAT_MODELS = {
  lite: {
    key: 'lite',
    id:  'gemini-2.5-flash-lite-preview-06-17',
    label: 'Flash Lite 2.5',
    icon: '⚡',
    desc: 'Schnellstes Modell',
    color: C.amber,
    thinking: false,
  },
  flash: {
    key: 'flash',
    id:  'gemini-2.5-flash-preview-05-20',
    label: 'Flash 2.5',
    icon: '🚀',
    desc: 'Standard – beste Balance',
    color: C.teal,
    thinking: false,
  },
  pro: {
    key: 'pro',
    id:  'gemini-2.5-pro-preview-06-05',
    label: 'Pro 2.5',
    icon: '🧠',
    desc: 'Deep Thinking',
    color: C.purple,
    thinking: true,
  },
};

const IMAGE_MODELS = {
  imagen4: {
    key: 'imagen4',
    id:  'imagen-4.0-generate-preview-05-20',
    label: 'Imagen 4',
    icon: '✦',
    desc: 'Neuestes · Höchste Qualität',
    color: C.pink,
  },
  imagen3: {
    key: 'imagen3',
    id:  'imagen-3.0-generate-002',
    label: 'Imagen 3',
    icon: '◈',
    desc: 'Stabil · Schneller',
    color: C.orange,
  },
};

const TABS = [
  { id: 'chat',     icon: '◉', label: 'Chat'    },
  { id: 'images',   icon: '◈', label: 'Bilder'  },
  { id: 'settings', icon: '◎', label: 'Config'  },
];

// ─── VERTEX AI HELPER ─────────────────────────────────────────────────────────
function buildEndpoint(location, projectId, modelId, action) {
  return `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${modelId}:${action}`;
}

function apiHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey,
  };
}

function parseApiError(status, body) {
  const msg = body?.error?.message || '';
  if (status === 429) return `⏳ Rate Limit (429)\n${msg || 'Warte kurz und versuche es erneut.'}\n\nTipp: Erhöhe dein Quota unter Vertex AI → Quotas in der Google Cloud Console.`;
  if (status === 403) return `🔑 Keine Berechtigung (403)\n${msg}\n\nTipp: API Key prüfen, Vertex AI API aktiviert?`;
  if (status === 404) return `❌ Modell nicht gefunden (404)\n${msg}\n\nTipp: Project ID und Location prüfen. Ist das Modell in deiner Region verfügbar?`;
  if (status === 400) return `⚠️ Ungültige Anfrage (400)\n${msg}`;
  if (status >= 500) return `🔥 Vertex AI Server-Fehler (${status})\nVersuche es später erneut.`;
  return `Fehler ${status}: ${msg || 'Unbekannt'}`;
}

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {

  // ── CONFIG ────────────────────────────────────────────────────────────────
  const [apiKey,    setApiKey]    = useState('');   // ← hier eintragen oder in der App
  const [projectId, setProjectId] = useState('');   // ← dein GCP Project ID
  const [location,  setLocation]  = useState('us-central1');
  const [chatModel, setChatModel] = useState('flash');
  const [imgModel,  setImgModel]  = useState('imagen4');

  // ── UI ────────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState('chat');
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // ── CHAT ──────────────────────────────────────────────────────────────────
  const [messages,     setMessages]     = useState([WELCOME_MSG()]);
  const [chatInput,    setChatInput]    = useState('');
  const [chatLoading,  setChatLoading]  = useState(false);
  const [thinkingText, setThinkingText] = useState('');
  const flatRef = useRef(null);

  // ── IMAGE ─────────────────────────────────────────────────────────────────
  const [imgPrompt,   setImgPrompt]   = useState('');
  const [imgResult,   setImgResult]   = useState(null);
  const [imgLoading,  setImgLoading]  = useState(false);
  const [imgError,    setImgError]    = useState('');
  const [aspectRatio, setAspectRatio] = useState('1:1');

  // ── PULSE ANIMATION ───────────────────────────────────────────────────────
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.4, duration: 900, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1,   duration: 900, useNativeDriver: true }),
      ])
    );
    if (chatLoading || imgLoading) loop.start();
    else { loop.stop(); pulseAnim.setValue(1); }
    return () => loop.stop();
  }, [chatLoading, imgLoading]);

  const isReady = !!(apiKey && projectId);

  // ─── CHECK CONFIG ──────────────────────────────────────────────────────────
  const checkConfig = () => {
    if (!isReady) {
      Alert.alert('⚙️ Konfiguration', 'Bitte API Key und Project ID in "Config" eintragen.', [
        { text: 'Zu Config', onPress: () => setActiveTab('settings') },
        { text: 'Abbrechen' },
      ]);
      return false;
    }
    return true;
  };

  // ─── SEND CHAT ─────────────────────────────────────────────────────────────
  const sendChat = useCallback(async () => {
    const text = chatInput.trim();
    if (!text || chatLoading) return;
    if (!checkConfig()) return;

    const userMsg = { id: uid(), role: 'user', content: text, ts: Date.now() };
    const history = [...messages, userMsg];
    setMessages(history);
    setChatInput('');
    setChatLoading(true);
    setThinkingText('');

    try {
      const model   = CHAT_MODELS[chatModel];
      const endpoint = buildEndpoint(location, projectId, model.id, 'generateContent');

      const contents = history
        .filter(m => m.id !== 'welcome')
        .map(m => ({
          role:  m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }));

      const genConfig = {
        temperature:     model.thinking ? 1.0 : 0.9,
        maxOutputTokens: 8192,
        topP:            0.95,
      };
      if (model.thinking) genConfig.thinkingConfig = { thinkingBudget: 10000 };

      const body = {
        contents,
        generationConfig: genConfig,
        systemInstruction: {
          parts: [{ text: 'Du bist ein hilfreicher KI-Assistent. Antworte präzise und klar. Bei Code: verwende Markdown-Codeblöcke.' }],
        },
      };

      const res  = await fetch(endpoint, { method: 'POST', headers: apiHeaders(apiKey), body: JSON.stringify(body) });
      const data = await res.json();

      if (!res.ok) throw new Error(parseApiError(res.status, data));

      // Extract thinking + answer parts
      const parts  = data.candidates?.[0]?.content?.parts || [];
      let thinking = '';
      let answer   = '';
      for (const p of parts) {
        if (p.thought) thinking += p.text;
        else           answer   += (p.text || '');
      }

      const usage = data.usageMetadata;
      setMessages(prev => [...prev, {
        id:       uid(),
        role:     'assistant',
        content:  answer || '(Keine Antwort)',
        thinking: thinking || null,
        ts:       Date.now(),
        usage,
        model:    model.label,
        modelColor: model.color,
      }]);
    } catch (err) {
      setMessages(prev => [...prev, {
        id:      uid(),
        role:    'error',
        content: err.message,
        ts:      Date.now(),
      }]);
    } finally {
      setChatLoading(false);
      setThinkingText('');
    }
  }, [chatInput, messages, chatLoading, apiKey, projectId, location, chatModel]);

  // ─── GENERATE IMAGE ────────────────────────────────────────────────────────
  const generateImage = async () => {
    if (!imgPrompt.trim() || imgLoading) return;
    if (!checkConfig()) return;

    setImgLoading(true);
    setImgError('');
    setImgResult(null);

    try {
      const model    = IMAGE_MODELS[imgModel];
      const endpoint = buildEndpoint(location, projectId, model.id, 'predict');

      const body = {
        instances: [{ prompt: imgPrompt.trim() }],
        parameters: {
          sampleCount:        1,
          aspectRatio,
          safetyFilterLevel:  'block_some',
          personGeneration:   'allow_adult',
        },
      };

      const res  = await fetch(endpoint, { method: 'POST', headers: apiHeaders(apiKey), body: JSON.stringify(body) });
      const data = await res.json();

      if (!res.ok) throw new Error(parseApiError(res.status, data));

      const b64      = data.predictions?.[0]?.bytesBase64Encoded;
      const mimeType = data.predictions?.[0]?.mimeType || 'image/png';

      if (!b64) throw new Error('Kein Bild in der Antwort erhalten.\n\nVermutlich enthielt der Prompt unsicheren Inhalt oder das Modell ist in dieser Region nicht verfügbar.');

      setImgResult({ uri: `data:${mimeType};base64,${b64}`, prompt: imgPrompt, model: model.label });
    } catch (err) {
      setImgError(err.message);
    } finally {
      setImgLoading(false);
    }
  };

  // ─── RENDER MESSAGE ────────────────────────────────────────────────────────
  const [expandedThinking, setExpandedThinking] = useState({});

  const renderMsg = useCallback(({ item }) => {
    const isUser   = item.role === 'user';
    const isError  = item.role === 'error';
    const isWelcome= item.id === 'welcome';

    return (
      <View style={[s.msgRow, isUser && s.msgRowUser]}>

        {/* Avatar left */}
        {!isUser && (
          <View style={[s.avatar, isError && { backgroundColor: C.red + '33', borderColor: C.red }]}>
            <Text style={s.avatarTxt}>{isError ? '⚠' : '✦'}</Text>
          </View>
        )}

        <View style={s.bubbleCol}>
          {/* Thinking block */}
          {item.thinking && (
            <TouchableOpacity
              style={s.thinkingBox}
              onPress={() => setExpandedThinking(p => ({ ...p, [item.id]: !p[item.id] }))}
              activeOpacity={0.7}
            >
              <Text style={s.thinkingHeader}>
                {expandedThinking[item.id] ? '▼' : '▶'} 🧠 Denkprozess
              </Text>
              {expandedThinking[item.id] && (
                <Text style={s.thinkingText}>{item.thinking}</Text>
              )}
            </TouchableOpacity>
          )}

          {/* Main bubble */}
          <View style={[
            s.bubble,
            isUser    ? s.bubbleUser  : s.bubbleAI,
            isError   ? s.bubbleError : null,
            isWelcome ? s.bubbleWelcome : null,
          ]}>
            {item.model && (
              <View style={s.modelTag}>
                <View style={[s.modelDot, { backgroundColor: item.modelColor }]} />
                <Text style={[s.modelTagTxt, { color: item.modelColor }]}>{item.model}</Text>
              </View>
            )}
            <Text style={[s.bubbleTxt, isUser && s.bubbleTxtUser, isError && s.bubbleTxtError]}>
              {item.content}
            </Text>
            <View style={s.bubbleMeta}>
              {item.usage && (
                <Text style={s.usageTxt}>
                  ↑{item.usage.promptTokenCount} ↓{item.usage.candidatesTokenCount} tok
                </Text>
              )}
              <Text style={s.tsTxt}>
                {new Date(item.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}
              </Text>
            </View>
          </View>
        </View>

        {/* Avatar right */}
        {isUser && (
          <View style={[s.avatar, s.avatarUser]}>
            <Text style={s.avatarTxt}>◉</Text>
          </View>
        )}
      </View>
    );
  }, [expandedThinking]);

  // ─── SCREENS ───────────────────────────────────────────────────────────────

  const ChatScreen = () => (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      {/* Model selector */}
      <View style={s.modelBar}>
        {Object.values(CHAT_MODELS).map(m => (
          <TouchableOpacity
            key={m.key}
            style={[s.modelChip, chatModel === m.key && { backgroundColor: m.color + '25', borderColor: m.color }]}
            onPress={() => setChatModel(m.key)}
          >
            <Text style={s.modelChipIcon}>{m.icon}</Text>
            <Text style={[s.modelChipTxt, chatModel === m.key && { color: m.color }]}>{m.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Messages */}
      <FlatList
        ref={flatRef}
        data={messages}
        renderItem={renderMsg}
        keyExtractor={i => i.id}
        contentContainerStyle={s.chatList}
        onContentSizeChange={() => flatRef.current?.scrollToEnd({ animated: true })}
        onLayout={() => flatRef.current?.scrollToEnd({ animated: false })}
      />

      {/* Typing indicator */}
      {chatLoading && (
        <View style={s.typingRow}>
          <Animated.View style={[s.typingDot, { transform: [{ scale: pulseAnim }] }]} />
          <Text style={s.typingTxt}>
            {CHAT_MODELS[chatModel].thinking ? '🧠 Denke tief nach...' : '✦ Generiere Antwort...'}
          </Text>
        </View>
      )}

      {/* Input */}
      <View style={s.inputArea}>
        <TextInput
          style={s.textInput}
          value={chatInput}
          onChangeText={setChatInput}
          placeholder="Schreib etwas..."
          placeholderTextColor={C.textDim}
          multiline
          maxLength={8000}
        />
        <TouchableOpacity
          style={[s.sendBtn, (!chatInput.trim() || chatLoading) && s.sendBtnOff]}
          onPress={sendChat}
          disabled={!chatInput.trim() || chatLoading}
        >
          <Text style={s.sendBtnTxt}>➤</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );

  const ImageScreen = () => {
    const imgH = aspectRatio === '9:16' ? W * 1.3
               : aspectRatio === '16:9' ? W * 0.56
               : W - 32;
    return (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={s.imgContent} keyboardShouldPersistTaps="handled">

        {/* Image model selector */}
        <Text style={s.secLabel}>Bildmodell</Text>
        <View style={s.imgModelRow}>
          {Object.values(IMAGE_MODELS).map(m => (
            <TouchableOpacity
              key={m.key}
              style={[s.imgModelCard, imgModel === m.key && { borderColor: m.color, backgroundColor: m.color + '18' }]}
              onPress={() => setImgModel(m.key)}
            >
              <Text style={[s.imgModelIcon, { color: m.color }]}>{m.icon}</Text>
              <Text style={[s.imgModelLabel, imgModel === m.key && { color: m.color }]}>{m.label}</Text>
              <Text style={s.imgModelDesc}>{m.desc}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Aspect ratio */}
        <Text style={s.secLabel}>Format</Text>
        <View style={s.ratioRow}>
          {['1:1','16:9','9:16','4:3','3:4'].map(r => (
            <TouchableOpacity
              key={r}
              style={[s.ratioChip, aspectRatio === r && { borderColor: C.teal, backgroundColor: C.tealGlow }]}
              onPress={() => setAspectRatio(r)}
            >
              <Text style={[s.ratioTxt, aspectRatio === r && { color: C.teal }]}>{r}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Prompt */}
        <Text style={s.secLabel}>Prompt</Text>
        <View style={s.promptBox}>
          <TextInput
            style={s.promptInput}
            value={imgPrompt}
            onChangeText={setImgPrompt}
            placeholder="Beschreibe dein Bild auf Englisch für beste Ergebnisse..."
            placeholderTextColor={C.textDim}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />
        </View>

        <TouchableOpacity
          style={[s.genBtn, (!imgPrompt.trim() || imgLoading) && s.genBtnOff]}
          onPress={generateImage}
          disabled={!imgPrompt.trim() || imgLoading}
        >
          {imgLoading
            ? <><ActivityIndicator size="small" color="#fff" /><Text style={s.genBtnTxt}>  Generiere...</Text></>
            : <Text style={s.genBtnTxt}>✦ Bild generieren</Text>
          }
        </TouchableOpacity>

        {imgLoading && (
          <View style={s.imgLoadBox}>
            <Animated.View style={[s.imgLoadPulse, { transform: [{ scale: pulseAnim }] }]} />
            <Text style={s.imgLoadTxt}>Imagen rendert dein Bild</Text>
            <Text style={s.imgLoadSub}>Das dauert 15–45 Sekunden · keine Panik 🎨</Text>
          </View>
        )}

        {imgError ? (
          <View style={s.errBox}>
            <Text style={s.errTitle}>Fehler</Text>
            <Text style={s.errTxt}>{imgError}</Text>
          </View>
        ) : null}

        {imgResult && (
          <View style={s.imgResultBox}>
            <Image source={{ uri: imgResult.uri }} style={[s.resultImg, { height: imgH }]} resizeMode="contain" />
            <View style={s.imgMeta}>
              <Text style={s.imgMetaModel}>{imgResult.model} · {aspectRatio}</Text>
              <Text style={s.imgMetaPrompt} numberOfLines={2}>{imgResult.prompt}</Text>
            </View>
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    );
  };

  const SettingsScreen = () => (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={s.settingsContent}>

      {/* Status */}
      <View style={[s.statusCard, { borderColor: isReady ? C.green : C.red }]}>
        <View style={[s.statusDot2, { backgroundColor: isReady ? C.green : C.red }]} />
        <View>
          <Text style={[s.statusLabel, { color: isReady ? C.green : C.red }]}>
            {isReady ? 'Verbunden' : 'Nicht konfiguriert'}
          </Text>
          <Text style={s.statusSub}>
            {isReady ? `${projectId}  ·  ${location}` : 'API Key + Project ID eintragen'}
          </Text>
        </View>
      </View>

      {/* API Key */}
      <View style={s.settingCard}>
        <Text style={s.settingLabel}>🔑  API Key</Text>
        <TextInput
          style={s.settingInput}
          value={apiKey}
          onChangeText={setApiKey}
          placeholder="AIza..."
          placeholderTextColor={C.textDim}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={s.settingHint}>Vertex AI API Key · Google Cloud Console → APIs & Services → Credentials</Text>
      </View>

      {/* Project ID */}
      <View style={s.settingCard}>
        <Text style={s.settingLabel}>🏗️  Project ID</Text>
        <TextInput
          style={s.settingInput}
          value={projectId}
          onChangeText={setProjectId}
          placeholder="mein-gcp-projekt-123456"
          placeholderTextColor={C.textDim}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={s.settingHint}>Google Cloud Console → oben in der Dropdown-Leiste</Text>
      </View>

      {/* Location */}
      <View style={s.settingCard}>
        <Text style={s.settingLabel}>🌍  Region / Location</Text>
        <View style={s.locRow}>
          {['us-central1', 'europe-west1', 'us-east4', 'asia-southeast1'].map(l => (
            <TouchableOpacity
              key={l}
              style={[s.locChip, location === l && { borderColor: C.teal, backgroundColor: C.tealGlow }]}
              onPress={() => setLocation(l)}
            >
              <Text style={[s.locTxt, location === l && { color: C.teal }]}>{l}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Model reference */}
      <View style={s.settingCard}>
        <Text style={s.settingLabel}>🤖  Modell-IDs (Referenz)</Text>
        {[...Object.values(CHAT_MODELS), ...Object.values(IMAGE_MODELS)].map(m => (
          <View key={m.id} style={s.modelRef}>
            <Text style={[s.modelRefName, { color: m.color }]}>{m.icon} {m.label}</Text>
            <Text style={s.modelRefId}>{m.id}</Text>
          </View>
        ))}
      </View>

      {/* Setup guide */}
      <View style={s.guideBox}>
        <Text style={s.guideTitle}>📋 Setup-Anleitung</Text>
        <Text style={s.guideTxt}>{SETUP_GUIDE}</Text>
      </View>

      {/* Quota info */}
      <View style={s.quotaBox}>
        <Text style={s.quotaTitle}>⚠️ Quota & Limits</Text>
        <Text style={s.quotaTxt}>{QUOTA_INFO}</Text>
      </View>

      {/* Actions */}
      <TouchableOpacity
        style={s.dangerBtn}
        onPress={() => Alert.alert('Chat leeren?', 'Alle Nachrichten werden gelöscht.', [
          { text: 'Abbrechen' },
          { text: 'Leeren', style: 'destructive', onPress: () => {
            setMessages([WELCOME_MSG()]);
            setActiveTab('chat');
          }},
        ])}
      >
        <Text style={s.dangerBtnTxt}>🗑️  Chat leeren</Text>
      </TouchableOpacity>

      <View style={{ height: 48 }} />
    </ScrollView>
  );

  // ─── LAYOUT ────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      {/* Header */}
      <View style={s.header}>
        <View style={s.headerLeft}>
          <Text style={s.headerLogo}>✦</Text>
          <View>
            <Text style={s.headerTitle}>Gemini Studio</Text>
            <Text style={s.headerSub}>Vertex AI · {location}</Text>
          </View>
        </View>
        <View style={[s.readyDot, { backgroundColor: isReady ? C.green : C.red }]} />
      </View>

      {/* Screen */}
      <View style={{ flex: 1 }}>
        {activeTab === 'chat'     && <ChatScreen />}
        {activeTab === 'images'   && <ImageScreen />}
        {activeTab === 'settings' && <SettingsScreen />}
      </View>

      {/* Tab bar */}
      <View style={s.tabBar}>
        {TABS.map(t => (
          <TouchableOpacity
            key={t.id}
            style={[s.tab, activeTab === t.id && s.tabActive]}
            onPress={() => setActiveTab(t.id)}
          >
            <Text style={[s.tabIcon, activeTab === t.id && { color: C.teal }]}>{t.icon}</Text>
            <Text style={[s.tabLabel, activeTab === t.id && { color: C.teal }]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </SafeAreaView>
  );
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────
let _id = 0;
function uid() { return `${Date.now()}-${++_id}`; }

function WELCOME_MSG() {
  return {
    id: 'welcome',
    role: 'assistant',
    content: 'Willkommen! Ich bin dein Gemini-Assistent über Vertex AI.\n\n• Chat → Wähle Flash Lite (schnell), Flash (Standard) oder Pro (Thinking)\n• Bilder → Erstelle Bilder mit Imagen 4 oder Imagen 3\n• Config → Trag deinen API Key und Project ID ein\n\nWie kann ich helfen? 🚀',
    ts: Date.now(),
    model: null,
  };
}

// ─── STATIC TEXT ─────────────────────────────────────────────────────────────
const SETUP_GUIDE = `1. Google Cloud Console öffnen (console.cloud.google.com)
2. Projekt auswählen / erstellen
3. Vertex AI API aktivieren:
   APIs & Services → Bibliothek → "Vertex AI" suchen → Aktivieren
4. API Key erstellen:
   APIs & Services → Anmeldedaten → + Anmeldedaten erstellen → API-Schlüssel
5. Key hier in Config eintragen
6. Project ID aus der oberen Leiste kopieren

💡 Für Imagen: "Cloud AI Companion API" ebenfalls aktivieren`;

const QUOTA_INFO = `429 Rate Limit → Warte 60s oder erhöhe Quota:
  Vertex AI → Quotas → Filter "gemini" oder "imagen"
  → Edit Quotas → Wert erhöhen (manchmal sofort, manchmal 24h)

403 Permission Denied → API Key einschränkungen prüfen:
  Anmeldedaten → Key bearbeiten → API-Einschränkungen entfernen

404 Modell nicht gefunden → Location prüfen.
  Nicht alle Modelle sind in jeder Region verfügbar.
  us-central1 hat den größten Modell-Support.`;

// ─── STYLES ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: C.surface,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  headerLeft:  { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerLogo:  { fontSize: 24, color: C.teal },
  headerTitle: { fontSize: 17, fontWeight: '700', color: C.text, letterSpacing: 0.3 },
  headerSub:   { fontSize: 11, color: C.textDim, marginTop: 1 },
  readyDot:    { width: 9, height: 9, borderRadius: 5 },

  // Model bar
  modelBar: {
    flexDirection: 'row', gap: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: C.surface,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  modelChip: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    paddingVertical: 7, borderRadius: 20,
    borderWidth: 1, borderColor: C.border,
  },
  modelChipIcon: { fontSize: 12 },
  modelChipTxt:  { fontSize: 10, color: C.textMid, fontWeight: '600' },

  // Chat
  chatList: { padding: 14, gap: 14 },

  msgRow:     { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginBottom: 4 },
  msgRowUser: { justifyContent: 'flex-end' },

  avatar: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: C.teal + '33',
    borderWidth: 1, borderColor: C.teal + '66',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarUser: { backgroundColor: C.surface3, borderColor: C.border },
  avatarTxt:  { fontSize: 12, color: C.teal },

  bubbleCol: { maxWidth: W * 0.74, gap: 4 },

  bubble: {
    borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10,
  },
  bubbleAI:      { backgroundColor: C.aiBubble, borderBottomLeftRadius: 4, borderWidth: 1, borderColor: C.border },
  bubbleUser:    { backgroundColor: C.userBubble, borderBottomRightRadius: 4 },
  bubbleError:   { backgroundColor: C.red + '15', borderWidth: 1, borderColor: C.red + '44' },
  bubbleWelcome: { backgroundColor: C.surface2, borderWidth: 1, borderColor: C.teal + '33' },

  modelTag: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 5 },
  modelDot: { width: 6, height: 6, borderRadius: 3 },
  modelTagTxt: { fontSize: 9, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase' },

  bubbleTxt:      { fontSize: 15, color: C.text, lineHeight: 22 },
  bubbleTxtUser:  { color: '#cce8f4' },
  bubbleTxtError: { color: C.red },

  bubbleMeta: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  usageTxt:   { fontSize: 9, color: C.textDim },
  tsTxt:      { fontSize: 9, color: C.textDim },

  thinkingBox: {
    backgroundColor: C.purple + '12',
    borderRadius: 12, borderWidth: 1, borderColor: C.purple + '44',
    padding: 10,
  },
  thinkingHeader: { fontSize: 11, color: C.purple, fontWeight: '700' },
  thinkingText:   { fontSize: 12, color: C.textMid, lineHeight: 18, marginTop: 6 },

  typingRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingVertical: 8,
    backgroundColor: C.surface,
    borderTopWidth: 1, borderTopColor: C.border,
  },
  typingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.teal },
  typingTxt: { fontSize: 12, color: C.textMid, fontStyle: 'italic' },

  inputArea: {
    flexDirection: 'row', alignItems: 'flex-end',
    padding: 12, gap: 10,
    backgroundColor: C.surface,
    borderTopWidth: 1, borderTopColor: C.border,
  },
  textInput: {
    flex: 1,
    backgroundColor: C.surface2,
    borderRadius: 22,
    paddingHorizontal: 16, paddingVertical: 11,
    color: C.text, fontSize: 15,
    maxHeight: 130,
    borderWidth: 1, borderColor: C.border,
  },
  sendBtn:    { width: 44, height: 44, borderRadius: 22, backgroundColor: C.teal, alignItems: 'center', justifyContent: 'center' },
  sendBtnOff: { backgroundColor: C.surface3 },
  sendBtnTxt: { color: '#fff', fontSize: 19 },

  // Image screen
  imgContent: { padding: 16, gap: 14 },
  secLabel:   { fontSize: 12, color: C.textMid, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: -6 },

  imgModelRow:  { flexDirection: 'row', gap: 12 },
  imgModelCard: { flex: 1, padding: 14, borderRadius: 14, borderWidth: 1.5, borderColor: C.border, backgroundColor: C.surface, alignItems: 'center', gap: 4 },
  imgModelIcon: { fontSize: 22 },
  imgModelLabel:{ fontSize: 13, fontWeight: '700', color: C.text },
  imgModelDesc: { fontSize: 10, color: C.textDim, textAlign: 'center' },

  ratioRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  ratioChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: C.border },
  ratioTxt:  { fontSize: 12, color: C.textMid },

  promptBox:   { backgroundColor: C.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: C.border, minHeight: 110 },
  promptInput: { color: C.text, fontSize: 15, lineHeight: 22 },

  genBtn:    { backgroundColor: C.purple, borderRadius: 14, padding: 15, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  genBtnOff: { backgroundColor: C.surface3 },
  genBtnTxt: { color: '#fff', fontSize: 16, fontWeight: '700' },

  imgLoadBox:   { alignItems: 'center', padding: 32, gap: 14 },
  imgLoadPulse: { width: 60, height: 60, borderRadius: 30, backgroundColor: C.teal + '33', borderWidth: 2, borderColor: C.teal },
  imgLoadTxt:   { fontSize: 16, color: C.text, fontWeight: '600' },
  imgLoadSub:   { fontSize: 12, color: C.textDim, textAlign: 'center' },

  errBox:   { backgroundColor: C.red + '15', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: C.red + '44' },
  errTitle: { fontSize: 13, color: C.red, fontWeight: '700', marginBottom: 6 },
  errTxt:   { fontSize: 13, color: '#fca5a5', lineHeight: 20 },

  imgResultBox: { borderRadius: 16, overflow: 'hidden', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  resultImg:    { width: '100%' },
  imgMeta:      { padding: 12, gap: 4 },
  imgMetaModel: { fontSize: 11, color: C.teal, fontWeight: '700' },
  imgMetaPrompt:{ fontSize: 12, color: C.textDim, fontStyle: 'italic' },

  // Settings
  settingsContent: { padding: 16, gap: 14 },

  statusCard:  { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, backgroundColor: C.surface, borderWidth: 1.5 },
  statusDot2:  { width: 10, height: 10, borderRadius: 5 },
  statusLabel: { fontSize: 14, fontWeight: '700' },
  statusSub:   { fontSize: 11, color: C.textDim, marginTop: 2 },

  settingCard:  { backgroundColor: C.surface, borderRadius: 14, padding: 14, gap: 10, borderWidth: 1, borderColor: C.border },
  settingLabel: { fontSize: 13, fontWeight: '700', color: C.text },
  settingInput: {
    backgroundColor: C.surface2, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 12,
    color: C.text, fontSize: 14,
    borderWidth: 1, borderColor: C.border,
  },
  settingHint: { fontSize: 11, color: C.textDim, lineHeight: 16 },

  locRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  locChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: C.border },
  locTxt:  { fontSize: 11, color: C.textMid },

  modelRef:     { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.border, gap: 2 },
  modelRefName: { fontSize: 12, fontWeight: '700' },
  modelRefId:   { fontSize: 10, color: C.textDim, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },

  guideBox:  { backgroundColor: C.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: C.teal + '44' },
  guideTitle:{ fontSize: 13, color: C.teal, fontWeight: '700', marginBottom: 10 },
  guideTxt:  { fontSize: 12, color: C.textMid, lineHeight: 20 },

  quotaBox:  { backgroundColor: C.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: C.amber + '44' },
  quotaTitle:{ fontSize: 13, color: C.amber, fontWeight: '700', marginBottom: 10 },
  quotaTxt:  { fontSize: 12, color: C.textMid, lineHeight: 20 },

  dangerBtn:    { backgroundColor: C.red + '15', borderRadius: 14, padding: 15, alignItems: 'center', borderWidth: 1, borderColor: C.red + '44' },
  dangerBtnTxt: { color: C.red, fontSize: 15, fontWeight: '600' },

  // Tab bar
  tabBar: {
    flexDirection: 'row',
    backgroundColor: C.surface,
    borderTopWidth: 1, borderTopColor: C.border,
    paddingBottom: Platform.OS === 'ios' ? 18 : 6,
  },
  tab:      { flex: 1, alignItems: 'center', paddingVertical: 10, gap: 3 },
  tabActive:{ borderTopWidth: 2, borderTopColor: C.teal },
  tabIcon:  { fontSize: 18, color: C.textDim },
  tabLabel: { fontSize: 10, color: C.textDim, fontWeight: '600' },
});
