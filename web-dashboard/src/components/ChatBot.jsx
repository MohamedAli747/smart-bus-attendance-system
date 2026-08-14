import { useState, useRef, useEffect, useCallback } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { ref, get } from 'firebase/database';
import { db, rtdb } from '../firebase';
import {
  Box,
  Fab,
  Paper,
  Typography,
  IconButton,
  TextField,
  CircularProgress,
  Avatar,
} from '@mui/material';
import { MessageCircle, X, Send, Bot, User as UserIcon } from 'lucide-react';

// ============================================================
// Clé API Gemini (gratuite) — à obtenir sur https://aistudio.google.com/apikey
// Définie dans un fichier .env à la racine du projet :
//   VITE_GEMINI_API_KEY=ta_cle_ici
// ============================================================
const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-3.1-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// ============================================================
// Base de connaissance statique : description des fonctionnalités du site
// (sert de contexte "comment faire X" pour l'assistant)
// ============================================================
const SITE_KNOWLEDGE = `
Tu es l'assistant intégré du tableau de bord admin WICMIC Transport (gestion de présence et transport du personnel par bus, avec reconnaissance faciale sur Raspberry Pi).

PAGES ET FONCTIONNALITÉS DU SITE :
- Tableau de bord : vue "Statistiques" (KPI Personnel, Flotte & Planification, graphiques Personnes par bus/trajet) et vue "Présences" (embarquements et alertes en temps réel), avec sélecteur de période (Aujourd'hui / Cette semaine / Ce mois-ci).
- Enrôler un visage : capture des échantillons de visage via webcam (ou upload d'une photo) pour un employé, afin que le système de reconnaissance faciale du Raspberry Pi puisse l'identifier dans le bus.
- Employés : liste des salariés (CRUD), avec matricule, nom, prénom, CIN, circuit, coordonnées, poste, statut actif.
- Visages enregistrés : liste des enrôlements faciaux (matricule, modèle d'embedding, dimension, date de mise à jour).
- Bus : liste des bus (CRUD), avec immatriculation, modèle, marque, type, site, statut, circuit assigné, conducteur assigné.
- Circuits : liste des circuits/trajets (CRUD).
- Conducteurs : liste des conducteurs (CRUD), avec rôle, département, identifiant, type, roulement, statut actif, accès privilégié.
- Assignation : permet d'assigner ou retirer un conducteur à un bus, et un circuit à un bus (lien bidirectionnel : un bus ne peut avoir qu'un seul conducteur/circuit à la fois, et vice versa).
- Historique & Export : historique de toutes les actions (ajout/modification/suppression) effectuées dans le système, avec export Excel/CSV des feuilles de route par bus.
- Planning : gestion des trajets planifiés (heure d'arrivée/départ, sens, conducteur, bus, circuit).
- Carte des bus : carte en temps réel (OpenStreetMap) montrant la position GPS de chaque bus actif, avec filtre par bus.
- Flotte & Stats : distance parcourue par bus (jour/semaine/mois), avec liste des salariés présents aujourd'hui par bus.

Réponds toujours en français, de façon claire et concise. Si on te pose une question sur "comment faire" quelque chose, explique les étapes en te basant sur les pages ci-dessus. Si on te pose une question sur les données actuelles (présences, alertes, bus, affectations...), utilise le contexte de données fourni ci-dessous s'il est présent. Si tu ne sais pas, dis-le honnêtement plutôt que d'inventer.
`.trim();

// ============================================================
// Récupération d'un instantané compact des données (mini-RAG)
// ============================================================
async function fetchDataSnapshot() {
  const snapshot = { generated_at: new Date().toISOString() };

  try {
    if (db) {
      const [salariesSnap, busesSnap, conducteursSnap, circuitsSnap] = await Promise.all([
        getDocs(collection(db, 'salaries')),
        getDocs(collection(db, 'buses')),
        getDocs(collection(db, 'conducteurs')),
        getDocs(collection(db, 'circuits')),
      ]);

      const buses = busesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const conducteurs = conducteursSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

      snapshot.employes_total = salariesSnap.size;
      snapshot.employes_actifs = salariesSnap.docs.filter((d) => d.data().active !== false).length;

      snapshot.bus_total = buses.length;
      snapshot.bus_avec_conducteur = buses.filter((b) => b.conducteur_id).length;
      snapshot.bus_sans_conducteur = buses.filter((b) => !b.conducteur_id).length;
      snapshot.bus_avec_circuit = buses.filter((b) => b.circuit_id).length;
      snapshot.liste_bus = buses.slice(0, 30).map((b) => ({
        immatriculation: b.immatriculation || b.id,
        statut: b.status,
        conducteur_id: b.conducteur_id || null,
        circuit_id: b.circuit_id || null,
      }));

      snapshot.conducteurs_total = conducteurs.length;
      snapshot.conducteurs_actifs = conducteurs.filter((c) => c.actif !== false).length;
      snapshot.conducteurs_sans_bus = conducteurs.filter((c) => !c.bus_id).length;

      snapshot.circuits_total = circuitsSnap.size;
    }
  } catch (e) {
    snapshot.firestore_error = e.message;
  }

  try {
    if (rtdb) {
      const todayStr = new Date().toISOString().slice(0, 10);
      const [attSnap, alertsSnap] = await Promise.all([
        get(ref(rtdb, 'attendance')),
        get(ref(rtdb, 'alerts')),
      ]);

      const flatten = (val) => {
        if (!val) return [];
        const out = [];
        const walk = (node) => {
          if (!node || typeof node !== 'object') return;
          if (node.matricule != null || node.employee != null) {
            out.push(node);
            return;
          }
          Object.values(node).forEach((v) => {
            if (v && typeof v === 'object') walk(v);
          });
        };
        walk(val);
        return out;
      };

      const attendance = flatten(attSnap.val()).filter((r) => (r.date || '').startsWith(todayStr));
      const alerts = flatten(alertsSnap.val()).filter((r) => (r.date || '').startsWith(todayStr));

      snapshot.presences_aujourdhui = attendance.length;
      snapshot.alertes_aujourdhui = alerts.length;
    }
  } catch (e) {
    snapshot.rtdb_error = e.message;
  }

  return snapshot;
}

