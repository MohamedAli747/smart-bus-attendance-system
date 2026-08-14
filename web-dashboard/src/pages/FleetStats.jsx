import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  getDocs,
  doc,
  getDoc,
  setDoc,
  where,
} from 'firebase/firestore';
import { ref, onValue } from 'firebase/database';
import { db, rtdb } from '../firebase';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Avatar,
  Chip,
  CircularProgress,
  LinearProgress,
  IconButton,
  alpha,
} from '@mui/material';
import {
  DirectionsBusRounded as BusIcon,
  ArrowBack as ArrowBackIcon,
  Route as RouteIcon,
  Today as TodayIcon,
  TrendingUp as TrendingUpIcon,
  FiberManualRecord as DotIcon,
  PeopleAlt as PeopleIcon,
  Warning as WarningIcon,
  CheckCircle as CheckCircleIcon,
  AccessTime as AccessTimeIcon,
} from '@mui/icons-material';

const kBlue = '#1565c0';

// ==================== RTDB helpers (copie locale de la logique déjà utilisée et validée dans Dashboard.jsx) ====================
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

// 'attendance' (identification automatique) et 'manual_checkins' (saisie manuelle) partagent la même forme
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
    created_at: raw.created_at || raw.timestamp || new Date().toISOString(),
  };
};

const normalizeAlert = (raw) => {
  const timestamp = raw.timestamp || raw.created_at;
  const parsed = parseTimestamp(timestamp);
  const date = raw.date || (parsed ? getLocalDateString(parsed) : getLocalDateString());
  return {
    ...raw,
    alert_type: raw.alert_type || raw.type || 'alert',
    matricule: raw.matricule || raw.employee || raw.name || 'Unknown',
    bus_id: raw.bus_id || raw.current_bus_id || '',
    date,
    created_at: raw.created_at || raw.timestamp || new Date().toISOString(),
  };
};

// ==================== Haversine (identique à Flutter) ====================
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

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function daysInRange(start, end) {
  const keys = [];
  const d = new Date(start);
  while (d <= end) {
    keys.push(fmt(d));
    d.setDate(d.getDate() + 1);
  }
  return keys;
}

function getDateKeys(periode) {
  const now = new Date();
  if (periode === "Aujourd'hui") return [fmt(now)];
  if (periode === 'Semaine') {
    const day = now.getDay();
    const isoWeekday = day === 0 ? 7 : day;
    const monday = new Date(now);
    monday.setDate(now.getDate() - (isoWeekday - 1));
    return daysInRange(monday, now);
  }
  if (periode === 'Mois') {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    return daysInRange(first, now);
  }
  return [fmt(now)];
}

// Le km parcouru par bus/jour est mis en cache de façon persistante dans
// buses/{busId}/km_daily/{dateKey} (champ km + dernier point connu). À chaque
// appel, on ne relit que les nouveaux points GPS (ts > lastTs) et on ajoute
// leur distance au total déjà enregistré : le km reste donc acquis même si
// l'app est fermée/déconnectée, et les nouveaux trajets s'additionnent au lieu
// d'être recalculés (et potentiellement perdus/réinitialisés) à chaque fois.
async function calcDayDistance(busId, dateKey) {
  const dailyRef = doc(db, 'buses', busId, 'km_daily', dateKey);
  let saved = { km: 0, lastTs: null, lastLat: null, lastLng: null };

  try {
    const snap = await getDoc(dailyRef);
    if (snap.exists()) saved = { ...saved, ...snap.data() };
  } catch (err) {
    console.warn(`km_daily lecture échouée pour ${busId}/${dateKey}:`, err.message);
  }

  try {
    const constraints = [orderBy('ts')];
    if (saved.lastTs) constraints.unshift(where('ts', '>', saved.lastTs));
    const q = query(collection(db, 'buses', busId, 'gps_points', dateKey, 'points'), ...constraints);
    const snap = await getDocs(q);
    const newPoints = snap.docs.map((d) => d.data());

    if (newPoints.length === 0) return saved.km || 0;

    let dist = saved.km || 0;
    let prev = saved.lastLat != null && saved.lastLng != null ? { lat: saved.lastLat, lng: saved.lastLng } : null;
    for (const p of newPoints) {
      if (prev) {
        const d = haversine(Number(prev.lat), Number(prev.lng), Number(p.lat), Number(p.lng));
        if (d < 500) dist += d / 1000;
      }
      prev = { lat: p.lat, lng: p.lng };
    }

    const lastPoint = newPoints[newPoints.length - 1];
    setDoc(
      dailyRef,
      {
        km: dist,
        lastTs: lastPoint.ts,
        lastLat: lastPoint.lat,
        lastLng: lastPoint.lng,
        updated_at: new Date().toISOString(),
      },
      { merge: true }
    ).catch((err) => console.warn(`km_daily écriture échouée pour ${busId}/${dateKey}:`, err.message));

    return dist;
  } catch (err) {
    console.warn(`Calcul km échoué pour ${busId}/${dateKey}, valeur enregistrée conservée:`, err.message);
    return saved.km || 0;
  }
}

