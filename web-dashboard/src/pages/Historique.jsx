import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  collection,
  query,
  orderBy,
  limit,
  where,
  onSnapshot,
  getDocs,
} from 'firebase/firestore';
import { ref, get as rtdbGet } from 'firebase/database';
import { db, rtdb } from '../firebase';
import * as XLSX from 'xlsx';
import {
  Box,
  Card,
  Typography,
  Avatar,
  Chip,
  TextField,
  InputAdornment,
  Button,
  CircularProgress,
  LinearProgress,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Snackbar,
  Alert,
  alpha,
} from '@mui/material';
import {
  Search as SearchIcon,
  Download as DownloadIcon,
  ExpandMore as ExpandMoreIcon,
  AddCircleOutline as AddIcon,
  EditOutlined as EditIcon,
  DeleteOutline as DeleteIcon,
  History as HistoryIcon,
  TableChart as TableChartIcon,
  PersonOutline as PersonIcon,
  FingerprintOutlined as FingerprintIcon,
  TuneRounded as TuneIcon,
  InfoOutlined as InfoIcon,
} from '@mui/icons-material';

const kBlue = '#1565c0';
const kGreen = '#1d6a40';

// ==================== Helpers communs (mêmes conventions que les autres pages) ====================
const getLocalDateString = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const isLeafRecord = (obj) =>
  obj &&
  typeof obj === 'object' &&
  !Array.isArray(obj) &&
  (obj.matricule != null ||
    obj.alert_type != null ||
    obj.type != null ||
    obj.employee != null ||
    obj.timestamp != null ||
    obj.created_at != null ||
    (obj.date != null && (obj.time != null || obj.bus_id != null)));

const flattenRtdbRecords = (data) => {
  if (!data || typeof data !== 'object') return [];
  const results = [];
  const walk = (node, pathKeys = []) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (isLeafRecord(node)) {
      results.push({ id: pathKeys.join('/') || 'record', ...node });
      return;
    }
    Object.entries(node).forEach(([key, value]) => {
      if (value && typeof value === 'object') walk(value, [...pathKeys, key]);
    });
  };
  walk(data);
  if (results.length > 0) return results;
  return Object.entries(data).map(([key, value]) => ({
    id: key,
    ...(typeof value === 'object' && value !== null ? value : { value }),
  }));
};

const parseTimestamp = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const normalizePresence = (raw, forcedIdentification) => {
  const timestamp = raw.timestamp || raw.created_at;
  const parsed = parseTimestamp(timestamp);
  const date = raw.date || (parsed ? getLocalDateString(parsed) : getLocalDateString());
  const time = raw.time || (parsed ? parsed.toTimeString().slice(0, 8) : '');
  return {
    ...raw,
    matricule: raw.matricule || raw.employee || 'Unknown',
    bus_id: raw.bus_id || raw.current_bus_id || '',
    identification: forcedIdentification || raw.identification || 'face',
    date,
    time,
  };
};

const toMinutes = (heure) => {
  if (!heure) return 0;
  const parts = String(heure).split(':');
  if (parts.length < 2) return 0;
  const h = parseInt(parts[0], 10) || 0;
  const m = parseInt(parts[1], 10) || 0;
  return h * 60 + m;
};

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000.0;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Distance cumulée (minute du jour -> km depuis minuit), même méthode que FleetStats.jsx
async function cumulativeKmForBusDay(busId, dateKey) {
  try {
    const q = query(collection(db, 'buses', busId, 'gps_points', dateKey, 'points'), orderBy('ts'));
    const snap = await getDocs(q);
    const docs = snap.docs.map((d) => d.data());
    if (docs.length === 0) return [];

    const minutesOf = (d) => {
      const v = d.ts;
      const dt = typeof v?.toDate === 'function' ? v.toDate() : new Date(v);
      if (Number.isNaN(dt.getTime())) return null;
      return dt.getHours() * 60 + dt.getMinutes();
    };

    const result = [];
    let cumul = 0;
    const firstMin = minutesOf(docs[0]);
    if (firstMin != null) result.push([firstMin, 0]);

    for (let i = 1; i < docs.length; i++) {
      const a = docs[i - 1];
      const b = docs[i];
      const lat1 = Number(a.lat), lon1 = Number(a.lng);
      const lat2 = Number(b.lat), lon2 = Number(b.lng);
      if ([lat1, lon1, lat2, lon2].some((v) => Number.isNaN(v))) continue;
      const d = haversine(lat1, lon1, lat2, lon2);
      if (d < 500) cumul += d;
      const mIdx = minutesOf(b);
      if (mIdx != null) result.push([mIdx, cumul / 1000]);
    }
    return result;
  } catch {
    return [];
  }
}

