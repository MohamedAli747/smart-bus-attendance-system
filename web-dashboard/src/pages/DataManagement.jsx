import React, { useState, useEffect } from 'react';
import {
  collection,
  onSnapshot,
  doc,
  deleteDoc,
  addDoc,
  updateDoc,
  setDoc,
  getDoc,
  getDocs,
} from 'firebase/firestore';
import { storage } from '../firebase';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db } from '../firebase';
import {
  Box,
  Typography,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  IconButton,
  Button,
  Modal,
  TextField,
  FormControlLabel,
  Checkbox,
  Grid,
  Chip,
  CircularProgress,
  Alert,
  Snackbar,
  Card,
  CardContent,
  Tooltip,
  Avatar,
  alpha,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Close as CloseIcon,
  Save as SaveIcon,
  People as PeopleIcon,
  DirectionsBus as BusIcon,
  Person as PersonIcon,
  EventNote as PlanningIcon,
  Face as FaceIcon,
  FileDownload as DownloadIcon,
} from '@mui/icons-material';

// ==================== Constants & Configurations ====================

const EMPLOYEE_COLUMNS = ['horaire', 'nom', 'prenom', 'cin', 'circuit_id', 'dep', 'poste', 'active'];
const EMPLOYEE_COLUMN_LABELS = {
  horaire: 'Schedule',
  nom: 'Last Name',
  prenom: 'First Name',
  cin: 'CIN',
  circuit_id: 'Circuit',
  dep: 'Coordinates',
  poste: 'Position',
  active: 'Active',
};

const BUS_COLUMNS = ['modele', 'circuit_id', 'type_veh_2', 'type', 'site_exploitation', 'conducteur_id', 'marque', 'status'];
const BUS_COLUMN_LABELS = {
  modele: 'Model',
  circuit_id: 'Circuit ID',
  type_veh_2: 'Vehicle Type 2',
  type: 'Type',
  site_exploitation: 'Site',
  conducteur_id: 'Driver ID',
  marque: 'Brand',
  status: 'Status',
};

const CONDUCTEUR_COLUMNS = ['nom', 'role', 'dep', 'login', 'type_chauffeur', 'bus_id', 'sous_dep1', 'sous_dep2', 'roulement', 'actif', 'horaire'];
const CONDUCTEUR_COLUMN_LABELS = {
  nom: 'Name',
  role: 'Role',
  dep: 'Department',
  login: 'Login',
  type_chauffeur: 'Driver Type',
  bus_id: 'Bus ID',
  sous_dep1: 'Sub Dept 1',
  sous_dep2: 'Sub Dept 2',
  roulement: 'Rotation',
  actif: 'Active',
  horaire: 'Schedule',
};

const PLANNING_COLUMNS = ['h_arrivee', 'h_depart', 'sens', 'trajet', 'conducteur_id', 'bus_id', 'circuit_id'];
const PLANNING_COLUMN_LABELS = {
  h_arrivee: 'Arrival Time',
  h_depart: 'Departure Time',
  sens: 'Direction',
  trajet: 'Route',
  conducteur_id: 'Driver ID',
  bus_id: 'Bus ID',
  circuit_id: 'Circuit ID',
};

// Firestore `face_enrollments` document fields (as in screenshot):
// matricule, enrolled, embedding_model, embedding_dim, embedding, updated_at
const FACE_ENROLLMENTS_COLUMNS = ['matricule', 'enrolled', 'embedding_model', 'embedding_dim', 'embedding', 'updated_at'];
const FACE_ENROLLMENTS_COLUMN_LABELS = {
  matricule: 'Matricule',
  enrolled: 'Enrolled',
  embedding_model: 'Embedding Model',
  embedding_dim: 'Embedding Dim',
  embedding: 'Embedding (vector)',
  updated_at: 'Updated At',
};

const FIXED_COLUMNS_BY_COLLECTION = {
  salaries: { columns: EMPLOYEE_COLUMNS, labels: EMPLOYEE_COLUMN_LABELS, icon: PeopleIcon, color: '#4caf50' },
  buses: { columns: BUS_COLUMNS, labels: BUS_COLUMN_LABELS, icon: BusIcon, color: '#2196f3' },
  conducteurs: { columns: CONDUCTEUR_COLUMNS, labels: CONDUCTEUR_COLUMN_LABELS, icon: PersonIcon, color: '#ff9800' },
  planning: { columns: PLANNING_COLUMNS, labels: PLANNING_COLUMN_LABELS, icon: PlanningIcon, color: '#9c27b0' },
  face_enrollments: { columns: FACE_ENROLLMENTS_COLUMNS, labels: FACE_ENROLLMENTS_COLUMN_LABELS, icon: FaceIcon, color: '#8e24aa' },
};