async function calcTotal(busId, dateKeys) {
  let total = 0;
  for (const dateKey of dateKeys) {
    total += await calcDayDistance(busId, dateKey);
  }
  return total;
}

const dayLabel = (dateKey) => {
  try {
    const d = new Date(`${dateKey}T00:00:00`);
    const label = d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' });
    return label.charAt(0).toUpperCase() + label.slice(1);
  } catch {
    return dateKey;
  }
};

// ==================== Main Component ====================

export default function FleetStats() {
  const [periode, setPeriode] = useState('Semaine');
  const [buses, setBuses] = useState([]);
  const [loadingBuses, setLoadingBuses] = useState(true);
  const [selectedBusId, setSelectedBusId] = useState(null);

  const [busTotals, setBusTotals] = useState({}); // busId -> km (for grid)
  const [loadingTotals, setLoadingTotals] = useState(false);

  const [perDay, setPerDay] = useState(null); // [{date, label, km}] for detail view
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [presencesByBus, setPresencesByBus] = useState({}); // busId -> [presence,...] (mirrors etat_bus_screen.dart)
  const [salariesMap, setSalariesMap] = useState({}); // salarieId -> {nom, prenom, matricule}

  const dateKeys = useMemo(() => getDateKeys(periode), [periode]);

  // ── Bus list, realtime ──
  useEffect(() => {
    if (!db) {
      setLoadingBuses(false);
      return;
    }
    const unsub = onSnapshot(
      query(collection(db, 'buses'), orderBy('immatriculation')),
      (snap) => {
        setBuses(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoadingBuses(false);
      },
      () => setLoadingBuses(false)
    );
    return () => unsub();
  }, []);

  // ── Totaux km par bus pour la grille (recalculé à chaque changement de période ou de liste de bus) ──
  useEffect(() => {
    if (!db || buses.length === 0) {
      setBusTotals({});
      return;
    }
    let cancelled = false;
    setLoadingTotals(true);
    (async () => {
      const entries = await Promise.all(
        buses.map(async (b) => [b.id, await calcTotal(b.id, dateKeys)])
      );
      if (!cancelled) {
        setBusTotals(Object.fromEntries(entries));
        setLoadingTotals(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buses, dateKeys]);

  // ── Détail jour par jour pour le bus sélectionné ──
  useEffect(() => {
    if (!db || !selectedBusId) {
      setPerDay(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    (async () => {
      const result = [];
      for (const dateKey of dateKeys) {
        const km = await calcDayDistance(selectedBusId, dateKey);
        result.push({ date: dateKey, label: dayLabel(dateKey), km });
      }
      if (!cancelled) {
        setPerDay(result);
        setLoadingDetail(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedBusId, dateKeys]);

  // ── Présences du jour depuis la RTDB, groupées par bus (mirrors etat_bus_screen.dart) ──
  useEffect(() => {
    if (!rtdb) {
      console.warn('[FleetStats] rtdb is null — Realtime Database not initialized');
      return;
    }
    const todayStr = getLocalDateString(new Date());

    // Un même salarié peut apparaître dans 'attendance' (auto) ET 'manual_checkins' (manuel) :
    // on fusionne les deux sources par bus, puis on enrichit avec les alertes (température, etc.)
    let attendanceRecords = [];
    let manualRecords = [];
    let alertRecords = [];

    const rebuild = () => {
      const merged = [...attendanceRecords, ...manualRecords]
        .filter((r) => r.date === todayStr);

      const grouped = {};
      merged.forEach((rec) => {
        const busId = rec.bus_id || '';
        // enrichir avec une alerte correspondante du jour (même matricule) si elle contient une température
        const matchingAlert = alertRecords.find(
          (al) => al.date === todayStr && al.matricule === rec.matricule && al.temperature != null
        );
        const enriched = {
          ...rec,
          temperature: rec.temperature ?? matchingAlert?.temperature ?? null,
        };
        if (!grouped[busId]) grouped[busId] = [];
        grouped[busId].push(enriched);
      });
      setPresencesByBus(grouped);
    };

    const attRef = ref(rtdb, 'attendance');
    const unsubAtt = onValue(
      attRef,
      (snapshot) => {
        attendanceRecords = snapshot.exists()
          ? flattenRtdbRecords(snapshot.val()).map((r) => normalizePresence(r))
          : [];
        rebuild();
      },
      (err) => console.error('[FleetStats] attendance onValue error:', err)
    );

    const manualRef = ref(rtdb, 'manual_checkins');
    const unsubManual = onValue(
      manualRef,
      (snapshot) => {
        manualRecords = snapshot.exists()
          ? flattenRtdbRecords(snapshot.val()).map((r) => normalizePresence(r, 'manuel'))
          : [];
        rebuild();
      },
      (err) => console.error('[FleetStats] manual_checkins onValue error:', err)
    );

    const alertsRef = ref(rtdb, 'alerts');
    const unsubAlerts = onValue(
      alertsRef,
      (snapshot) => {
        alertRecords = snapshot.exists() ? flattenRtdbRecords(snapshot.val()).map(normalizeAlert) : [];
        rebuild();
      },
      (err) => console.error('[FleetStats] alerts onValue error:', err)
    );

    return () => {
      unsubAtt();
      unsubManual();
      unsubAlerts();
    };
  }, []);

  // ── Salariés (Firestore) pour afficher nom/matricule fiables, priorité sur les données RTDB ──
  useEffect(() => {
    if (!db) return;
    const unsub = onSnapshot(collection(db, 'salaries'), (snap) => {
      const map = {};
      snap.docs.forEach((d) => {
        map[d.id] = d.data();
      });
      setSalariesMap(map);
    });
    return () => unsub();
  }, []);

  // matricule -> {nom, prenom, ...} — les enregistrements RTDB identifient les salariés par matricule
  const salariesByMatricule = useMemo(() => {
    const map = {};
    Object.values(salariesMap).forEach((s) => {
      if (s.matricule) map[s.matricule] = s;
    });
    return map;
  }, [salariesMap]);


  const selectBus = useCallback((id) => setSelectedBusId(id), []);
  const goBack = useCallback(() => setSelectedBusId(null), []);
  const changePeriode = (p) => {
    setPeriode(p);
    setSelectedBusId(null);
  };

  const selectedBus = buses.find((b) => b.id === selectedBusId);

  return (
    <Box sx={{ bgcolor: '#f5f7fb', minHeight: '100vh' }}>
      {/* ── Header ── */}
      <Box sx={{ bgcolor: 'white', px: 3, py: 2.5, borderBottom: '1px solid', borderColor: 'divider', display: 'flex', alignItems: 'center', gap: 2 }}>
        <Box sx={{ flex: 1 }}>
          <Typography sx={{ fontWeight: 700, fontSize: 18 }}>État &amp; Statistiques flotte</Typography>
          <Typography variant="caption" color="text.secondary">
            Statut GPS et distance parcourue par bus
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 0.75 }}>
          {["Aujourd'hui", 'Semaine', 'Mois'].map((p) => {
            const sel = periode === p;
            return (
              <Box
                key={p}
                onClick={() => changePeriode(p)}
                sx={{
                  px: 1.75,
                  py: 0.75,
                  borderRadius: 5,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  color: sel ? 'white' : 'text.secondary',
                  bgcolor: sel ? kBlue : 'white',
                  border: '1px solid',
                  borderColor: sel ? kBlue : 'divider',
                  transition: 'all 0.15s',
                }}
              >
                {p}
              </Box>
            );
          })}
        </Box>
      </Box>

      <Box sx={{ p: 3 }}>
        {loadingBuses ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 8 }}>
            <CircularProgress />
          </Box>
        ) : buses.length === 0 ? (
          <Typography color="text.secondary" sx={{ textAlign: 'center', p: 4 }}>
            Aucun bus
          </Typography>
        ) : selectedBusId == null ? (
          <FleetGrid
            buses={buses}
            busTotals={busTotals}
            loadingTotals={loadingTotals}
            periode={periode}
            presencesByBus={presencesByBus}
            onSelectBus={selectBus}
          />
        ) : (
          <BusDetail
            busId={selectedBusId}
            busData={selectedBus || {}}
            periode={periode}
            perDay={perDay}
            loading={loadingDetail}
            presences={presencesByBus[selectedBusId] || []}
            salariesByMatricule={salariesByMatricule}
            onBack={goBack}
          />
        )}
      </Box>
    </Box>
  );
}

// ==================== Grille de tous les bus ====================

function FleetGrid({ buses, busTotals, loadingTotals, periode, presencesByBus, onSelectBus }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: '1fr',
          sm: 'repeat(2, 1fr)',
          md: 'repeat(3, 1fr)',
          lg: 'repeat(4, 1fr)',
        },
        gap: 2,
      }}
    >
      {buses.map((bus) => (
        <BusDistanceCard
          key={bus.id}
          bus={bus}
          km={busTotals[bus.id]}
          loading={loadingTotals && busTotals[bus.id] === undefined}
          periode={periode}
          nbPresents={(presencesByBus[bus.id] || []).length}
          onClick={() => onSelectBus(bus.id)}
        />
      ))}
    </Box>
  );
}

function BusDistanceCard({ bus, km, loading, periode, nbPresents, onClick }) {
  const gps = bus.last_gps || {};
  const hasGps = !!gps && !!gps.lat && !!gps.lng;
  const speed = gps.speed_kmh || 0;

  return (
    <Card
      elevation={0}
      onClick={onClick}
      sx={{
        p: 2,
        borderRadius: 3.5,
        border: '1px solid',
        borderColor: 'divider',
        cursor: 'pointer',
        transition: 'box-shadow 0.15s',
        '&:hover': { boxShadow: 2 },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
        <Box sx={{ position: 'relative' }}>
          <Avatar sx={{ width: 36, height: 36, borderRadius: 2.5, bgcolor: hasGps ? alpha('#2e7d32', 0.1) : 'grey.100' }}>
            <BusIcon sx={{ fontSize: 20, color: hasGps ? '#2e7d32' : 'grey.500' }} />
          </Avatar>
          {nbPresents > 0 && (
            <Box
              sx={{
                position: 'absolute',
                top: -4,
                right: -4,
                width: 17,
                height: 17,
                borderRadius: '50%',
                bgcolor: kBlue,
                border: '1.5px solid white',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Typography sx={{ fontSize: 9, fontWeight: 700, color: 'white', lineHeight: 1 }}>{nbPresents}</Typography>
            </Box>
          )}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 700, fontSize: 13 }} noWrap>{bus.immatriculation || bus.id}</Typography>
          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
            {`${bus.marque || ''} ${bus.modele || ''}`.trim()}
          </Typography>
        </Box>
        {hasGps && (
          <Chip
            size="small"
            icon={<DotIcon sx={{ fontSize: '8px !important', color: '#2e7d32 !important' }} />}
            label={`${speed.toFixed ? speed.toFixed(0) : speed} km/h`}
            sx={{ bgcolor: alpha('#2e7d32', 0.08), color: '#2e7d32', fontWeight: 700, fontSize: 10, height: 22 }}
          />
        )}
      </Box>

      <Box sx={{ mt: 2 }}>
        {loading ? (
          <LinearProgress sx={{ mt: 1, borderRadius: 1 }} />
        ) : (
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5 }}>
            <Typography sx={{ fontSize: 26, fontWeight: 700, color: kBlue, lineHeight: 1 }}>
              {(km ?? 0).toFixed(1)}
            </Typography>
            <Typography sx={{ fontSize: 13, color: kBlue }}>km</Typography>
            <Box sx={{ flex: 1 }} />
            <Typography variant="caption" color="text.disabled">{periode}</Typography>
          </Box>
        )}
        {bus.circuit_id && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.75 }}>
            <RouteIcon sx={{ fontSize: 12, color: '#00897b' }} />
            <Typography variant="caption" sx={{ color: '#00897b' }}>Circuit assigné</Typography>
          </Box>
        )}
      </Box>
    </Card>
  );
}