function kmAtTime(cumulKm, heure) {
  if (!heure || cumulKm.length === 0) return 0;
  const target = toMinutes(heure);
  let best = cumulKm[0][1];
  let bestDiff = Infinity;
  for (const [min, km] of cumulKm) {
    const diff = Math.abs(min - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = km;
    }
  }
  return best;
}

// ==================== Constantes d'affichage (identiques à historique_screen.dart) ====================
const COLLECTIONS = ['Tous', 'salaries', 'buses', 'circuits', 'conducteurs', 'assignation', 'planning'];
const ACTIONS = ['Tous', 'ajout', 'modification', 'suppression'];
const ACTION_COLORS = { ajout: '#2e7d32', modification: kBlue, suppression: '#c62828' };
const ACTION_ICONS = { ajout: AddIcon, modification: EditIcon, suppression: DeleteIcon };
const COLLECTION_LABELS = {
  salaries: 'Salariés', buses: 'Bus', circuits: 'Circuits',
  conducteurs: 'Conducteurs', assignation: 'Assignation', planning: 'Planning',
};
const COLLECTION_COLORS = {
  salaries: kBlue, buses: '#2e7d32', circuits: '#00695c',
  conducteurs: '#e65100', assignation: '#6a1b9a', planning: '#4527a0',
};

