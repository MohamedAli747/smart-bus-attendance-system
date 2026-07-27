import React, { useState, useEffect } from 'react';
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  doc,
  getDoc,
  writeBatch,
  addDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase';
import {
  Box,
  Grid,
  Card,
  CardContent,
  Paper,
  Typography,
  Avatar,
  Chip,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  IconButton,
  CircularProgress,
  Snackbar,
  Alert,
  alpha,
} from '@mui/material';
import {
  DirectionsBus as BusIcon,
  Person as PersonIcon,
  AltRoute as RouteIcon,
  Link as LinkIcon,
  LinkOff as LinkOffIcon,
  Close as CloseIcon,
  CheckCircle as CheckCircleIcon,
  SwapHoriz as SwapHorizIcon,
} from '@mui/icons-material';

// ==================== Historique logging (same convention as Flutter's HistoriqueService) ====================
const logHistorique = async ({ action, collection: coll, description, details }) => {
  if (!db) return;
  try {
    await addDoc(collection(db, 'historique'), {
      action,
      collection: coll,
      description,
      utilisateur: 'Admin',
      timestamp: serverTimestamp(),
      ...(details ? { details } : {}),
    });
  } catch (e) {
    console.error('logHistorique error:', e);
  }
};

// ==================== Main Component ====================