// ==================== Détail d'un bus ====================

function BusDetail({ busId, busData, periode, perDay, loading, presences, salariesByMatricule, onBack }) {
  const days = perDay || [];
  const total = days.reduce((acc, d) => acc + d.km, 0);
  const daysWithKm = days.filter((d) => d.km > 0);
  const maxKm = days.length ? Math.max(1, ...days.map((d) => d.km)) : 1;
  const avg = daysWithKm.length ? total / daysWithKm.length : 0;
  const maxDay = days.length ? Math.max(...days.map((d) => d.km)) : 0;
  const todayKey = fmt(new Date());

  return (
    <Box sx={{ maxWidth: 900, mx: 'auto' }}>
      {/* Back + header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 3 }}>
        <IconButton
          onClick={onBack}
          size="small"
          sx={{ bgcolor: 'white', boxShadow: 1, borderRadius: 2, '&:hover': { bgcolor: 'grey.100' } }}
        >
          <ArrowBackIcon sx={{ fontSize: 18, color: kBlue }} />
        </IconButton>
        <Box>
          <Typography sx={{ fontWeight: 700, fontSize: 18 }}>{busData.immatriculation || busId}</Typography>
          <Typography variant="caption" color="text.secondary">
            {`${busData.marque || ''} · Détail ${periode}`.trim()}
          </Typography>
        </Box>
      </Box>

      {/* 3 cartes résumé */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1.5, mb: 3 }}>
        <SummaryCard label={`Total ${periode}`} value={`${total.toFixed(1)} km`} icon={<RouteIcon />} color={kBlue} loading={loading} />
        <SummaryCard label="Moy. par jour" value={daysWithKm.length ? `${avg.toFixed(1)} km` : '—'} icon={<TodayIcon />} color="#00897b" loading={loading} />
        <SummaryCard label="Max jour" value={days.length ? `${maxDay.toFixed(1)} km` : '—'} icon={<TrendingUpIcon />} color="#f57c00" loading={loading} />
      </Box>

      {/* Graphe barres */}
      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 5 }}>
          <CircularProgress />
        </Box>
      ) : days.length > 0 ? (
        <Card elevation={0} sx={{ borderRadius: 3.5, border: '1px solid', borderColor: 'divider', p: 2.5, mb: 3 }}>
          <Typography sx={{ fontWeight: 700, fontSize: 14, mb: 2.5 }}>Distance par jour</Typography>
          <Box sx={{ height: 160, display: 'flex', alignItems: 'flex-end', gap: 1 }}>
            {days.map((day) => {
              const isToday = day.date === todayKey;
              const barH = day.km === 0 ? 4 : Math.min(120, Math.max(4, (day.km / maxKm) * 120));
              return (
                <Box key={day.date} sx={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  {day.km > 0 && (
                    <Typography sx={{ fontSize: 10, color: isToday ? kBlue : 'text.secondary', fontWeight: isToday ? 700 : 400, mb: 0.4 }}>
                      {day.km.toFixed(0)}
                    </Typography>
                  )}
                  <Box
                    sx={{
                      width: '100%',
                      height: barH,
                      borderRadius: '5px 5px 0 0',
                      bgcolor: isToday ? kBlue : day.km === 0 ? 'grey.200' : alpha(kBlue, 0.25),
                    }}
                  />
                  <Typography
                    sx={{
                      fontSize: 10,
                      mt: 0.75,
                      textAlign: 'center',
                      color: isToday ? kBlue : 'text.secondary',
                      fontWeight: isToday ? 700 : 400,
                    }}
                  >
                    {day.label}
                  </Typography>
                </Box>
              );
            })}
          </Box>
        </Card>
      ) : null}

      {/* Détail par jour */}
      {days.length > 0 && (
        <Card elevation={0} sx={{ borderRadius: 3.5, border: '1px solid', borderColor: 'divider' }}>
          <Typography sx={{ fontWeight: 700, fontSize: 14, p: 2 }}>Détail par jour</Typography>
          <Box sx={{ borderTop: '1px solid', borderColor: 'divider' }}>
            {days.map((day) => {
              const isToday = day.date === todayKey;
              return (
                <Box
                  key={day.date}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    px: 2,
                    py: 1.25,
                    borderBottom: '1px solid',
                    borderColor: 'divider',
                    '&:last-child': { borderBottom: 'none' },
                  }}
                >
                  <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: day.km > 0 ? kBlue : 'grey.300', mr: 1.25 }} />
                  <Typography sx={{ fontSize: 13, fontWeight: isToday ? 700 : 400, color: isToday ? kBlue : 'text.primary' }}>
                    {day.label}
                  </Typography>
                  {isToday && (
                    <Chip label="Aujourd'hui" size="small" sx={{ ml: 1, height: 18, fontSize: 9, bgcolor: alpha(kBlue, 0.08), color: kBlue, fontWeight: 700 }} />
                  )}
                  <Box sx={{ flex: 1 }} />
                  <Typography sx={{ fontSize: 13, fontWeight: 700, color: day.km > 0 ? kBlue : 'text.disabled' }}>
                    {day.km > 0 ? `${day.km.toFixed(2)} km` : '—'}
                  </Typography>
                </Box>
              );
            })}
          </Box>
        </Card>
      )}

      {/* Salariés présents aujourd'hui (mirrors etat_bus_screen.dart) */}
      <PresentEmployeesCard presences={presences} salariesByMatricule={salariesByMatricule} />
    </Box>
  );
}