const fmtDateFr = (d) => (d ? d.toLocaleDateString('fr-FR') : '—');
const fmtTimeFr = (d) => (d ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');

// ==================== Page principale ====================

export default function Historique() {
  return (
    <Box sx={{ p: 3, bgcolor: '#f5f7fb', minHeight: '100vh', display: 'grid', gap: 3 }}>
      <HistoriqueSection />
      <ExportExcelSection />
    </Box>
  );
}

// ==================== Section 1 : Historique des modifications ====================

function HistoriqueSection() {
  const [filtreCollection, setFiltreCollection] = useState('Tous');
  const [filtreAction, setFiltreAction] = useState('Tous');
  const [recherche, setRecherche] = useState('');
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' });

  const buildQueryConstraints = useCallback(() => {
    const constraints = [orderBy('timestamp', 'desc'), limit(300)];
    if (filtreCollection !== 'Tous') constraints.push(where('collection', '==', filtreCollection));
    if (filtreAction !== 'Tous') constraints.push(where('action', '==', filtreAction));
    return constraints;
  }, [filtreCollection, filtreAction]);

  useEffect(() => {
    if (!db) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const q = query(collection(db, 'historique'), ...buildQueryConstraints());
    const unsub = onSnapshot(
      q,
      (snap) => {
        setDocs(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
        setError('');
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      }
    );
    return () => unsub();
  }, [buildQueryConstraints]);

  const filteredDocs = useMemo(() => {
    if (!recherche.trim()) return docs;
    const q = recherche.toLowerCase();
    return docs.filter((d) => {
      const desc = (d.description || '').toLowerCase();
      const user = (d.utilisateur || '').toLowerCase();
      return desc.includes(q) || user.includes(q);
    });
  }, [docs, recherche]);

  const exporterHistoriqueExcel = async () => {
    setExporting(true);
    try {
      const q = query(collection(db, 'historique'), ...buildQueryConstraints());
      const snap = await getDocs(q);
      let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (recherche.trim()) {
        const s = recherche.toLowerCase();
        rows = rows.filter(
          (d) => (d.description || '').toLowerCase().includes(s) || (d.utilisateur || '').toLowerCase().includes(s)
        );
      }
      if (rows.length === 0) {
        setSnackbar({ open: true, message: 'Aucune entrée à exporter pour ces filtres.', severity: 'warning' });
        return;
      }

      const header = ['DATE', 'HEURE', 'COLLECTION', 'ACTION', 'UTILISATEUR', 'DESCRIPTION', 'DÉTAILS'];
      const aoa = [header];
      rows.forEach((d) => {
        const ts = d.timestamp?.toDate ? d.timestamp.toDate() : parseTimestamp(d.timestamp);
        const detailsTxt = d.details && Object.keys(d.details).length
          ? Object.entries(d.details).map(([k, v]) => `${k}: ${v}`).join(' ; ')
          : '';
        aoa.push([
          fmtDateFr(ts),
          fmtTimeFr(ts),
          COLLECTION_LABELS[d.collection] || d.collection || '',
          d.action ? d.action[0].toUpperCase() + d.action.slice(1) : '—',
          d.utilisateur || '',
          d.description || '',
          detailsTxt,
        ]);
      });

      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 45 }, { wch: 45 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Historique');

      const fileName = `historique_${getLocalDateString().replace(/-/g, '')}_${String(Date.now()).slice(-4)}.xlsx`;
      XLSX.writeFile(wb, fileName);
      setSnackbar({ open: true, message: `Fichier "${fileName}" généré (${rows.length} entrées)`, severity: 'success' });
    } catch (err) {
      setSnackbar({ open: true, message: `Erreur lors de l'export : ${err.message}`, severity: 'error' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card elevation={0} sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider', overflow: 'hidden' }}>
      {/* Topbar */}
      <Box sx={{ p: 3, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', borderBottom: '1px solid', borderColor: 'divider' }}>
        <Avatar sx={{ bgcolor: alpha(kBlue, 0.1), color: kBlue, width: 44, height: 44, borderRadius: 3 }}>
          <HistoryIcon />
        </Avatar>
        <Box sx={{ flex: 1, minWidth: 200 }}>
          <Typography sx={{ fontWeight: 700, fontSize: 17 }}>Historique des modifications</Typography>
          <Typography variant="caption" color="text.secondary">Journal complet de toutes les actions admin</Typography>
        </Box>
        <Button
          variant="outlined"
          size="small"
          startIcon={exporting ? <CircularProgress size={14} /> : <DownloadIcon sx={{ fontSize: 16 }} />}
          onClick={exporterHistoriqueExcel}
          disabled={exporting}
          sx={{ color: kGreen, borderColor: kGreen, textTransform: 'none', fontSize: 13 }}
        >
          {exporting ? 'Export en cours…' : "Exporter l'historique"}
        </Button>
      </Box>

      {/* Filtres */}
      <Box sx={{ p: 2.5, display: 'flex', gap: 2.5, flexWrap: 'wrap', alignItems: 'center', borderBottom: '1px solid', borderColor: 'divider', overflowX: 'auto' }}>
        <TextField
          size="small"
          placeholder="Rechercher…"
          value={recherche}
          onChange={(e) => setRecherche(e.target.value)}
          sx={{ width: 240 }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon sx={{ fontSize: 18 }} /></InputAdornment> }}
        />
        <FilterChipRow label="Collection" options={COLLECTIONS} selected={filtreCollection} labelOf={(c) => (c === 'Tous' ? 'Tous' : COLLECTION_LABELS[c] || c)} colorOf={(c) => COLLECTION_COLORS[c] || '#607d8b'} onSelect={setFiltreCollection} />
        <FilterChipRow label="Action" options={ACTIONS} selected={filtreAction} labelOf={(a) => (a === 'Tous' ? 'Tous' : a[0].toUpperCase() + a.slice(1))} colorOf={(a) => ACTION_COLORS[a] || '#607d8b'} onSelect={setFiltreAction} />
      </Box>

      {/* Liste */}
      <Box sx={{ p: 2.5, maxHeight: 520, overflowY: 'auto' }}>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}><CircularProgress /></Box>
        ) : filteredDocs.length === 0 ? (
          <Box sx={{ textAlign: 'center', p: 4 }}>
            <HistoryIcon sx={{ fontSize: 56, color: 'grey.300' }} />
            <Typography color="text.secondary" sx={{ mt: 1 }}>Aucune entrée dans l'historique</Typography>
            <Typography variant="caption" color="text.disabled">Les modifications apparaîtront ici automatiquement.</Typography>
          </Box>
        ) : (
          filteredDocs.map((d) => <HistoriqueItem key={d.id} data={d} />)
        )}
      </Box>

      <Snackbar open={snackbar.open} autoHideDuration={4000} onClose={() => setSnackbar((s) => ({ ...s, open: false }))} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={snackbar.severity} onClose={() => setSnackbar((s) => ({ ...s, open: false }))} sx={{ width: '100%' }}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Card>
  );
}

function FilterChipRow({ label, options, selected, labelOf, colorOf, onSelect }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'nowrap' }}>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, mr: 0.5 }}>{label} :</Typography>
      {options.map((opt) => {
        const isSel = opt === selected;
        const color = opt === 'Tous' ? '#607d8b' : colorOf(opt);
        return (
          <Chip
            key={opt}
            label={labelOf(opt)}
            size="small"
            onClick={() => onSelect(opt)}
            sx={{
              fontSize: 11,
              fontWeight: isSel ? 700 : 400,
              bgcolor: isSel ? alpha(color, 0.12) : 'grey.100',
              color: isSel ? color : 'text.secondary',
              border: '1px solid',
              borderColor: isSel ? color : 'grey.300',
            }}
          />
        );
      })}
    </Box>
  );
}