export default function Assignation() {
  const [buses, setBuses] = useState([]);
  const [conducteurs, setConducteurs] = useState([]);
  const [circuits, setCircuits] = useState([]);
  const [loading, setLoading] = useState(true);

  const [selectedBusId, setSelectedBusId] = useState(null);
  const [selectedBusData, setSelectedBusData] = useState(null);

  // Dialog state: { type: 'conducteurForBus' | 'busForConducteur' | 'circuitForBus', busId, busData, conducteurUid, condData }
  const [dialog, setDialog] = useState(null);

  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' });
  const notify = (message, severity = 'success') => setSnackbar({ open: true, message, severity });

  // ── Realtime listeners (mirrors the 3 StreamBuilders in Flutter) ──
  useEffect(() => {
    if (!db) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const unsubBuses = onSnapshot(
      query(collection(db, 'buses'), orderBy('immatriculation')),
      (snap) => setBuses(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (err) => notify(`Error loading buses: ${err.message}`, 'error')
    );
    const unsubConducteurs = onSnapshot(
      query(collection(db, 'conducteurs'), orderBy('nom')),
      (snap) => setConducteurs(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (err) => notify(`Error loading conducteurs: ${err.message}`, 'error')
    );
    const unsubCircuits = onSnapshot(
      query(collection(db, 'circuits'), orderBy('code')),
      (snap) => {
        setCircuits(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      (err) => {
        notify(`Error loading circuits: ${err.message}`, 'error');
        setLoading(false);
      }
    );
    return () => {
      unsubBuses();
      unsubConducteurs();
      unsubCircuits();
    };
  }, []);

  // Keep selectedBusData in sync whenever the buses list updates
  useEffect(() => {
    if (selectedBusId) {
      const fresh = buses.find((b) => b.id === selectedBusId);
      if (fresh) setSelectedBusData(fresh);
    }
  }, [buses, selectedBusId]);

  // ── Bidirectional link: bus <-> conducteur (mirrors _doAssignConducteur) ──
  const doAssignConducteur = async (busId, conducteurUid, ancienBusDuCond, ancienCondDuBus) => {
    try {
      const batch = writeBatch(db);
      if (ancienBusDuCond && ancienBusDuCond !== busId) {
        batch.update(doc(db, 'buses', ancienBusDuCond), { conducteur_id: '' });
      }
      if (ancienCondDuBus && ancienCondDuBus !== conducteurUid) {
        batch.update(doc(db, 'conducteurs', ancienCondDuBus), { bus_id: '' });
      }
      batch.update(doc(db, 'buses', busId), { conducteur_id: conducteurUid });
      batch.update(doc(db, 'conducteurs', conducteurUid), { bus_id: busId });
      await batch.commit();

      await logHistorique({
        action: 'modification',
        collection: 'assignation',
        description: `Conducteur ${conducteurUid} assigné au bus ${busId}`,
        details: { bus_id: busId, conducteur_uid: conducteurUid },
      });
      notify('✓ Conducteur assigné');
    } catch (err) {
      notify(`Error: ${err.message}`, 'error');
    } finally {
      setDialog(null);
    }
  };

  // ── Bidirectional link: bus <-> circuit (mirrors _doAssignCircuit) ──
  const doAssignCircuit = async (busId, busData, circuitId, circuitData, ancienBusDuCircuit) => {
    try {
      const batch = writeBatch(db);
      const ancienCircuitDuBus = busData?.circuit_id || '';

      if (ancienBusDuCircuit && ancienBusDuCircuit !== busId) {
        batch.update(doc(db, 'buses', ancienBusDuCircuit), { circuit_id: '' });
      }
      if (ancienCircuitDuBus && ancienCircuitDuBus !== circuitId) {
        batch.update(doc(db, 'circuits', ancienCircuitDuBus), { bus_id: '' });
      }
      batch.update(doc(db, 'buses', busId), { circuit_id: circuitId });
      batch.update(doc(db, 'circuits', circuitId), { bus_id: busId });
      await batch.commit();

      const immat = busData?.immatriculation || busId;
      const codeCircuit = circuitData?.code || circuitId;
      const designCircuit = circuitData?.designation || '';
      await logHistorique({
        action: 'modification',
        collection: 'assignation',
        description: `Circuit ${codeCircuit} (${designCircuit}) assigné au bus ${immat}`,
        details: {
          bus_id: busId,
          immatriculation: immat,
          circuit_id: circuitId,
          circuit_code: codeCircuit,
          circuit_designation: designCircuit,
        },
      });
      notify('✓ Circuit assigné');
    } catch (err) {
      notify(`Error: ${err.message}`, 'error');
    } finally {
      setDialog(null);
    }
  };

  const unassignConducteur = async (busId, conducteurUid) => {
    if (!window.confirm("Retirer le conducteur ? Ce bus n'aura plus de conducteur assigné.")) return;
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'buses', busId), { conducteur_id: '' });
      if (conducteurUid) batch.update(doc(db, 'conducteurs', conducteurUid), { bus_id: '' });
      await batch.commit();
      await logHistorique({
        action: 'modification',
        collection: 'assignation',
        description: `Conducteur retiré du bus ${busId}`,
        details: { bus_id: busId, conducteur_uid: conducteurUid },
      });
      notify('Conducteur retiré', 'info');
    } catch (err) {
      notify(`Error: ${err.message}`, 'error');
    }
  };

  const unassignCircuit = async (busId, circuitId) => {
    if (!window.confirm("Retirer le circuit ? Ce bus n'aura plus de circuit assigné.")) return;
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'buses', busId), { circuit_id: '' });
      if (circuitId) batch.update(doc(db, 'circuits', circuitId), { bus_id: '' });
      await batch.commit();
      await logHistorique({
        action: 'modification',
        collection: 'assignation',
        description: `Circuit retiré du bus ${busId}`,
        details: { bus_id: busId, circuit_id: circuitId },
      });
      notify('Circuit retiré', 'info');
    } catch (err) {
      notify(`Error: ${err.message}`, 'error');
    }
  };

  const findConducteur = (uid) => conducteurs.find((c) => c.id === uid);
  const findBus = (id) => buses.find((b) => b.id === id);
  const findCircuit = (id) => circuits.find((c) => c.id === id);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3, bgcolor: '#f5f7fb', minHeight: '100vh' }}>
      {/* Header Card - same visual convention as other pages */}
      <Card
        elevation={0}
        sx={{
          mb: 3,
          borderRadius: 4,
          background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
          border: '1px solid',
          borderColor: 'divider',
        }}
      >
        <CardContent sx={{ p: 3, display: 'flex', alignItems: 'center', gap: 2 }}>
          <Avatar sx={{ bgcolor: alpha('#1565c0', 0.1), color: '#1565c0', width: 56, height: 56, borderRadius: 3 }}>
            <SwapHorizIcon />
          </Avatar>
          <Box>
            <Typography variant="h4" fontWeight={700} color="text.primary">
              Assignation
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Lier Bus ↔ Conducteur ↔ Circuit en temps réel
            </Typography>
          </Box>
        </CardContent>
      </Card>

      {selectedBusId && (
        <Box
          sx={{
            mb: 2,
            px: 2,
            py: 1,
            borderRadius: 2,
            bgcolor: alpha('#1565c0', 0.07),
            border: '1px solid',
            borderColor: alpha('#1565c0', 0.2),
            display: 'flex',
            alignItems: 'center',
            gap: 1,
          }}
        >
          <BusIcon sx={{ fontSize: 16, color: '#1565c0' }} />
          <Typography variant="body2" sx={{ fontWeight: 600, color: '#1565c0', flex: 1 }}>
            Bus sélectionné : {selectedBusData?.immatriculation || selectedBusId} — choisissez un circuit à lui assigner à droite
          </Typography>
          <IconButton size="small" onClick={() => { setSelectedBusId(null); setSelectedBusData(null); }}>
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Box>
      )}

      <Grid container spacing={2}>
        {/* ── Colonne Bus ── */}
        <Grid item xs={12} md={4}>
          <ColumnPaper icon={<BusIcon />} label="Bus" color="#1565c0">
            {buses.length === 0 ? (
              <EmptyState text="Aucun bus" />
            ) : (
              buses.map((b) => {
                const hasDriver = !!b.conducteur_id;
                const hasCircuit = !!b.circuit_id;
                const isSelected = selectedBusId === b.id;
                const driver = hasDriver ? findConducteur(b.conducteur_id) : null;
                const circuit = hasCircuit ? findCircuit(b.circuit_id) : null;
                return (
                  <Tile
                    key={b.id}
                    selected={isSelected}
                    borderColor={isSelected ? '#1565c0' : hasDriver ? '#a5d6a7' : undefined}
                    onClick={() => {
                      setSelectedBusId(isSelected ? null : b.id);
                      setSelectedBusData(isSelected ? null : b);
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <BusIcon sx={{ fontSize: 16, color: isSelected ? '#1565c0' : hasDriver ? 'green' : 'grey.500' }} />
                      <Typography sx={{ fontWeight: 700, fontSize: 13, flex: 1 }}>{b.immatriculation || b.id}</Typography>
                      <StatusChip label={hasDriver ? 'Assigné' : 'Libre'} color={hasDriver ? 'success' : 'default'} />
                    </Box>
                    <Typography variant="caption" color="text.secondary">
                      {b.marque || ''} · {b.site_exploitation || ''}
                    </Typography>
                    {driver && (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
                        <PersonIcon sx={{ fontSize: 12, color: 'green' }} />
                        <Typography variant="caption" sx={{ color: 'green' }}>{driver.nom}</Typography>
                      </Box>
                    )}
                    {circuit && (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.3 }}>
                        <RouteIcon sx={{ fontSize: 12, color: 'teal' }} />
                        <Typography variant="caption" sx={{ color: 'teal' }} noWrap>
                          {circuit.code} — {circuit.designation}
                        </Typography>
                      </Box>
                    )}
                    <Box sx={{ display: 'flex', gap: 0.5, mt: 1 }}>
                      <TileButton
                        icon={<SwapHorizIcon sx={{ fontSize: 13 }} />}
                        label={hasDriver ? 'Changer conducteur' : 'Assigner conducteur'}
                        color="#1565c0"
                        onClick={(e) => { e.stopPropagation(); setDialog({ type: 'conducteurForBus', busId: b.id, busData: b }); }}
                      />
                      {hasDriver && (
                        <TileButton
                          icon={<LinkOffIcon sx={{ fontSize: 13 }} />}
                          label="Retirer"
                          color="#d32f2f"
                          onClick={(e) => { e.stopPropagation(); unassignConducteur(b.id, b.conducteur_id); }}
                        />
                      )}
                    </Box>
                    <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5 }}>
                      <TileButton
                        icon={<RouteIcon sx={{ fontSize: 13 }} />}
                        label={isSelected ? '▶ Sélectionné' : hasCircuit ? 'Changer circuit' : 'Assigner circuit'}
                        color={isSelected || hasCircuit ? '#00897b' : '#757575'}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedBusId(isSelected ? null : b.id);
                          setSelectedBusData(isSelected ? null : b);
                        }}
                      />
                      {hasCircuit && (
                        <TileButton
                          icon={<LinkOffIcon sx={{ fontSize: 13 }} />}
                          label="Retirer"
                          color="#d32f2f"
                          onClick={(e) => { e.stopPropagation(); unassignCircuit(b.id, b.circuit_id); }}
                        />
                      )}
                    </Box>
                  </Tile>
                );
              })
            )}
          </ColumnPaper>
        </Grid>

        {/* ── Colonne Conducteurs ── */}
        <Grid item xs={12} md={4}>
          <ColumnPaper icon={<PersonIcon />} label="Conducteurs" color="#f57c00">
            {conducteurs.length === 0 ? (
              <EmptyState text="Aucun conducteur" />
            ) : (
              conducteurs.map((c) => {
                const hasBus = !!c.bus_id;
                const bus = hasBus ? findBus(c.bus_id) : null;
                return (
                  <Tile key={c.id} borderColor={hasBus ? '#ffcc80' : undefined}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Avatar sx={{ width: 26, height: 26, fontSize: 12, bgcolor: hasBus ? '#fff3e0' : 'grey.100', color: hasBus ? '#f57c00' : 'grey.600' }}>
                        {(c.nom || '?')[0]?.toUpperCase()}
                      </Avatar>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography sx={{ fontWeight: 700, fontSize: 13 }} noWrap>{c.nom}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          Mat. {c.matricule || ''} · {c.horaire || ''}
                        </Typography>
                      </Box>
                      <StatusChip label={hasBus ? 'Assigné' : 'Dispo'} color={hasBus ? 'warning' : 'default'} />
                    </Box>
                    {bus && (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
                        <BusIcon sx={{ fontSize: 12, color: '#f57c00' }} />
                        <Typography variant="caption" sx={{ color: '#f57c00' }}>{bus.immatriculation}</Typography>
                      </Box>
                    )}
                    <Box sx={{ display: 'flex', gap: 0.5, mt: 1 }}>
                      <TileButton
                        icon={<BusIcon sx={{ fontSize: 13 }} />}
                        label={hasBus ? 'Changer bus' : 'Assigner bus'}
                        color="#f57c00"
                        onClick={() => setDialog({ type: 'busForConducteur', conducteurUid: c.id, condData: c })}
                      />
                      {hasBus && (
                        <TileButton
                          icon={<LinkOffIcon sx={{ fontSize: 13 }} />}
                          label="Retirer"
                          color="#d32f2f"
                          onClick={() => unassignConducteur(c.bus_id, c.id)}
                        />
                      )}
                    </Box>
                  </Tile>
                );
              })
            )}
          </ColumnPaper>
        </Grid>

        {/* ── Colonne Circuits ── */}
        <Grid item xs={12} md={4}>
          <ColumnPaper icon={<RouteIcon />} label="Circuits" color="#00897b">
            {circuits.length === 0 ? (
              <EmptyState text="Aucun circuit" />
            ) : (
              circuits.map((c) => {
                const hasBus = !!c.bus_id;
                const isAssignedToSelected = !!selectedBusId && c.bus_id === selectedBusId;
                const bus = hasBus ? findBus(c.bus_id) : null;
                return (
                  <Tile
                    key={c.id}
                    selected={isAssignedToSelected}
                    borderColor={isAssignedToSelected ? 'teal' : hasBus ? '#80cbc4' : undefined}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Box
                        sx={{
                          width: 30, height: 30, borderRadius: 1.5, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          bgcolor: isAssignedToSelected ? '#b2dfdb' : '#e0f2f1',
                        }}
                      >
                        <Typography sx={{ fontSize: 9, fontWeight: 700, color: '#00695c' }}>
                          {(c.code || '').slice(0, 4)}
                        </Typography>
                      </Box>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography sx={{ fontWeight: 700, fontSize: 13 }} noWrap>{c.designation || c.id}</Typography>
                        <Typography variant="caption" color="text.secondary">Code : {c.code || ''}</Typography>
                      </Box>
                      <StatusChip
                        label={isAssignedToSelected ? 'Ce bus' : hasBus ? 'Assigné' : 'Libre'}
                        color={isAssignedToSelected ? 'info' : hasBus ? 'warning' : 'default'}
                      />
                    </Box>
                    {c.active === false && (
                      <Typography variant="caption" sx={{ color: 'error.main' }}>⛔ Inactif</Typography>
                    )}
                    {bus && !isAssignedToSelected && (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
                        <BusIcon sx={{ fontSize: 12, color: '#f57c00' }} />
                        <Typography variant="caption" sx={{ color: '#f57c00' }}>{bus.immatriculation}</Typography>
                      </Box>
                    )}
                    {selectedBusId && (
                      <Box sx={{ display: 'flex', gap: 0.5, mt: 1 }}>
                        {!isAssignedToSelected ? (
                          <TileButton
                            icon={<LinkIcon sx={{ fontSize: 13 }} />}
                            label="Assigner à ce bus"
                            color="#00897b"
                            onClick={() => doAssignCircuit(selectedBusId, selectedBusData, c.id, c, c.bus_id || '')}
                          />
                        ) : (
                          <>
                            <TileButton icon={<CheckCircleIcon sx={{ fontSize: 13 }} />} label="✓ Circuit actuel" color="#00897b" onClick={() => {}} />
                            <TileButton
                              icon={<LinkOffIcon sx={{ fontSize: 13 }} />}
                              label="Retirer"
                              color="#d32f2f"
                              onClick={() => unassignCircuit(selectedBusId, c.id)}
                            />
                          </>
                        )}
                      </Box>
                    )}
                  </Tile>
                );
              })
            )}
            {!selectedBusId && (
              <Box sx={{ textAlign: 'center', p: 3, color: 'text.disabled' }}>
                <Typography variant="body2">Sélectionnez un bus pour assigner un circuit</Typography>
              </Box>
            )}
          </ColumnPaper>
        </Grid>
      </Grid>

      {/* ── Dialog : choisir un conducteur pour un bus ── */}
      <Dialog open={dialog?.type === 'conducteurForBus'} onClose={() => setDialog(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <PersonIcon sx={{ color: '#1565c0' }} />
          Conducteur pour {dialog?.busData?.immatriculation || dialog?.busId}
        </DialogTitle>
        <DialogContent dividers sx={{ maxHeight: 400 }}>
          <List dense>
            {conducteurs.length === 0 && <Typography color="text.secondary" sx={{ p: 2 }}>Aucun conducteur</Typography>}
            {conducteurs.map((c) => {
              const isCurrent = dialog?.busData?.conducteur_id === c.id;
              const hasOtherBus = !!c.bus_id && !isCurrent;
              return (
                <ListItem
                  key={c.id}
                  secondaryAction={
                    isCurrent ? (
                      <Chip size="small" label="Actuel" />
                    ) : (
                      <Button
                        size="small"
                        variant="contained"
                        onClick={() => doAssignConducteur(dialog.busId, c.id, c.bus_id || '', dialog?.busData?.conducteur_id || '')}
                      >
                        Choisir
                      </Button>
                    )
                  }
                >
                  <ListItemAvatar>
                    <Avatar sx={{ bgcolor: isCurrent ? 'success.light' : hasOtherBus ? 'warning.light' : 'primary.light' }}>
                      {(c.nom || '?')[0]?.toUpperCase()}
                    </Avatar>
                  </ListItemAvatar>
                  <ListItemText
                    primary={c.nom}
                    secondary={
                      <>
                        Mat. {c.matricule || ''} · {c.horaire || ''}
                        {hasOtherBus ? ` — ⚠ Déjà sur bus ${c.bus_id}` : ''}
                      </>
                    }
                  />
                </ListItem>
              );
            })}
          </List>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialog(null)}>Fermer</Button>
        </DialogActions>
      </Dialog>

      {/* ── Dialog : choisir un bus pour un conducteur ── */}
      <Dialog open={dialog?.type === 'busForConducteur'} onClose={() => setDialog(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <BusIcon sx={{ color: '#f57c00' }} />
          Bus pour {dialog?.condData?.nom || dialog?.conducteurUid}
        </DialogTitle>
        <DialogContent dividers sx={{ maxHeight: 400 }}>
          <List dense>
            {buses.filter((b) => b.status === 'actif' || !b.status).length === 0 && (
              <Typography color="text.secondary" sx={{ p: 2 }}>Aucun bus actif</Typography>
            )}
            {buses
              .filter((b) => b.status === 'actif' || !b.status)
              .map((b) => {
                const isCurrent = dialog?.condData?.bus_id === b.id;
                const hasOtherDriver = !!b.conducteur_id && !isCurrent;
                return (
                  <ListItem
                    key={b.id}
                    secondaryAction={
                      isCurrent ? (
                        <Chip size="small" label="Actuel" />
                      ) : (
                        <Button
                          size="small"
                          variant="contained"
                          color="warning"
                          onClick={() => doAssignConducteur(b.id, dialog.conducteurUid, dialog?.condData?.bus_id || '', b.conducteur_id || '')}
                        >
                          Choisir
                        </Button>
                      )
                    }
                  >
                    <ListItemAvatar>
                      <Avatar sx={{ bgcolor: isCurrent ? 'success.light' : hasOtherDriver ? 'warning.light' : 'primary.light' }}>
                        <BusIcon fontSize="small" />
                      </Avatar>
                    </ListItemAvatar>
                    <ListItemText
                      primary={b.immatriculation || b.id}
                      secondary={
                        <>
                          {b.marque || ''} · {b.site_exploitation || ''}
                          {hasOtherDriver ? ` — ⚠ Conducteur : ${b.conducteur_id}` : ''}
                        </>
                      }
                    />
                  </ListItem>
                );
              })}
          </List>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialog(null)}>Fermer</Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))} severity={snackbar.severity} sx={{ width: '100%', borderRadius: 2 }}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}

