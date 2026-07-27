import { useState, useEffect, useMemo } from 'react';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import { Filter, Navigation } from 'lucide-react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Chip from '@mui/material/Chip';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Divider from '@mui/material/Divider';
import styles from './BusMap.module.css';

// Fix for default marker icons in Leaflet with React
if (typeof window !== 'undefined') {
  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
    iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
  });
}

// Two marker colors, same convention as the Flutter supervision screen:
// blue = fresh GPS signal (< 5 min), orange = stale signal (present but old)
const busIconRecent = L.icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});
const busIconStale = L.icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-orange.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

function MapView({ center, zoom }) {
  const map = useMap();

  useEffect(() => {
    map.setView(center, zoom);
  }, [center, zoom, map]);

  return null;
}

// Shown only when the "buses" collection is truly empty (dev/demo fallback), same role as before
const sampleBuses = [
  {
    id: 'sample-1',
    bus_id: 'A12',
    route: 'Central Line',
    driver: 'Sami',
    latitude: 33.5731,
    longitude: -7.5898,
    speed: 48,
    last_update: Date.now() - 60000,
    hasGps: true,
    isRecent: true,
    status: 'actif',
  },
  {
    id: 'sample-2',
    bus_id: 'B07',
    route: 'Airport Express',
    driver: 'Nadia',
    latitude: 33.5678,
    longitude: -7.5972,
    speed: 36,
    last_update: Date.now() - 90000,
    hasGps: true,
    isRecent: true,
    status: 'actif',
  },
  {
    id: 'sample-3',
    bus_id: 'C21',
    route: 'Harbor Shuttle',
    driver: 'Mazen',
    latitude: 33.5689,
    longitude: -7.5834,
    speed: 42,
    last_update: Date.now() - 120000,
    hasGps: true,
    isRecent: true,
    status: 'actif',
  },
];

const FIVE_MIN_MS = 5 * 60 * 1000;