function HistoriqueItem({ data }) {
  const action = data.action || 'modification';
  const coll = data.collection || '';
  const description = data.description || '';
  const utilisateur = data.utilisateur || 'Système';
  const details = data.details;
  const ts = data.timestamp?.toDate ? data.timestamp.toDate() : parseTimestamp(data.timestamp);

  const actionColor = ACTION_COLORS[action] || '#607d8b';
  const ActionIcon = ACTION_ICONS[action] || HistoryIcon;
  const collLabel = COLLECTION_LABELS[coll] || coll;
  const collColor = COLLECTION_COLORS[coll] || '#607d8b';

  return (
    <Accordion
      elevation={0}
      disableGutters
      sx={{
        mb: 1,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: '12px !important',
        '&:before': { display: 'none' },
      }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, width: '100%' }}>
          <Avatar sx={{ bgcolor: alpha(actionColor, 0.1), color: actionColor, width: 36, height: 36, borderRadius: 2.5 }}>
            <ActionIcon sx={{ fontSize: 18 }} />
          </Avatar>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Box sx={{ display: 'flex', gap: 1, mb: 0.5 }}>
              <Chip label={collLabel} size="small" sx={{ height: 18, fontSize: 10, fontWeight: 700, bgcolor: alpha(collColor, 0.1), color: collColor }} />
              <Chip label={action[0].toUpperCase() + action.slice(1)} size="small" sx={{ height: 18, fontSize: 10, fontWeight: 700, bgcolor: alpha(actionColor, 0.08), color: actionColor }} />
            </Box>
            <Typography variant="body2" noWrap>{description}</Typography>
          </Box>
          <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
            <Typography sx={{ fontSize: 12, fontWeight: 700 }}>{fmtDateFr(ts)}</Typography>
            <Typography variant="caption" color="text.secondary">{fmtTimeFr(ts)}</Typography>
          </Box>
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ pl: 8.5, pt: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: details ? 1.25 : 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <PersonIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
            <Typography variant="caption" color="text.secondary">Par : {utilisateur}</Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <FingerprintIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
            <Typography variant="caption" color="text.disabled">ID : {data.id}</Typography>
          </Box>
        </Box>
        {details && Object.keys(details).length > 0 && (
          <Box sx={{ bgcolor: 'grey.50', border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 1.5 }}>
            <Typography sx={{ fontSize: 12, fontWeight: 700, mb: 0.5 }}>Détails :</Typography>
            {Object.entries(details).map(([k, v]) => (
              <Typography key={k} variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
                <Box component="span" sx={{ fontWeight: 600, color: '#455a64' }}>{k} : </Box>
                {String(v ?? '—')}
              </Typography>
            ))}
          </Box>
        )}
      </AccordionDetails>
    </Accordion>
  );
}