// ==================== Small presentational helpers (kept local to this file) ====================

function ColumnPaper({ icon, label, color, children }) {
  return (
    <Paper elevation={0} sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider', overflow: 'hidden', height: '100%' }}>
      <Box sx={{ px: 2, py: 1.5, bgcolor: alpha(color, 0.05), borderBottom: '1px solid', borderColor: alpha(color, 0.2), display: 'flex', alignItems: 'center', gap: 1 }}>
        {React.cloneElement(icon, { sx: { fontSize: 18, color } })}
        <Typography sx={{ fontWeight: 700, fontSize: 14, color }}>{label}</Typography>
      </Box>
      <Box sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 'calc(100vh - 340px)', overflowY: 'auto' }}>
        {children}
      </Box>
    </Paper>
  );
}

function Tile({ children, selected, borderColor, onClick }) {
  return (
    <Box
      onClick={onClick}
      sx={{
        p: 1.5,
        borderRadius: 3,
        bgcolor: selected ? alpha('#1565c0', 0.05) : 'background.paper',
        border: '1px solid',
        borderColor: selected ? '#1565c0' : borderColor || 'divider',
        borderWidth: selected ? 2 : 1,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'all 0.15s',
      }}
    >
      {children}
    </Box>
  );
}

function StatusChip({ label, color }) {
  return <Chip label={label} size="small" color={color === 'default' ? undefined : color} variant={color === 'default' ? 'outlined' : 'filled'} sx={{ height: 20, fontSize: 10, fontWeight: 700 }} />;
}

function TileButton({ icon, label, color, onClick }) {
  return (
    <Button
      size="small"
      onClick={onClick}
      startIcon={icon}
      sx={{
        flex: 1,
        fontSize: 11,
        textTransform: 'none',
        color,
        borderColor: alpha(color, 0.3),
        bgcolor: alpha(color, 0.06),
        '&:hover': { bgcolor: alpha(color, 0.12) },
        justifyContent: 'flex-start',
        px: 1,
      }}
      variant="outlined"
    >
      {label}
    </Button>
  );
}

function EmptyState({ text }) {
  return (
    <Box sx={{ textAlign: 'center', p: 3 }}>
      <Typography color="text.secondary" variant="body2">{text}</Typography>
    </Box>
  );
}
