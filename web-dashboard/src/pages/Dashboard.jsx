import { useState, useEffect, useMemo } from 'react'
import { ref, onValue } from 'firebase/database'
import { collection, onSnapshot } from 'firebase/firestore'
import { rtdb, db } from '../firebase'
import Grid from '@mui/material/Grid'
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Typography from '@mui/material/Typography'
import Avatar from '@mui/material/Avatar'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemText from '@mui/material/ListItemText'
import Chip from '@mui/material/Chip'
import Alert from '@mui/material/Alert'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import LinearProgress from '@mui/material/LinearProgress'
import Divider from '@mui/material/Divider'
import { alpha } from '@mui/material/styles'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import ToggleButton from '@mui/material/ToggleButton'
import ReactApexChart from 'react-apexcharts'
import { Users, ShieldAlert, Clock, BarChart3, Activity, Bus, Route, UserCog } from 'lucide-react'
import styles from './Dashboard.module.css'

// ============================================================
// Helpers (inchangés depuis Dashboard.jsx)
// ============================================================

const getLocalDateString = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const parseTimestamp = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
      if (value && typeof value === 'object') {
        walk(value, [...pathKeys, key]);
      }
    });
  };

  walk(data);

  if (results.length > 0) return results;

  return Object.entries(data).map(([key, value]) => ({
    id: key,
    ...(typeof value === 'object' && value !== null ? value : { value }),
  }));
};

const normalizeAlert = (raw) => {
  const timestamp = raw.timestamp || raw.created_at;
  const parsed = parseTimestamp(timestamp);
  const date =
    raw.date || (parsed ? getLocalDateString(parsed) : getLocalDateString());
  const time =
    raw.time || (parsed ? parsed.toTimeString().slice(0, 8) : '');

  return {
    ...raw,
    alert_type: raw.alert_type || raw.type || 'alert',
    matricule: raw.matricule || raw.employee || raw.name || 'Unknown',
    bus_id: raw.bus_id || raw.current_bus_id || '—',
    code_trajet: raw.code_trajet || raw.route || raw.current_trajet || '—',
    date,
    time,
    created_at: raw.created_at || raw.timestamp || new Date().toISOString(),
  };
};

const normalizeAttendance = (raw) => {
  const timestamp = raw.timestamp || raw.created_at;
  const parsed = parseTimestamp(timestamp);
  const date =
    raw.date || (parsed ? getLocalDateString(parsed) : getLocalDateString());
  const time =
    raw.time || (parsed ? parsed.toTimeString().slice(0, 8) : '');

  return {
    ...raw,
    matricule: raw.matricule || raw.employee || 'Unknown',
    bus_id: raw.bus_id || raw.current_bus_id || '—',
    code_trajet: raw.code_trajet || raw.route || raw.current_trajet || '—',
    statut: raw.statut || raw.status || raw.state || 'Unknown',
    date,
    time,
    created_at: raw.created_at || raw.timestamp || new Date().toISOString(),
  };
};

const sortByNewest = (a, b) =>
  new Date(b.created_at || b.timestamp || 0) -
  new Date(a.created_at || a.timestamp || 0);

const getRecordDateObj = (record) => {
  if (!record) return null;
  if (record.date && typeof record.date === 'string') {
    const parts = record.date.split('-');
    if (parts.length === 3) return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }
  const parsed = parseTimestamp(record.created_at || record.timestamp);
  return parsed;
};

const startOfWeek = (d) => {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = date.getDay();
  const diff = date.getDate() - (day === 0 ? 6 : day - 1); // Monday as first day
  return new Date(date.getFullYear(), date.getMonth(), diff);
};

const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);

const isInPeriod = (record, period, now = new Date()) => {
  const recDate = getRecordDateObj(record);
  if (!recDate) return false;
  if (period === 'today') {
    return getLocalDateString(recDate) === getLocalDateString(now);
  }
  if (period === 'week') {
    const s = startOfWeek(now);
    return recDate >= s && recDate <= now;
  }
  if (period === 'month') {
    const s = startOfMonth(now);
    return recDate >= s && recDate <= now;
  }
  return false;
};