// ============================================================
// Appel à l'API Gemini (gratuite)
// ============================================================
async function callGemini(history, userMessage, dataSnapshot) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      "Aucune clé API Gemini configurée. Ajoute VITE_GEMINI_API_KEY dans un fichier .env à la racine du projet (clé gratuite sur https://aistudio.google.com/apikey)."
    );
  }

  const contextBlock = `Voici un instantané des données actuelles du système (JSON) :\n${JSON.stringify(dataSnapshot, null, 2)}`;

  const contents = [
    ...history.map((m) => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.text }],
    })),
    { role: 'user', parts: [{ text: userMessage }] },
  ];

  const body = {
    system_instruction: {
      parts: [{ text: `${SITE_KNOWLEDGE}\n\n${contextBlock}` }],
    },
    contents,
    generationConfig: { temperature: 0.4, maxOutputTokens: 800 },
  };

  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Erreur Gemini (${res.status}) : ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) throw new Error("Réponse vide de l'assistant. Réessaie ta question.");
  return text;
}

// ============================================================
// Composant principal
// ============================================================
export default function ChatBot() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      text: "Bonjour 👋 Je suis l'assistant du site. Je peux t'expliquer comment utiliser une fonctionnalité (ex : « comment assigner un conducteur à un bus ? ») ou te donner des infos sur les données actuelles (ex : « combien de présences aujourd'hui ? »).",
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    setInput('');
    setError('');
    const newHistory = [...messages, { role: 'user', text }];
    setMessages(newHistory);
    setLoading(true);

    try {
      const snapshot = await fetchDataSnapshot();
      const reply = await callGemini(messages, text, snapshot);
      setMessages((prev) => [...prev, { role: 'assistant', text: reply }]);
    } catch (err) {
      setError(err.message);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: `⚠️ ${err.message}` },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <>
      <Fab
        color="primary"
        onClick={() => setOpen((v) => !v)}
        sx={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          zIndex: 1300,
          bgcolor: '#8e24aa',
          '&:hover': { bgcolor: '#6a1b9a' },
        }}
      >
        {open ? <X size={22} /> : <MessageCircle size={22} />}
      </Fab>

      {open && (
        <Paper
          elevation={8}
          sx={{
            position: 'fixed',
            bottom: 96,
            right: 24,
            width: { xs: 'calc(100vw - 32px)', sm: 380 },
            height: 520,
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 3,
            overflow: 'hidden',
            zIndex: 1300,
          }}
        >
          {/* Header */}
          <Box
            sx={{
              px: 2,
              py: 1.5,
              bgcolor: '#8e24aa',
              color: 'white',
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
            }}
          >
            <Avatar sx={{ bgcolor: 'rgba(255,255,255,0.2)', width: 32, height: 32 }}>
              <Bot size={18} />
            </Avatar>
            <Box sx={{ flex: 1 }}>
              <Typography sx={{ fontWeight: 700, fontSize: 14 }}>Assistant WICMIC</Typography>
            </Box>
            <IconButton size="small" onClick={() => setOpen(false)} sx={{ color: 'white' }}>
              <X size={18} />
            </IconButton>
          </Box>

          {/* Messages */}
          <Box sx={{ flex: 1, overflowY: 'auto', p: 2, bgcolor: '#f7f7fb', display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            {messages.map((m, i) => (
              <Box
                key={i}
                sx={{
                  display: 'flex',
                  gap: 1,
                  alignItems: 'flex-start',
                  flexDirection: m.role === 'user' ? 'row-reverse' : 'row',
                }}
              >
                <Avatar
                  sx={{
                    width: 26,
                    height: 26,
                    bgcolor: m.role === 'user' ? '#1565c0' : '#8e24aa',
                  }}
                >
                  {m.role === 'user' ? <UserIcon size={14} /> : <Bot size={14} />}
                </Avatar>
                <Box
                  sx={{
                    maxWidth: '78%',
                    bgcolor: m.role === 'user' ? '#1565c0' : 'white',
                    color: m.role === 'user' ? 'white' : 'text.primary',
                    px: 1.5,
                    py: 1,
                    borderRadius: 2.5,
                    border: m.role === 'user' ? 'none' : '1px solid rgba(0,0,0,0.08)',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  <Typography sx={{ fontSize: 13.5, lineHeight: 1.5 }}>{m.text}</Typography>
                </Box>
              </Box>
            ))}
            {loading && (
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                <Avatar sx={{ width: 26, height: 26, bgcolor: '#8e24aa' }}>
                  <Bot size={14} />
                </Avatar>
                <CircularProgress size={16} />
                <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>Réflexion en cours...</Typography>
              </Box>
            )}
            <div ref={bottomRef} />
          </Box>

          {/* Input */}
          <Box sx={{ p: 1.5, borderTop: '1px solid', borderColor: 'divider', display: 'flex', gap: 1, bgcolor: 'white' }}>
            <TextField
              fullWidth
              size="small"
              placeholder="Pose ta question..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={loading}
              multiline
              maxRows={3}
            />
            <IconButton color="primary" onClick={sendMessage} disabled={loading || !input.trim()}>
              <Send size={20} />
            </IconButton>
          </Box>
        </Paper>
      )}
    </>
  );
}