const DOC_ID_REF_BY_COLLECTION = {
  salaries: { field: 'matricule', label: 'Matricule' },
  conducteurs: { field: 'matricule', label: 'Matricule' },
  circuits: { field: 'code', label: 'Code' },
  planning: { field: 'code', label: 'Code' },
  buses: { field: 'immatriculation', label: 'Registration' },
  face_enrollments: { field: 'matricule', label: 'Matricule' },
};

// ==================== Utility Functions ====================

const getDepCoords = (dep) => {
  if (!dep || typeof dep !== 'object') return { latitude: '', longitude: '' };
  return {
    latitude: dep.latitude ?? dep.altitude ?? dep.lat ?? '',
    longitude: dep.longitude ?? dep.langitude ?? dep.lng ?? dep.lon ?? '',
  };
};

const formatDepValue = (dep) => {
  const { latitude, longitude } = getDepCoords(dep);
  if (latitude === '' && longitude === '') return '';
  return `${latitude}, ${longitude}`;
};

const getEmployeeValue = (row, col) => {
  if (col === 'horaire') return row.horaire ?? row.bus_id;
  if (col === 'dep') return formatDepValue(row.dep);
  return row[col];
};

const getBusValue = (row, col) => {
  if (col === 'type_veh_2') return row.type_veh_2 ?? row.type_veh2 ?? row['type veh 2'];
  return row[col];
};

const formatCellValue = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') {
    if (value.name != null) return String(value.name);
    if (value.label != null) return String(value.label);
    if (value.id != null) return String(value.id);
    return Object.values(value).filter(v => v != null && typeof v !== 'object').join(', ');
  }
  return String(value);
};

const isSalarieField = (key) => {
  const n = key.toLowerCase().replace(/[_\s-]/g, '');
  return n === 'salarie' || n === 'salaire' || n.includes('salarieid') || n.includes('salaireid');
};

const stripSalarieFields = (payload) => {
  const cleaned = { ...payload };
  Object.keys(cleaned).forEach(key => { if (isSalarieField(key)) delete cleaned[key]; });
  return cleaned;
};

const buildEmployeePayload = (data) => {
  const payload = stripSalarieFields({ ...data });
  const { latitude, longitude } = getDepCoords(payload.dep);
  if (latitude !== '' && longitude !== '') {
    payload.dep = { latitude: Number(latitude) || latitude, longitude: Number(longitude) || longitude };
  } else {
    delete payload.dep;
  }
  return payload;
};

// ==================== Main Component ====================