// ============================================================
// Config Analytics (venant de Analytics.jsx)
// ============================================================

const collectionDefinitions = [
  { key: 'salaries', label: 'Employees', color: 'primary' },
  { key: 'users', label: 'Users', color: 'secondary' },
  { key: 'buses', label: 'Buses', color: 'success' },
  { key: 'circuits', label: 'Circuits', color: 'info' },
  { key: 'conducteurs', label: 'Conducteurs', color: 'warning' },
  { key: 'planning', label: 'Planning', color: 'error' },
]

// ============================================================
// Composant principal
// ============================================================

export default function Dashboard() {
  // ---- Etat "vue affichée" : analytics est la vue par défaut ----
  const [view, setView] = useState('analytics'); // 'analytics' | 'attendance'

  // ---- Etat Attendance / Alerts (RTDB) ----
  const [attendance, setAttendance] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [stats, setStats] = useState({ total: 0, alertsCount: 0 });
  const [rtdbError, setRtdbError] = useState('');
  const [period, setPeriod] = useState('today'); // 'today' | 'week' | 'month'

  // ---- Etat Analytics (Firestore) ----
  const [counts, setCounts] = useState({});
  const [countsLoading, setCountsLoading] = useState(true);

  // ---- Documents complets (pour les KPI "affecté / total" de la nouvelle vue Analytics) ----
  const [busesFull, setBusesFull] = useState([]);
  const [conducteursFull, setConducteursFull] = useState([]);
  const [circuitsFull, setCircuitsFull] = useState([]);
  const [salariesFull, setSalariesFull] = useState([]);

  // Compteurs Firestore par collection (ex Analytics.jsx)
  useEffect(() => {
    const unsubscribes = collectionDefinitions.map((item) => {
      const collectionRef = collection(db, item.key)
      return onSnapshot(
        collectionRef,
        (snapshot) => {
          setCounts((prev) => ({ ...prev, [item.key]: snapshot.size }))
          setCountsLoading(false)
        },
        () => {
          setCounts((prev) => ({ ...prev, [item.key]: 0 }))
          setCountsLoading(false)
        }
      )
    })

    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, [])

  // Documents complets buses/conducteurs/circuits, pour calculer les KPI d'affectation
  // (additif : n'affecte pas les compteurs 'counts' existants ni la vue Attendance)
  useEffect(() => {
    const unsubBuses = onSnapshot(collection(db, 'buses'), (snap) => {
      setBusesFull(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    const unsubConducteurs = onSnapshot(collection(db, 'conducteurs'), (snap) => {
      setConducteursFull(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    const unsubCircuits = onSnapshot(collection(db, 'circuits'), (snap) => {
      setCircuitsFull(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    const unsubSalaries = onSnapshot(collection(db, 'salaries'), (snap) => {
      setSalariesFull(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return () => {
      unsubBuses();
      unsubConducteurs();
      unsubCircuits();
      unsubSalaries();
    };
  }, [])

  // Attendance + Alerts RTDB (inchangé depuis Dashboard.jsx)
  useEffect(() => {
    if (!rtdb) {
      setRtdbError(
        'Realtime Database is not connected. Check Firebase config and console.',
      );
      return;
    }

    const attRef = ref(rtdb, 'attendance')
    const unsubAtt = onValue(
      attRef,
      (snapshot) => {
        setRtdbError('');
        if (!snapshot.exists()) {
          setAttendance([]);
          setStats((prev) => ({ ...prev, total: 0 }));
          return;
        }

        let arr = flattenRtdbRecords(snapshot.val()).map(normalizeAttendance);
        arr.sort(sortByNewest);
        setAttendance(arr);
      },
      (error) => {
        console.error('Attendance RTDB error:', error);
        setRtdbError(error.message);
      },
    );

    const alertsRef = ref(rtdb, 'alerts')
    const unsubAlerts = onValue(
      alertsRef,
      (snapshot) => {
        setRtdbError('');
        if (!snapshot.exists()) {
          setAlerts([]);
          setStats((prev) => ({ ...prev, alertsCount: 0 }));
          return;
        }

        let arr = flattenRtdbRecords(snapshot.val()).map(normalizeAlert);
        arr.sort(sortByNewest);
        setAlerts(arr);
      },
      (error) => {
        console.error('Alerts RTDB error:', error);
        setRtdbError(error.message);
      },
    );

    return () => {
      unsubAtt();
      unsubAlerts();
    };
  }, []);

  // Recalcule les stats quand les données ou la période changent
  useEffect(() => {
    const now = new Date();
    const total = attendance.filter((a) => isInPeriod(a, period, now)).length;
    const alertsCount = alerts.filter((a) => isInPeriod(a, period, now)).length;
    setStats((prev) => ({ ...prev, total, alertsCount }));
  }, [attendance, alerts, period]);

  const now = new Date();
  const filteredAttendance = attendance.filter((a) => isInPeriod(a, period, now));
  const filteredAlerts = alerts.filter((a) => isInPeriod(a, period, now));
  const periodLabel = period === 'today' ? 'Today' : period === 'week' ? 'This Week' : 'This Month';

  // Graphiques "Persons per Bus / Route" : on réutilise directement l'attendance
  // déjà chargée par ce composant (au lieu d'ouvrir un 2e abonnement RTDB comme
  // le faisait Analytics.jsx). Respecte aussi le sélecteur de période.
  const { busCounts, routeCounts } = useMemo(() => {
    const buses = {};
    const routes = {};
    filteredAttendance.forEach((r) => {
      buses[r.bus_id] = (buses[r.bus_id] || 0) + 1;
      routes[r.code_trajet] = (routes[r.code_trajet] || 0) + 1;
    });
    const busArr = Object.entries(buses)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
    const routeArr = Object.entries(routes)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
    return { busCounts: busArr, routeCounts: routeArr };
  }, [filteredAttendance]);

  const totalItems = useMemo(
    () => collectionDefinitions.reduce((sum, item) => sum + (counts[item.key] || 0), 0),
    [counts]
  );
  const maxCount = useMemo(
    () => Math.max(1, ...collectionDefinitions.map((item) => counts[item.key] || 0)),
    [counts]
  );

  const collectionSeries = collectionDefinitions.map((item) => counts[item.key] || 0);
  const collectionLabels = collectionDefinitions.map((item) => item.label);
  const donutOptions = {
    labels: collectionLabels,
    legend: { position: 'bottom' },
    chart: { toolbar: { show: false } },
    responsive: [{ breakpoint: 480, options: { legend: { position: 'bottom' } } }],
  };

  // ── KPI "professionnels" pour la vue Analytics (correspond à la maquette PERSONNEL / FLOTTE & PLANIFICATION) ──
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);

  const kpi = useMemo(() => {
    const totalSalaries = counts.salaries || salariesFull.length;
    const salariesActifs = salariesFull.filter((s) => s.active !== false).length;

    const totalConducteurs = counts.conducteurs || conducteursFull.length;
    const conducteursActifs = conducteursFull.filter((c) => c.bus_id).length;

    const totalBuses = counts.buses || busesFull.length;
    const busEnService = busesFull.filter((b) => b.status === 'actif' || !b.status).length;

    const totalCircuits = counts.circuits || circuitsFull.length;
    const circuitsActifs = circuitsFull.filter((c) => c.active !== false).length;

    const busAvecConducteur = busesFull.filter((b) => b.conducteur_id).length;
    const busSansConducteur = totalBuses - busAvecConducteur;
    const busAvecCircuit = busesFull.filter((b) => b.circuit_id).length;

    const trajetsPlanifies = counts.planning || 0;

    return {
      totalSalaries,
      salariesActifs,
      salariesPct: pct(salariesActifs, totalSalaries),

      totalConducteurs,
      conducteursActifs,
      conducteursPct: pct(conducteursActifs, totalConducteurs),

      totalBuses,
      busEnService,
      busEnServicePct: pct(busEnService, totalBuses),

      totalCircuits,
      circuitsActifs,
      circuitsPct: pct(circuitsActifs, totalCircuits),

      busAvecConducteur,
      busAvecConducteurPct: pct(busAvecConducteur, totalBuses),
      busSansConducteur,
      busSansConducteurPct: pct(busSansConducteur, totalBuses),
      busAvecCircuit,
      busAvecCircuitPct: pct(busAvecCircuit, totalBuses),
      trajetsPlanifies,
    };
  }, [counts, filteredAttendance, busesFull, conducteursFull, circuitsFull, salariesFull]);

  const makeBarOptions = (categories) => ({
    chart: { type: 'bar', toolbar: { show: false } },
    plotOptions: { bar: { horizontal: true, distributed: false, borderRadius: 4 } },
    dataLabels: { enabled: false },
    xaxis: { categories, labels: { style: { fontSize: '12px' } } },
    yaxis: { labels: { style: { fontSize: '12px' } } },
    tooltip: { theme: 'light' },
  });

  return (
    <Box sx={{ width: '100%' }}>
      {/* En-tête + bascule Analytics / Attendance + sélecteur de période */}
      <Box sx={{ mb: 3, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
        <Box>
          <Typography variant="h4" gutterBottom>Dashboard</Typography>
          <Typography variant="body2" color="text.secondary">
            {view === 'analytics' ? 'Live analytics from Firestore collections' : 'Real-time bus monitoring'}
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
          <ToggleButtonGroup
            value={view}
            exclusive
            onChange={(e, newView) => {
              if (newView) setView(newView);
            }}
            size="small"
          >
            <ToggleButton value="analytics">
              <BarChart3 size={16} style={{ marginRight: 6 }} />
              Analytics
            </ToggleButton>
            <ToggleButton value="attendance">
              <Activity size={16} style={{ marginRight: 6 }} />
              Attendance
            </ToggleButton>
          </ToggleButtonGroup>

          <FormControl size="small" sx={{ minWidth: 160 }}>
            <InputLabel id="period-select-label">Period</InputLabel>
            <Select
              labelId="period-select-label"
              value={period}
              label="Period"
              onChange={(e) => setPeriod(e.target.value)}
            >
              <MenuItem value="today">Today</MenuItem>
              <MenuItem value="week">This Week</MenuItem>
              <MenuItem value="month">This Month</MenuItem>
            </Select>
          </FormControl>
        </Box>
      </Box>

      {rtdbError && <Alert severity="error" sx={{ mb: 2 }}>{rtdbError}</Alert>}

      {/* ================= VUE ANALYTICS (par défaut) ================= */}
      {view === 'analytics' && (
        <Grid container spacing={3}>
          {/* ── Section PERSONNEL ── */}
          <Grid item xs={12}>
            <SectionLabel color="#1565c0">Personnel</SectionLabel>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Kpi2Card
              icon={<Users size={20} />}
              color="#1565c0"
              badgeText={countsLoading ? '' : `${kpi.salariesPct}%`}
              value={countsLoading ? '...' : kpi.totalSalaries}
              label="Salariés"
              pct={kpi.salariesPct}
              leftValue={countsLoading ? '' : kpi.salariesActifs}
              leftLabel="actifs"
              rightValue={countsLoading ? '' : kpi.totalSalaries}
              rightLabel="total"
            />
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Kpi2Card
              icon={<UserCog size={20} />}
              color="#f57c00"
              badgeText={countsLoading ? '' : `${kpi.conducteursPct}%`}
              value={countsLoading ? '...' : kpi.totalConducteurs}
              label="Conducteurs"
              pct={kpi.conducteursPct}
              leftValue={countsLoading ? '' : kpi.conducteursActifs}
              leftLabel="actifs"
              rightValue={countsLoading ? '' : kpi.totalConducteurs}
              rightLabel="total"
            />
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Kpi2Card
              icon={<Bus size={20} />}
              color="#2e7d32"
              badgeText={countsLoading ? '' : `${kpi.busEnServicePct}%`}
              value={countsLoading ? '...' : kpi.totalBuses}
              label="Bus"
              pct={kpi.busEnServicePct}
              leftValue={countsLoading ? '' : kpi.busEnService}
              leftLabel="en service"
              rightValue={countsLoading ? '' : kpi.totalBuses}
              rightLabel="total"
            />
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Kpi2Card
              icon={<Route size={20} />}
              color="#00897b"
              badgeText={countsLoading ? '' : `${kpi.circuitsPct}%`}
              value={countsLoading ? '...' : kpi.totalCircuits}
              label="Circuits"
              pct={kpi.circuitsPct}
              leftValue={countsLoading ? '' : kpi.circuitsActifs}
              leftLabel="actifs"
              rightValue={countsLoading ? '' : kpi.totalCircuits}
              rightLabel="total"
            />
          </Grid>

          {/* ── Section FLOTTE & PLANIFICATION ── */}
          <Grid item xs={12} sx={{ mt: 1 }}>
            <SectionLabel color="#1565c0">Flotte &amp; Planification</SectionLabel>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Kpi2Card
              icon={<Route size={20} style={{ transform: 'rotate(90deg)' }} />}
              color="#2e7d32"
              badgeText={countsLoading ? '' : `${kpi.busAvecConducteurPct}%`}
              value={countsLoading ? '...' : kpi.totalBuses}
              label="Bus assignés"
              pct={kpi.busAvecConducteurPct}
              leftValue={countsLoading ? '' : kpi.busAvecConducteur}
              leftLabel="avec conducteur"
              rightValue={countsLoading ? '' : kpi.totalBuses}
              rightLabel="bus"
            />
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Kpi2Card
              icon={<ShieldAlert size={20} />}
              color="#d32f2f"
              alert={kpi.busSansConducteur > 0}
              badgeText="alerte"
              badgeIcon={<ShieldAlert size={12} />}
              value={countsLoading ? '...' : kpi.totalBuses}
              label="Sans conducteur"
              pct={kpi.busSansConducteurPct}
              leftValue={countsLoading ? '' : kpi.busSansConducteur}
              leftLabel="à assigner"
              rightValue={countsLoading ? '' : kpi.totalBuses}
              rightLabel="bus"
            />
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Kpi2Card
              icon={<Route size={20} />}
              color="#00897b"
              badgeText={countsLoading ? '' : `${kpi.busAvecCircuitPct}%`}
              value={countsLoading ? '...' : kpi.totalBuses}
              label="Bus avec circuit"
              pct={kpi.busAvecCircuitPct}
              leftValue={countsLoading ? '' : kpi.busAvecCircuit}
              leftLabel="circuit assigné"
              rightValue={countsLoading ? '' : kpi.totalBuses}
              rightLabel="bus"
            />
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Kpi2Card
              icon={<Clock size={20} />}
              color="#7b1fa2"
              badgeText={countsLoading ? '' : `${kpi.circuitsActifs}`}
              value={countsLoading ? '...' : kpi.trajetsPlanifies}
              label="Trajets planifiés"
              leftValue={countsLoading ? '' : kpi.circuitsActifs}
              leftLabel="circuits actifs"
              rightValue={countsLoading ? '' : kpi.trajetsPlanifies}
              rightLabel="trajets"
            />
          </Grid>

          {/* ── Alertes en surbrillance ── */}
          <Grid item xs={12}>
            <Card
              elevation={0}
              sx={{
                borderRadius: 4,
                border: '1px solid',
                borderColor: alpha('#d32f2f', 0.2),
                bgcolor: alpha('#d32f2f', 0.03),
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                p: 2.5,
              }}
            >
              <Avatar sx={{ bgcolor: alpha('#d32f2f', 0.1), color: '#d32f2f', width: 44, height: 44, borderRadius: 3 }}>
                <ShieldAlert size={22} />
              </Avatar>
              <Box sx={{ flex: 1 }}>
                <Typography sx={{ fontWeight: 700 }}>{stats.alertsCount} alerte{stats.alertsCount > 1 ? 's' : ''}</Typography>
                <Typography variant="body2" color="text.secondary">{periodLabel}</Typography>
              </Box>
              <Chip
                icon={<Clock size={14} />}
                label={periodLabel}
                size="small"
                sx={{ bgcolor: 'white', border: '1px solid', borderColor: 'divider' }}
              />
            </Card>
          </Grid>

          <Grid item xs={12} md={6}>
            <Card>
              <CardContent>
                <Typography variant="h6">Persons per Bus ({periodLabel})</Typography>
                {busCounts.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">No attendance data yet.</Typography>
                ) : (
                  <Box sx={{ height: 260 }}>
                    <ReactApexChart
                      options={makeBarOptions(busCounts.map((b) => b.name))}
                      series={[{ data: busCounts.map((b) => b.value) }]}
                      type="bar"
                      height={260}
                      width="100%"
                    />
                  </Box>
                )}
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12} md={6}>
            <Card>
              <CardContent>
                <Typography variant="h6">Persons per Route ({periodLabel})</Typography>
                {routeCounts.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">No attendance data yet.</Typography>
                ) : (
                  <Box sx={{ height: 260 }}>
                    <ReactApexChart
                      options={makeBarOptions(routeCounts.map((r) => r.name))}
                      series={[{ data: routeCounts.map((r) => r.value) }]}
                      type="bar"
                      height={260}
                      width="100%"
                    />
                  </Box>
                )}
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      )}

      {/* ================= VUE ATTENDANCE (via bouton) ================= */}
      {view === 'attendance' && (
        <>
          <Grid container spacing={2} sx={{ mb: 2 }}>
            <Grid item xs={12} sm={6} md={4}>
              <Card>
                <CardContent sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                  <Avatar sx={{ bgcolor: 'primary.main' }}>
                    <Users />
                  </Avatar>
                  <Box>
                    <Typography variant="subtitle2">Total Boarded — {periodLabel}</Typography>
                    <Typography variant="h5">{stats.total}</Typography>
                  </Box>
                </CardContent>
              </Card>
            </Grid>

            <Grid item xs={12} sm={6} md={4}>
              <Card>
                <CardContent sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                  <Avatar sx={{ bgcolor: 'error.main' }}>
                    <ShieldAlert />
                  </Avatar>
                  <Box>
                    <Typography variant="subtitle2">Alerts — {periodLabel}</Typography>
                    <Typography variant="h5">{stats.alertsCount}</Typography>
                  </Box>
                </CardContent>
              </Card>
            </Grid>
          </Grid>

          <Grid container spacing={2}>
            <Grid item xs={12} md={6}>
              <Card>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                    <Users color="primary" size={18} />
                    <Typography variant="h6">Latest Boardings</Typography>
                  </Box>

                  {filteredAttendance.length === 0 ? (
                    <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: 'center' }}>No attendance for selected period.</Typography>
                  ) : (
                    <List>
                      {filteredAttendance.slice(0, 5).map((att) => (
                        <ListItem key={att.id} disableGutters>
                          <ListItemText
                            disableTypography
                            primary={
                              <Box sx={{ display: 'grid', gap: 0.5 }}>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                                  <strong>{att.matricule}</strong>
                                  <Chip
                                    label={att.statut || 'Unknown'}
                                    color={att.statut === 'present' ? 'success' : att.statut === 'absent' ? 'error' : 'default'}
                                    size="small"
                                  />
                                </Box>
                                <Typography component="span" variant="body2" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                  <Clock size={12} /> {att.time || '—'} • {att.date || '—'}
                                </Typography>
                                <Typography component="span" variant="body2" color="text.secondary">
                                  Bus: {att.bus_id} | Route: {att.code_trajet}
                                </Typography>
                              </Box>
                            }
                          />
                        </ListItem>
                      ))}
                    </List>
                  )}
                </CardContent>
              </Card>
            </Grid>

            <Grid item xs={12} md={6}>
              <Card>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                    <ShieldAlert color="error" />
                    <Typography variant="h6">Recent Alerts</Typography>
                  </Box>

                  {filteredAlerts.length === 0 ? (
                    <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: 'center' }}>No alerts for selected period.</Typography>
                  ) : (
                    <List>
                      {filteredAlerts.slice(0, 5).map((alert) => (
                        <ListItem key={alert.id} disableGutters>
                          <ListItemText
                            disableTypography
                            primary={
                              <Box sx={{ display: 'grid', gap: 0.5 }}>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                                  <strong>{alert.matricule}</strong>
                                  <Typography component="span" variant="body2" color="text.secondary">
                                    on Bus {alert.bus_id}
                                  </Typography>
                                  <Chip label={alert.alert_type} size="small" sx={{ ml: 1 }} />
                                </Box>
                                <Typography component="span" variant="body2" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                  <Clock size={12} /> {alert.time || '—'}
                                </Typography>
                              </Box>
                            }
                          />
                        </ListItem>
                      ))}
                    </List>
                  )}
                </CardContent>
              </Card>
            </Grid>
          </Grid>
        </>
      )}
    </Box>
  )
}

// ============================================================
// SectionLabel — petit en-tête de section avec barre colorée (PERSONNEL / FLOTTE & PLANIFICATION)
// ============================================================
function SectionLabel({ color, children }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
      <Box sx={{ width: 3, height: 14, borderRadius: 1, bgcolor: color }} />
      <Typography
        variant="overline"
        sx={{ fontWeight: 700, letterSpacing: 0.5, color: 'text.secondary', lineHeight: 1 }}
      >
        {children}
      </Typography>
    </Box>
  );
}

// ============================================================
// Kpi2Card — carte KPI fidèle à la maquette (badge %, valeur, barre, "X sous-titre / Y sous-titre")
// (nouveau composant, additif, n'affecte aucune autre vue)
// ============================================================
function Kpi2Card({ icon, color, badgeText, badgeIcon, alert, value, label, pct, leftValue, leftLabel, rightValue, rightLabel }) {
  const accent = alert ? '#d32f2f' : color;
  return (
    <Card
      elevation={0}
      sx={{
        borderRadius: 4,
        border: '1px solid',
        borderColor: alert ? alpha('#d32f2f', 0.35) : 'divider',
        bgcolor: alert ? alpha('#d32f2f', 0.02) : 'background.paper',
        p: 2.25,
        height: '100%',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
        <Avatar sx={{ bgcolor: alpha(accent, 0.1), color: accent, width: 38, height: 38, borderRadius: 2.5 }}>
          {icon}
        </Avatar>
        <Chip
          size="small"
          icon={badgeIcon}
          label={badgeText}
          sx={{
            bgcolor: alpha(accent, 0.1),
            color: accent,
            fontWeight: 700,
            fontSize: 11,
            height: 22,
            '& .MuiChip-icon': { color: accent },
          }}
        />
      </Box>

      <Typography sx={{ fontSize: 28, fontWeight: 700, color: alert ? accent : 'text.primary', lineHeight: 1 }}>
        {value}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {label}
      </Typography>

      {typeof pct === 'number' && (
        <LinearProgress
          variant="determinate"
          value={Math.min(100, pct)}
          sx={{
            mt: 1.5,
            height: 5,
            borderRadius: 3,
            bgcolor: alpha(accent, 0.1),
            '& .MuiLinearProgress-bar': { bgcolor: accent, borderRadius: 3 },
          }}
        />
      )}

      <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary' }}>
        <Box component="span" sx={{ color: accent, fontWeight: 700 }}>{leftValue}</Box> {leftLabel} / {rightValue} {rightLabel}
      </Typography>
    </Card>
  );
}