function PresentEmployeesCard({ presences, salariesByMatricule }) {
  const list = presences || [];
  const count = list.length;

  return (
    <Card elevation={0} sx={{ borderRadius: 3.5, border: '1px solid', borderColor: 'divider', mt: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 2 }}>
        <PeopleIcon sx={{ fontSize: 18, color: kBlue }} />
        <Typography sx={{ fontWeight: 700, fontSize: 14, flex: 1 }}>Salariés présents aujourd'hui</Typography>
        <Chip
          label={count}
          size="small"
          sx={{ bgcolor: count > 0 ? alpha(kBlue, 0.08) : 'grey.100', color: count > 0 ? kBlue : 'text.disabled', fontWeight: 700, height: 22 }}
        />
      </Box>
      <Box sx={{ borderTop: '1px solid', borderColor: 'divider' }}>
        {list.length === 0 ? (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, p: 3 }}>
            <PeopleIcon sx={{ fontSize: 18, color: 'text.disabled' }} />
            <Typography variant="body2" color="text.secondary">Aucun salarié présent</Typography>
          </Box>
        ) : (
          list.map((att, i) => {
            const sal = salariesByMatricule[att.matricule] || {};
            const nom = `${sal.prenom || ''} ${sal.nom || ''}`.trim() || att.employee || att.matricule;
            const matricule = att.matricule || sal.matricule || '';
            const temp = att.temperature != null ? Number(att.temperature) : null;
            const fievre = temp != null && temp > 37.5;
            const isManuel = att.identification === 'manuel';
            let heure = att.time ? att.time.slice(0, 5) : '--';
            if (heure === '--' && att.created_at) {
              try {
                heure = new Date(att.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
              } catch {
                heure = '--';
              }
            }
            return (
              <Box
                key={`${att.matricule || i}-${att.id || i}`}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.25,
                  px: 2,
                  py: 1.25,
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                  '&:last-child': { borderBottom: 'none' },
                }}
              >
                <Avatar sx={{ width: 30, height: 30, bgcolor: fievre ? alpha('#d32f2f', 0.08) : alpha('#2e7d32', 0.08) }}>
                  {fievre ? (
                    <WarningIcon sx={{ fontSize: 15, color: '#d32f2f' }} />
                  ) : (
                    <CheckCircleIcon sx={{ fontSize: 15, color: '#2e7d32' }} />
                  )}
                </Avatar>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontSize: 13 }} noWrap>{nom}</Typography>
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                    {`Mat. ${matricule}`} · {isManuel ? '✋ Manuel' : (att.identification || 'face')}
                  </Typography>
                </Box>
                {temp != null && temp > 0 && (
                  <Chip
                    label={`${temp.toFixed(1)}°C`}
                    size="small"
                    sx={{
                      bgcolor: fievre ? alpha('#d32f2f', 0.08) : alpha('#2e7d32', 0.08),
                      color: fievre ? '#d32f2f' : '#2e7d32',
                      fontWeight: 700,
                      fontSize: 11,
                      height: 22,
                    }}
                  />
                )}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.4 }}>
                  <AccessTimeIcon sx={{ fontSize: 13, color: 'text.disabled' }} />
                  <Typography sx={{ fontSize: 12, fontWeight: 700 }}>{heure}</Typography>
                </Box>
              </Box>
            );
          })
        )}
      </Box>
    </Card>
  );
}

function SummaryCard({ label, value, icon, color, loading }) {
  return (
    <Card elevation={0} sx={{ p: 2, borderRadius: 3, border: '1px solid', borderColor: 'divider' }}>
      {React.cloneElement(icon, { sx: { fontSize: 20, color } })}
      <Box sx={{ mt: 1 }}>
        {loading ? (
          <LinearProgress sx={{ borderRadius: 1, mt: 1, mb: 1 }} />
        ) : (
          <Typography sx={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1 }}>{value}</Typography>
        )}
      </Box>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
    </Card>
  );
}