// ==================== Section 2 : Export Excel des trajets bus ====================

function ExportExcelSection() {
  const today = new Date();
  const weekAgo = new Date();
  weekAgo.setDate(today.getDate() - 7);

  const [dateStart, setDateStart] = useState(getLocalDateString(weekAgo));
  const [dateEnd, setDateEnd] = useState(getLocalDateString(today));
  const [buses, setBuses] = useState([]);
  const [selectedBusId, setSelectedBusId] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' });

  useEffect(() => {
    if (!db) return;
    const unsub = onSnapshot(query(collection(db, 'buses'), orderBy('immatriculation')), (snap) => {
      setBuses(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return () => unsub();
  }, []);

  const genererExcel = async () => {
    setLoading(true);
    setStatus('Chargement des données…');
    setProgress({ done: 0, total: 0 });
    try {
      // 1. Bus + circuits + planning
      const busSnap = await getDocs(collection(db, 'buses'));
      const busCache = {};
      busSnap.docs.forEach((d) => { busCache[d.id] = d.data(); });

      const circuitSnap = await getDocs(collection(db, 'circuits'));
      const circuitCache = {};
      circuitSnap.docs.forEach((d) => { circuitCache[d.id] = d.data(); });

      setStatus('Chargement du planning…');
      let planQuery = query(collection(db, 'planning'), orderBy('code'));
      if (selectedBusId) planQuery = query(collection(db, 'planning'), where('bus_id', '==', selectedBusId));
      const planSnap = await getDocs(planQuery);
      const trajets = planSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

      const trajetsParBus = {};
      trajets.forEach((t) => {
        const busId = t.bus_id || '';
        if (!busId) return;
        if (!trajetsParBus[busId]) trajetsParBus[busId] = [];
        trajetsParBus[busId].push({ id: t.id, minutes: toMinutes(t.h_depart || '') });
      });

      // 2. Présences (attendance + manual_checkins) — lues une seule fois, filtrées par date ensuite
      setStatus('Chargement des présences…');
      let presenceAll = [];
      if (rtdb) {
        const [attSnap, manSnap] = await Promise.all([
          rtdbGet(ref(rtdb, 'attendance')),
          rtdbGet(ref(rtdb, 'manual_checkins')),
        ]);
        const attRecords = attSnap.exists() ? flattenRtdbRecords(attSnap.val()).map((r) => normalizePresence(r)) : [];
        const manRecords = manSnap.exists() ? flattenRtdbRecords(manSnap.val()).map((r) => normalizePresence(r, 'manuel')) : [];
        presenceAll = [...attRecords, ...manRecords];
      }

      // 3. Dates de la plage
      const dates = [];
      const d0 = new Date(`${dateStart}T00:00:00`);
      const d1 = new Date(`${dateEnd}T00:00:00`);
      for (let d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) dates.push(new Date(d));

      setProgress({ done: 0, total: dates.length * trajets.length });
      setStatus('Génération des lignes…');

      const lignesParBus = {};
      const gpsCache = {};
      let count = 0;

      for (const date of dates) {
        const dateKey = getLocalDateString(date);

        // présences du jour, regroupées par trajet le plus proche (même bus)
        const nbParTrajet = {};
        presenceAll
          .filter((p) => p.date === dateKey && p.bus_id)
          .forEach((p) => {
            const candidats = trajetsParBus[p.bus_id];
            if (!candidats || candidats.length === 0) return;
            const presMin = toMinutes(p.time ? p.time.slice(0, 5) : '');
            let best = candidats[0];
            let bestDiff = Infinity;
            candidats.forEach((c) => {
              const diff = Math.abs(c.minutes - presMin);
              if (diff < bestDiff) { bestDiff = diff; best = c; }
            });
            const key = `${p.bus_id}_${best.id}`;
            nbParTrajet[key] = (nbParTrajet[key] || 0) + 1;
          });

        for (const t of trajets) {
          count++;
          if (count % 10 === 0) setProgress({ done: count, total: dates.length * trajets.length });

          const busId = t.bus_id || '';
          if (!busId || !busCache[busId]) continue;
          const imm = busCache[busId].immatriculation || busId;

          const gpsCacheKey = `${busId}_${dateKey}`;
          if (!(gpsCacheKey in gpsCache)) {
            gpsCache[gpsCacheKey] = await cumulativeKmForBusDay(busId, dateKey);
          }
          const cumulKm = gpsCache[gpsCacheKey];
          const hDep = t.h_depart || '';
          const hArr = t.h_arrivee || '';
          const kmDepart = cumulKm.length ? Math.round(kmAtTime(cumulKm, hDep)) : 0;
          const kmArrivee = cumulKm.length ? Math.round(kmAtTime(cumulKm, hArr)) : 0;

          const circuit = circuitCache[t.circuit_id] || {};
          const circuitDesig = circuit.designation || t.circuit_id || '';
          const circuitCode = circuit.code || t.circuit_id || '';
          const sens = t.sens || 'aller';
          const digits = circuitCode.replace(/[^0-9]/g, '');
          const codeRegDep = `${digits}${sens === 'aller' ? 'D' : 'R'}`;
          const codeRegArr = `${digits}${sens === 'aller' ? 'R' : 'D'}`;

          const nbDepart = nbParTrajet[`${busId}_${t.id}`] || 0;

          const ligne = {
            date, immBus: imm, heureDepart: hDep,
            codeRegionDepart: codeRegDep, itineraireDepart: circuitDesig,
            kmDepart, nbrePersonnesDepart: nbDepart,
            heureArrivee: hArr, codeRegionArrivee: codeRegArr, itineraireArrivee: circuitDesig,
            kmArrivee, nbrePersonnesRevenues: 0,
            kmJour: Math.abs(kmArrivee - kmDepart),
          };
          if (!lignesParBus[busId]) lignesParBus[busId] = [];
          lignesParBus[busId].push(ligne);
        }
      }

      setStatus('Création du fichier Excel…');

      const sortedBusIds = Object.keys(lignesParBus).sort((a, b) => {
        const ia = busCache[a]?.immatriculation || a;
        const ib = busCache[b]?.immatriculation || b;
        return ia.localeCompare(ib);
      });

      const allLignes = Object.values(lignesParBus).flat().sort((a, b) => {
        const dc = a.date - b.date;
        if (dc !== 0) return dc;
        return toMinutes(a.heureDepart) - toMinutes(b.heureDepart);
      });

      if (allLignes.length === 0) {
        setSnackbar({ open: true, message: 'Aucun trajet trouvé pour cette période / ce bus.', severity: 'warning' });
        setLoading(false);
        return;
      }

      const header = [
        'DATE', 'IMM BUS', 'HEURE DEPART', 'CODE REGION', 'ITINÉRAIRE DE DÉPART',
        'KM DEPART', 'NBRE DE PERSONNES EN DÉPART', "HEURE D'ARRIVEE", 'CODE REGION',
        "ITINÉRAIRE D'ARRIVÉE", 'KM ARRIVEE', 'NBRE DE PERSONNES REVENUES', 'KM / JOUR',
      ];
      const aoa = [header];
      allLignes.forEach((l) => {
        aoa.push([
          fmtDateFr(l.date), l.immBus, l.heureDepart, l.codeRegionDepart, l.itineraireDepart,
          l.kmDepart, l.nbrePersonnesDepart, l.heureArrivee, l.codeRegionArrivee,
          l.itineraireArrivee, l.kmArrivee, l.nbrePersonnesRevenues, l.kmJour,
        ]);
      });
      const totalKm = allLignes.reduce((acc, l) => acc + l.kmJour, 0);
      const totalRow = new Array(header.length).fill('');
      totalRow[0] = 'TOTAL';
      totalRow[12] = totalKm;
      aoa.push(totalRow);

      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = header.map((_, i) => ({ wch: i === 4 || i === 9 ? 24 : 14 }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Feuil1');

      // Feuille récapitulative
      const recapHeader = ['Bus', 'Nb trajets', 'KM total', 'KM moyen/trajet'];
      const recapAoa = [recapHeader];
      sortedBusIds.forEach((busId) => {
        const lignes = lignesParBus[busId];
        const imm = busCache[busId]?.immatriculation || busId;
        const total = lignes.reduce((acc, l) => acc + l.kmJour, 0);
        const avg = lignes.length ? Number((total / lignes.length).toFixed(1)) : 0;
        recapAoa.push([imm, lignes.length, total, avg]);
      });
      const wsRecap = XLSX.utils.aoa_to_sheet(recapAoa);
      wsRecap['!cols'] = [{ wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 16 }];
      XLSX.utils.book_append_sheet(wb, wsRecap, 'Récapitulatif');

      const fileName = `rapport_trajets_${dateStart.replace(/-/g, '')}_${dateEnd.replace(/-/g, '')}.xlsx`;
      XLSX.writeFile(wb, fileName);

      setStatus('✅ Export terminé !');
      setSnackbar({ open: true, message: `Fichier "${fileName}" généré avec succès (${allLignes.length} trajets)`, severity: 'success' });
    } catch (err) {
      setStatus(`Erreur : ${err.message}`);
      setSnackbar({ open: true, message: `Erreur lors de l'export : ${err.message}`, severity: 'error' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card elevation={0} sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider', p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
        <Avatar sx={{ bgcolor: alpha(kGreen, 0.1), color: kGreen, width: 44, height: 44, borderRadius: 3 }}>
          <TableChartIcon />
        </Avatar>
        <Box>
          <Typography sx={{ fontWeight: 700, fontSize: 17 }}>Export Excel — Rapports de trajets</Typography>
          <Typography variant="caption" color="text.secondary">Génère un tableau de bord par bus et par jour</Typography>
        </Box>
      </Box>

      {/* Paramètres */}
      <SectionCard title="Paramètres d'export" icon={<TuneIcon sx={{ fontSize: 18 }} />}>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField
            label="Date début"
            type="date"
            size="small"
            value={dateStart}
            onChange={(e) => setDateStart(e.target.value)}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            label="Date fin"
            type="date"
            size="small"
            value={dateEnd}
            onChange={(e) => setDateEnd(e.target.value)}
            InputLabelProps={{ shrink: true }}
          />
          <FormControl size="small" sx={{ minWidth: 220 }}>
            <InputLabel id="export-bus-label">Bus</InputLabel>
            <Select labelId="export-bus-label" label="Bus" value={selectedBusId} onChange={(e) => setSelectedBusId(e.target.value)}>
              <MenuItem value="">Tous les bus</MenuItem>
              {buses.map((b) => (
                <MenuItem key={b.id} value={b.id}>{b.immatriculation || b.id}</MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>
      </SectionCard>

      <Box sx={{ mt: 2.5 }}>
        <SectionCard title="Format du fichier exporté" icon={<TableChartIcon sx={{ fontSize: 18 }} />}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Le fichier Excel contiendra un tableau unique (tous les bus mélangés, triés par date et heure) avec les colonnes suivantes :
          </Typography>
          <Typography variant="caption" sx={{ display: 'block', fontFamily: 'monospace', color: 'text.secondary', mb: 1.5 }}>
            DATE · IMM BUS · H.DÉPART · CODE REG. · ITINÉRAIRE DÉP. · KM DÉP. · PERS. DÉP. · H.ARR. · CODE REG. · ITINÉRAIRE ARR. · KM ARR. · PERS. RET. · KM/JOUR
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, p: 1.5, bgcolor: '#fff8e1', border: '1px solid', borderColor: '#ffe082', borderRadius: 2 }}>
            <InfoIcon sx={{ fontSize: 16, color: '#f57f17', flexShrink: 0, mt: 0.2 }} />
            <Typography variant="caption" sx={{ color: '#8d6e00' }}>
              Les KM DÉPART/ARRIVÉE sont la distance GPS cumulée depuis minuit (Haversine), pas le compteur kilométrique réel.
              Le "Code région" et l'itinéraire viennent du planning/circuits. Le nombre de personnes au départ est déduit
              automatiquement des présences (attendance + pointages manuels). Le nombre au retour reste à 0 tant qu'aucun
              pointage retour n'est enregistré.
            </Typography>
          </Box>
        </SectionCard>
      </Box>

      {loading && (
        <Box sx={{ mt: 2.5 }}>
          <SectionCard title="Génération en cours…" icon={<CircularProgress size={16} thickness={5} />}>
            <LinearProgress
              variant={progress.total > 0 ? 'determinate' : 'indeterminate'}
              value={progress.total > 0 ? (progress.done / progress.total) * 100 : undefined}
              sx={{ height: 8, borderRadius: 4, bgcolor: 'grey.200', '& .MuiLinearProgress-bar': { bgcolor: kGreen } }}
            />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>{status}</Typography>
            {progress.total > 0 && (
              <Typography variant="caption" color="text.disabled">{progress.done} / {progress.total} trajets traités</Typography>
            )}
          </SectionCard>
        </Box>
      )}

      <Button
        fullWidth
        variant="contained"
        size="large"
        onClick={genererExcel}
        disabled={loading}
        startIcon={loading ? <CircularProgress size={18} sx={{ color: 'white' }} /> : <DownloadIcon />}
        sx={{ mt: 2.5, py: 1.5, bgcolor: kGreen, textTransform: 'none', fontSize: 15, fontWeight: 600, '&:hover': { bgcolor: '#155a35' } }}
      >
        {loading ? 'Génération en cours…' : 'Générer et télécharger le fichier Excel'}
      </Button>

      <Snackbar open={snackbar.open} autoHideDuration={4000} onClose={() => setSnackbar((s) => ({ ...s, open: false }))} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={snackbar.severity} onClose={() => setSnackbar((s) => ({ ...s, open: false }))} sx={{ width: '100%' }}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Card>
  );
}

function SectionCard({ title, icon, children }) {
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 2.5, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Avatar sx={{ width: 30, height: 30, bgcolor: alpha(kBlue, 0.08), color: kBlue, borderRadius: 2 }}>{icon}</Avatar>
        <Typography sx={{ fontWeight: 700, fontSize: 14 }}>{title}</Typography>
      </Box>
      <Box sx={{ p: 2.5 }}>{children}</Box>
    </Box>
  );
}