export default function DataManagement({ collectionName, title }) {
  const isEmployees = collectionName === 'salaries';
  const isBuses = collectionName === 'buses';
  const collectionConfig = FIXED_COLUMNS_BY_COLLECTION[collectionName];
  const docIdRef = DOC_ID_REF_BY_COLLECTION[collectionName] ?? null;
  
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [formData, setFormData] = useState({});
  const [snackbar, setSnackbar] = useState({
    open: false,
    message: '',
    severity: 'success',
  });
  const [file, setFile] = useState(null);
  const [employeeOptions, setEmployeeOptions] = useState([]);

  useEffect(() => {
    if (!db) {
      setLoading(false);
      setData([]);
      return;
    }

    setLoading(true);
    const colRef = collection(db, collectionName);
    const unsubscribe = onSnapshot(colRef, (snapshot) => {
      const docs = snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
      setData(docs);
      setLoading(false);
    }, (error) => {
      setSnackbar({ open: true, message: `Error loading data: ${error.message}`, severity: 'error' });
      setLoading(false);
    });

    return () => unsubscribe();
  }, [collectionName]);

  const handleDelete = async (id) => {
    if (!db) return;
    if (window.confirm('Are you sure you want to delete this record?')) {
      try {
        await deleteDoc(doc(db, collectionName, id));
        setSnackbar({ open: true, message: 'Record deleted successfully', severity: 'success' });
      } catch (err) {
        setSnackbar({ open: true, message: `Error deleting: ${err.message}`, severity: 'error' });
      }
    }
  };

  const handleEdit = (item) => {
    setEditingItem(item);
    setFormData(isEmployees ? stripSalarieFields(item) : { ...item });
    setModalOpen(true);
  };

  const handleAdd = () => {
    setEditingItem(null);
    setFormData({});
    setFile(null);
    // Preload employee list for matricule selection when adding face_enrollments
    if (collectionName === 'face_enrollments') {
      (async () => {
        try {
          const docs = await getDocs(collection(db, 'salaries'));
          const opts = docs.docs.map(d => ({ id: d.id, ...d.data() }));
          setEmployeeOptions(opts);
        } catch (e) {
          console.error('Failed to load salaries for matricule selector', e);
        }
      })();
    }
    setModalOpen(true);
  };

  const validateDocId = (value, label) => {
    const id = String(value || '').trim();
    if (!id) {
      setSnackbar({ open: true, message: `${label} is required.`, severity: 'error' });
      return null;
    }
    if (id.includes('/')) {
      setSnackbar({ open: true, message: `${label} cannot contain "/".`, severity: 'error' });
      return null;
    }
    return id;
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!db) return;

    try {
      let payload = isEmployees ? buildEmployeePayload(formData) : { ...formData };

      // Special handling for face_enrollments: upload photo (if provided) and set enrolled flag
      if (collectionName === 'face_enrollments') {
        payload.enrolled = true;
        // If a file was selected, upload to Firebase Storage
        if (file && storage) {
          const ts = Date.now();
          const matricule = payload.matricule || formData.matricule || 'unknown';
          const path = `face_enrollments/${matricule}/${ts}_${file.name}`;
          const sref = storageRef(storage, path);
          const snapshot = await uploadBytes(sref, file);
          const url = await getDownloadURL(snapshot.ref);
          payload.photo_url = url;
        }
      }

      if (editingItem) {
        await updateDoc(doc(db, collectionName, editingItem.id), payload);
        setSnackbar({ open: true, message: 'Record updated successfully', severity: 'success' });
      } else if (docIdRef) {
        const refValue = payload[docIdRef.field] || payload[docIdRef.field.toUpperCase()];
        const docId = validateDocId(refValue, docIdRef.label);
        if (!docId) return;

        const docRef = doc(db, collectionName, docId);
        const existing = await getDoc(docRef);
        if (existing.exists()) {
          setSnackbar({ open: true, message: `A record with ${docIdRef.label} "${docId}" already exists.`, severity: 'error' });
          return;
        }

        const docPayload = { ...payload, [docIdRef.field]: docId };
        await setDoc(docRef, docPayload);
        setSnackbar({ open: true, message: 'Record added successfully', severity: 'success' });
      } else {
        await addDoc(collection(db, collectionName), payload);
        setSnackbar({ open: true, message: 'Record added successfully', severity: 'success' });
      }
      setModalOpen(false);
      setFormData({});
      setEditingItem(null);
      setFile(null);
    } catch (err) {
      setSnackbar({ open: true, message: `Error saving: ${err.message}`, severity: 'error' });
    }
  };

  const handleInputChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleFileChange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) setFile(f);
  };

  const handleDepCoordChange = (field, value) => {
    setFormData(prev => ({
      ...prev,
      dep: { ...(prev.dep && typeof prev.dep === 'object' ? prev.dep : {}), [field]: value },
    }));
  };

  const columns = collectionConfig
    ? (docIdRef ? collectionConfig.columns.filter(k => k !== docIdRef.field) : collectionConfig.columns)
    : data.length > 0
    ? Object.keys(data[0]).filter(k => k !== 'id' && k !== 'face_encoding' && !(docIdRef && k === docIdRef.field))
    : [];

  const getHeaderValue = (key) => collectionConfig?.labels[key] || key;
  const getRowCellValue = (row, col) => {
    if (isEmployees) return getEmployeeValue(row, col);
    if (isBuses) return getBusValue(row, col);
    return row[col];
  };

  const getRefDisplayValue = (row) => {
    if (!docIdRef) return row.id;
    if (docIdRef.field === 'code') return row.code ?? row.CODE ?? row.id;
    if (docIdRef.field === 'immatriculation') return row.immatriculation ?? row.IMMATRICULATION ?? row.id;
    return row[docIdRef.field] ?? row.id;
  };

  const IconComponent = collectionConfig?.icon;

  // Export current data to CSV
  const handleExportCsv = () => {
    if (!data || data.length === 0) {
      setSnackbar({ open: true, message: 'No data to export', severity: 'info' });
      return;
    }
    // Build a consistent set of columns across all rows, flattening one level of nested objects.
    const unionCols = new Set();
    data.forEach((row) => {
      Object.keys(row).forEach((k) => {
        if (k === 'id') return;
        // skip document id field from union columns to avoid duplication
        if (docIdRef && k === docIdRef.field) return;
        const v = row[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          Object.keys(v).forEach((sub) => unionCols.add(`${k}.${sub}`));
        } else {
          unionCols.add(k);
        }
      });
    });

    // Prefer explicit configured column order for the collection (keeps desired ordering for planning)
    let exportCols = [];
    if (collectionConfig && collectionConfig.columns && collectionConfig.columns.length > 0) {
      collectionConfig.columns.forEach((col) => {
        const sample = data.find((r) => r && r[col]);
        if (sample && sample[col] && typeof sample[col] === 'object' && !Array.isArray(sample[col])) {
          Object.keys(sample[col]).forEach((sub) => exportCols.push(`${col}.${sub}`));
        } else {
          exportCols.push(col);
        }
      });
      // Do not append other discovered columns for configured collections to keep strict column order
    } else {
      exportCols = Array.from(unionCols);
    }

    // Always include the document id first
    const docIdLabel = docIdRef ? docIdRef.label : 'id';
    const headerLabels = [
      docIdLabel,
      ...exportCols.map((c) => {
        if (c.includes('.')) {
          const [parent, child] = c.split('.')
          const parentLabel = collectionConfig?.labels?.[parent] || getHeaderValue(parent) || parent
          return `${parentLabel}.${child}`
        }
        return collectionConfig?.labels?.[c] || getHeaderValue(c) || c
      })
    ];

    const rows = data.map((row) => exportCols.map((col) => {
      if (col.includes('.')) {
        const [parent, child] = col.split('.')
        const val = row[parent] && typeof row[parent] === 'object' ? row[parent][child] : undefined
        return formatCellValue(val).replace(/\n/g, ' ')
      }
      // prefer helper to format known collections
      const raw = getRowCellValue(row, col)
      return formatCellValue(raw).replace(/\n/g, ' ')
    }));

    // Build CSV string
    const csvLines = [];
    csvLines.push(headerLabels.map(h => `"${String(h).replace(/"/g, '""')}"`).join(','));
    rows.forEach((r, idx) => {
      const idCell = `"${String(getRefDisplayValue(data[idx]) || data[idx].id).replace(/"/g, '""')}"`;
      const rowCells = r.map(cell => `"${String(cell || '').replace(/"/g, '""')}"`).join(',');
      csvLines.push([idCell, rowCells].join(','));
    });

    const csvContent = csvLines.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const filename = `${collectionName || 'export'}_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setSnackbar({ open: true, message: `Exported ${rows.length} rows to ${filename}`, severity: 'success' });
  };

  return (
    <Box sx={{ p: 3, bgcolor: '#f5f7fb', minHeight: '100vh' }}>
      {/* Header Card */}
      <Card
        elevation={0}
        sx={{
          mb: 4,
          borderRadius: 4,
          background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
          border: '1px solid',
          borderColor: 'divider',
        }}
      >
        <CardContent sx={{ p: 3, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Avatar
              sx={{
                bgcolor: alpha(collectionConfig?.color || '#1976d2', 0.1),
                color: collectionConfig?.color || '#1976d2',
                width: 56,
                height: 56,
                borderRadius: 3,
              }}
            >
              {IconComponent && <IconComponent />}
            </Avatar>
            <Box>
              <Typography variant="h4" fontWeight={700} color="text.primary">
                {title} Management
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Manage {collectionName} records in Firestore • {data.length} total records
              </Typography>
            </Box>
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              variant="outlined"
              startIcon={<DownloadIcon />}
              onClick={handleExportCsv}
              sx={{ borderRadius: 3, px: 2, textTransform: 'none' }}
            >
              Export CSV
            </Button>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={handleAdd}
              sx={{
                borderRadius: 3,
                px: 3,
                py: 1,
                textTransform: 'none',
                fontWeight: 600,
                boxShadow: 'none',
                '&:hover': { boxShadow: '0 4px 12px rgba(0,0,0,0.1)' },
              }}
            >
              Add New
            </Button>
          </Box>
        </CardContent>
      </Card>

      {/* Table Card */}
      <Paper
        elevation={0}
        sx={{
          borderRadius: 4,
          overflow: 'hidden',
          border: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <TableContainer sx={{ maxHeight: 'calc(100vh - 280px)' }}>
          {!db ? (
            <Alert severity="error" sx={{ m: 3 }}>Firestore database failed to initialize. Please check your configuration.</Alert>
          ) : loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 8 }}>
              <CircularProgress />
            </Box>
          ) : data.length === 0 ? (
            <Box sx={{ textAlign: 'center', p: 8 }}>
              <Typography color="text.secondary">No records found. Click "Add New" to create one.</Typography>
            </Box>
          ) : (
            <Table stickyHeader>
              <TableHead>
                <TableRow sx={{ bgcolor: '#f8fafc' }}>
                  <TableCell sx={{ fontWeight: 700, bgcolor: '#f8fafc' }}>
                    {docIdRef ? docIdRef.label : 'ID'}
                  </TableCell>
                  {columns.map((col) => (
                    <TableCell key={col} sx={{ fontWeight: 700, bgcolor: '#f8fafc' }}>
                      {getHeaderValue(col)}
                    </TableCell>
                  ))}
                  <TableCell align="right" sx={{ fontWeight: 700, bgcolor: '#f8fafc' }}>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.map((row) => (
                  <TableRow
                    key={row.id}
                    sx={{
                      '&:hover': { bgcolor: '#fafcff' },
                      transition: 'background-color 0.2s',
                    }}
                  >
                    <TableCell>
                      <Chip
                        label={getRefDisplayValue(row)}
                        size="small"
                        sx={{ fontFamily: 'monospace', fontWeight: 500, bgcolor: alpha('#1976d2', 0.08) }}
                      />
                    </TableCell>
                    {columns.map((col) => (
                      <TableCell key={col}>
                        <Typography variant="body2" sx={{ maxWidth: 250, wordBreak: 'break-word' }}>
                          {formatCellValue(getRowCellValue(row, col))}
                        </Typography>
                      </TableCell>
                    ))}
                    <TableCell align="right">
                      <Tooltip title="Edit">
                        <IconButton onClick={() => handleEdit(row)} size="small" sx={{ color: '#1976d2' }}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete">
                        <IconButton onClick={() => handleDelete(row.id)} size="small" sx={{ color: '#d32f2f' }}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TableContainer>
      </Paper>

      {/* Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} closeAfterTransition>
        <Box
          sx={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: { xs: '95%', sm: 600, md: 700 },
            maxHeight: '90vh',
            overflow: 'auto',
            bgcolor: 'background.paper',
            borderRadius: 4,
            boxShadow: 24,
            p: 0,
          }}
        >
          <Box sx={{ p: 3, borderBottom: '1px solid', borderColor: 'divider', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography variant="h6" fontWeight={700}>
              {editingItem ? 'Edit Record' : 'Add New Record'}
            </Typography>
            <IconButton onClick={() => setModalOpen(false)}>
              <CloseIcon />
            </IconButton>
          </Box>
          <form onSubmit={handleSave}>
            <Box sx={{ p: 3 }}>
              <Grid container spacing={2.5}>
                {isEmployees ? (
                  <>
                    <Grid item xs={12}>
                        {collectionName === 'face_enrollments' ? (
                          <>
                            <TextField
                              select
                              fullWidth
                              label="Matricule *"
                              name="matricule"
                              value={formData.matricule || ''}
                              onChange={handleInputChange}
                              required
                              size="small"
                              SelectProps={{ native: true }}
                            >
                              <option value="">Select matricule</option>
                              {employeeOptions.map(emp => (
                                <option key={emp.matricule || emp.id} value={emp.matricule || emp.id}>
                                  {`${emp.matricule || emp.id} - ${emp.nom || emp.name || ''}`}
                                </option>
                              ))}
                            </TextField>

                            <Box sx={{ mt: 2 }}>
                              <input type="file" accept="image/*" onChange={handleFileChange} />
                              {file && <Typography variant="caption">Selected: {file.name}</Typography>}
                            </Box>
                          </>
                        ) : (
                          <TextField
                            fullWidth
                            label="Matricule *"
                            name="matricule"
                            value={formData.matricule || ''}
                            onChange={handleInputChange}
                            required
                            disabled={!!editingItem}
                            size="small"
                            helperText={editingItem ? "Matricule is the document ID and cannot be changed" : ""}
                          />
                        )}
                    </Grid>
                    {EMPLOYEE_COLUMNS.map((col) => (
                      <Grid item xs={12} sm={col === 'dep' ? 12 : 6} key={col}>
                        {col === 'active' ? (
                          <FormControlLabel
                            control={
                              <Checkbox
                                name="active"
                                checked={formData.active === true || formData.active === 'true' || formData.active === 1}
                                onChange={handleInputChange}
                              />
                            }
                            label="Active"
                          />
                        ) : col === 'dep' ? (
                          <Box>
                            <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
                              Coordinates (Latitude, Longitude)
                            </Typography>
                            <Box sx={{ display: 'flex', gap: 2 }}>
                              <TextField
                                fullWidth
                                label="Latitude"
                                type="number"
                                value={getDepCoords(formData.dep).latitude}
                                onChange={(e) => handleDepCoordChange('latitude', e.target.value)}
                                size="small"
                              />
                              <TextField
                                fullWidth
                                label="Longitude"
                                type="number"
                                value={getDepCoords(formData.dep).longitude}
                                onChange={(e) => handleDepCoordChange('longitude', e.target.value)}
                                size="small"
                              />
                            </Box>
                          </Box>
                        ) : (
                          <TextField
                            fullWidth
                            label={getHeaderValue(col)}
                            name={col === 'horaire' ? 'bus_id' : col}
                            value={formData[col === 'horaire' ? 'bus_id' : col] || ''}
                            onChange={handleInputChange}
                            required={col === 'nom'}
                            size="small"
                          />
                        )}
                      </Grid>
                    ))}
                  </>
                ) : (
                  <>
                    {docIdRef && (
                      <Grid item xs={12}>
                        <TextField
                          fullWidth
                          label={`${docIdRef.label} *`}
                          name={docIdRef.field}
                          value={formData[docIdRef.field] || formData[docIdRef.field?.toUpperCase()] || ''}
                          onChange={handleInputChange}
                          required
                          disabled={!!editingItem}
                          helperText={editingItem ? `${docIdRef.label} is the document ID and cannot be changed` : ""}
                          size="small"
                        />
                      </Grid>
                    )}
                    {columns.map((col) => (
                      <Grid item xs={12} sm={6} key={col}>
                        {(collectionName === 'conducteurs' && col === 'actif') || (collectionName === 'salaries' && col === 'active') ? (
                          <FormControlLabel
                            control={
                              <Checkbox
                                name={col}
                                checked={formData[col] === true || formData[col] === 'true' || formData[col] === 1}
                                onChange={handleInputChange}
                              />
                            }
                            label={getHeaderValue(col)}
                          />
                        ) : (
                          <TextField
                            fullWidth
                            label={getHeaderValue(col)}
                            name={col}
                            type={col === 'roulement' ? 'number' : 'text'}
                            value={formData[col] || ''}
                            onChange={handleInputChange}
                            size="small"
                          />
                        )}
                      </Grid>
                    ))}
                  </>
                )}
              </Grid>
            </Box>
            <Box sx={{ p: 3, borderTop: '1px solid', borderColor: 'divider', display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
              <Button variant="outlined" onClick={() => setModalOpen(false)} sx={{ borderRadius: 2, textTransform: 'none' }}>
                Cancel
              </Button>
              <Button type="submit" variant="contained" startIcon={<SaveIcon />} sx={{ borderRadius: 2, textTransform: 'none' }}>
                {editingItem ? 'Update' : 'Add'}
              </Button>
            </Box>
          </form>
        </Box>
      </Modal>

      {/* Snackbar */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={() => setSnackbar(prev => ({ ...prev, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setSnackbar(prev => ({ ...prev, open: false }))} severity={snackbar.severity} sx={{ width: '100%', borderRadius: 2 }}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}