function formatAge(ms) {
  if (ms == null) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export default function BusMap() {
  const [buses, setBuses] = useState([]); // raw active buses from Firestore, enriched with gps info
  const [conducteursMap, setConducteursMap] = useState({}); // id -> nom
  const [circuitsMap, setCircuitsMap] = useState({}); // id -> {code, designation}
  const [filteredBuses, setFilteredBuses] = useState([]);
  const [selectedBus, setSelectedBus] = useState('all');
  const [loading, setLoading] = useState(true);
  const [mapCenter, setMapCenter] = useState([33.5731, -7.5898]);
  const [, setTick] = useState(0); // re-render every 30s so "Xmin ago" stays fresh (like Flutter's Timer.periodic)

  const availableBuses = useMemo(() => (buses.length > 0 ? buses : sampleBuses), [buses]);
  const hasLiveData = buses.length > 0;
  const onlineCount = useMemo(() => availableBuses.filter((b) => b.hasGps && b.isRecent).length, [availableBuses]);

  // ── Buses actifs, en temps réel (mirrors StreamBuilder on 'buses' where status == actif) ──
  useEffect(() => {
    if (!db) {
      setLoading(false);
      return;
    }
    const q = query(collection(db, 'buses'), where('status', '==', 'actif'));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const now = Date.now();
        const busArray = snapshot.docs.map((docSnap) => {
          const d = docSnap.data();
          const gps = d.last_gps || null;
          const lat = gps?.lat;
          const lng = gps?.lng;
          const hasGps = !!gps && !!lat && !!lng;
          let lastUpdateMs = null;
          if (gps?.timestamp) {
            // Firestore Timestamp has toMillis(); RTDB-style ISO strings are also handled just in case
            lastUpdateMs = typeof gps.timestamp?.toMillis === 'function'
              ? gps.timestamp.toMillis()
              : new Date(gps.timestamp).getTime();
          }
          const age = lastUpdateMs ? now - lastUpdateMs : null;
          const isRecent = age !== null && age < FIVE_MIN_MS;

          return {
            id: docSnap.id,
            bus_id: d.immatriculation || docSnap.id,
            conducteur_id: d.conducteur_id || '',
            circuit_id: d.circuit_id || '',
            latitude: hasGps ? lat : null,
            longitude: hasGps ? lng : null,
            speed: gps?.speed_kmh ?? null,
            last_update: lastUpdateMs,
            hasGps,
            isRecent,
            status: d.status || 'actif',
          };
        });
        setBuses(busArray);
        setLoading(false);
      },
      (err) => {
        console.error('BusMap buses onSnapshot error:', err);
        setLoading(false);
      }
    );
    return () => unsubscribe();
  }, []);

  // ── Conducteurs & circuits lookups, for driver name / route label in list + popup ──
  useEffect(() => {
    if (!db) return;
    const unsubCond = onSnapshot(collection(db, 'conducteurs'), (snap) => {
      const map = {};
      snap.docs.forEach((d) => {
        map[d.id] = d.data().nom || d.id;
      });
      setConducteursMap(map);
    });
    const unsubCirc = onSnapshot(collection(db, 'circuits'), (snap) => {
      const map = {};
      snap.docs.forEach((d) => {
        const data = d.data();
        map[d.id] = { code: data.code || '', designation: data.designation || '' };
      });
      setCircuitsMap(map);
    });
    return () => {
      unsubCond();
      unsubCirc();
    };
  }, []);

  // Refresh "Xmin ago" labels every 30s, same cadence as Flutter's Timer.periodic
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const source = buses.length > 0 ? buses : sampleBuses;
    if (selectedBus === 'all') {
      setFilteredBuses(source);
    } else {
      setFilteredBuses(source.filter((bus) => String(bus.bus_id) === String(selectedBus)));
    }
  }, [selectedBus, buses]);

  useEffect(() => {
    const source = buses.length > 0 ? buses : sampleBuses;
    const activeBuses = selectedBus === 'all' ? source : source.filter((bus) => String(bus.bus_id) === String(selectedBus));
    const withGps = activeBuses.filter((b) => b.hasGps);
    const nextCenter = withGps.length > 0 ? [withGps[0].latitude, withGps[0].longitude] : mapCenter;
    if (nextCenter[0] && nextCenter[1]) {
      setMapCenter(nextCenter);
    }
  }, [selectedBus, buses]);

  const handleFilterChange = (event) => {
    setSelectedBus(event.target.value);
  };

  const handleBusSelect = (busId) => {
    setSelectedBus(busId);
  };

  const driverLabel = (bus) => (bus.conducteur_id && conducteursMap[bus.conducteur_id]) || bus.driver || 'No driver';
  const routeLabel = (bus) => {
    const c = bus.circuit_id ? circuitsMap[bus.circuit_id] : null;
    if (c) return `${c.code}${c.designation ? ` — ${c.designation}` : ''}`;
    return bus.route || 'No circuit assigned';
  };

  return (
    <Box className={styles.container}>
      <Box className={styles.busMapLayout}>
        <Box className={styles.sidebar}>
          <Card sx={{ mb: 2, p: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
              <Navigation size={24} />
              <Box>
                <Typography variant="h5">Fleet Overview</Typography>
                <Typography variant="body2" color="text.secondary">
                  Monitor routes, drivers, and live bus positions.
                </Typography>
              </Box>
            </Box>
            <CardContent sx={{ display: 'grid', gap: 1.5 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="subtitle2">Bus status</Typography>
                <Chip label={hasLiveData ? 'Live feed' : 'Sample feed'} color={hasLiveData ? 'success' : 'default'} size="small" />
              </Box>
              <Divider />
              <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                <Box sx={{ display: 'grid', gap: 1 }}>
                  <Typography variant="body2">Total active buses</Typography>
                  <Typography variant="h4">{availableBuses.length}</Typography>
                </Box>
                <Box sx={{ display: 'grid', gap: 1, textAlign: 'right' }}>
                  <Typography variant="body2">Online now</Typography>
                  <Typography variant="h4" color={onlineCount > 0 ? 'success.main' : 'text.secondary'}>
                    {onlineCount}
                  </Typography>
                </Box>
              </Box>
            </CardContent>
          </Card>

          <Card sx={{ p: 2, mb: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
              <Filter size={20} />
              <Typography variant="subtitle1">Filter bus</Typography>
            </Box>
            <FormControl fullWidth>
              <InputLabel id="bus-filter-label">Bus</InputLabel>
              <Select
                labelId="bus-filter-label"
                label="Bus"
                value={selectedBus}
                onChange={handleFilterChange}
                size="small"
              >
                <MenuItem value="all">All Buses</MenuItem>
                {availableBuses.map((bus) => (
                  <MenuItem key={bus.id} value={bus.bus_id}>
                    {`Bus ${bus.bus_id} ${bus.hasGps ? (bus.isRecent ? '🟢' : '🟠') : '⚪'}`}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Card>

          <Card sx={{ p: 0 }}>
            <Typography variant="subtitle1" sx={{ p: 2, borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
              Fleet Details
            </Typography>
            <List className={styles.busList}>
              {availableBuses.map((bus) => (
                <ListItem key={bus.id} disablePadding>
                  <ListItemButton selected={String(selectedBus) === String(bus.bus_id)} onClick={() => handleBusSelect(bus.bus_id)}>
                    <ListItemText
                      primary={`Bus ${bus.bus_id}`}
                      secondary={
                        <>
                          {routeLabel(bus)} · {driverLabel(bus)}
                          <br />
                          {bus.hasGps
                            ? `${bus.isRecent ? '🟢 Online' : '🟠 Signal delayed'}${bus.last_update ? ` · ${formatAge(Date.now() - bus.last_update)}` : ''}`
                            : '⚪ Offline — no GPS signal'}
                        </>
                      }
                    />
                  </ListItemButton>
                </ListItem>
              ))}
            </List>
          </Card>
        </Box>

        <Box className={styles.mapContainer} sx={{ position: 'relative' }}>
          {!db ? (
            <Box className={styles.error}>
              Error: Firestore is not connected. Please check your Firebase configuration.
            </Box>
          ) : loading ? (
            <Box className={styles.loading}>Loading bus locations...</Box>
          ) : (
            <MapContainer center={mapCenter} zoom={13} style={{ height: '100%', width: '100%' }}>
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <MapView center={mapCenter} zoom={13} />
              {filteredBuses
                .filter((bus) => bus.hasGps)
                .map((bus) => (
                  <Marker
                    key={bus.id}
                    position={[bus.latitude, bus.longitude]}
                    icon={bus.isRecent ? busIconRecent : busIconStale}
                  >
                    <Popup>
                      <div className={styles.popup}>
                        <strong>Bus {bus.bus_id}</strong>
                        <p>{routeLabel(bus)}</p>
                        <p>Driver: {driverLabel(bus)}</p>
                        <p>Speed: {bus.speed ?? '—'} km/h</p>
                        <p>{bus.isRecent ? '🟢 Online' : '🟠 Signal delayed'}</p>
                        <div className={styles.timestamp}>
                          Last update: {bus.last_update ? new Date(bus.last_update).toLocaleString() : 'Unknown'}
                        </div>
                      </div>
                    </Popup>
                  </Marker>
                ))}
            </MapContainer>
          )}
          {!loading && db && hasLiveData && availableBuses.every((b) => !b.hasGps) && (
            <Box className={styles.empty} sx={{ position: 'absolute' }}>
              No bus is currently sending its position.
            </Box>
          )}
        </Box>
      </Box>

      <Box className={styles.stats}>
        <Card sx={{ flex: 1, p: 2 }}>
          <Typography variant="subtitle2" color="text.secondary">Selected Bus</Typography>
          <Typography variant="h6">{selectedBus === 'all' ? 'All buses active' : `Bus ${selectedBus}`}</Typography>
        </Card>
        <Card sx={{ flex: 1, p: 2 }}>
          <Typography variant="subtitle2" color="text.secondary">Tracking mode</Typography>
          <Typography variant="h6">{hasLiveData ? (onlineCount > 0 ? 'Live GPS' : 'No signal') : 'Demo dashboard'}</Typography>
        </Card>
      </Box>
    </Box>
  );
}
