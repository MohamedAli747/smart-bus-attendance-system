import React, { useState, useEffect, useRef } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Typography,
  TextField,
  CircularProgress,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  LinearProgress,
  Chip,
  Grid,
  Tabs,
  Tab,
} from '@mui/material';
import { Camera, Check, X, AlertCircle, Upload } from 'lucide-react';
import * as faceapi from 'face-api.js';
import * as tf from '@tensorflow/tfjs';
import * as tflite from '@tensorflow/tfjs-tflite';
import { collection, getDocs, setDoc, doc } from 'firebase/firestore';
import { db } from '../firebase';

const FACE_API_MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model/';
const TFLITE_MODEL_URL = '/models/w600k_mbf.tflite';
const TFLITE_WASM_PATH = '/tflite-wasm/';
const MODEL_INPUT_SIZE = [112, 112];
const EMBEDDING_DIM = 512;
const NUM_SAMPLES = 10; // Match Pi script
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_DETECTION_DIMENSION = 1280;
const SSD_MOBILENET_OPTIONS = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5, maxResults: 5 });

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read the image file.'));
    img.src = src;
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read the selected file.'));
    reader.readAsDataURL(file);
  });
}

function createScaledCanvas(img, maxDimension = MAX_DETECTION_DIMENSION) {
  let { width, height } = img;
  if (width > maxDimension || height > maxDimension) {
    const scale = maxDimension / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);
  return canvas;
}

function cropFaceCanvas(sourceCanvas, box, padding = 0.15) {
  const padX = box.width * padding;
  const padY = box.height * padding;
  const x = Math.max(0, box.x - padX);
  const y = Math.max(0, box.y - padY);
  const w = Math.min(sourceCanvas.width - x, box.width + padX * 2);
  const h = Math.min(sourceCanvas.height - y, box.height + padY * 2);

  const faceCanvas = document.createElement('canvas');
  faceCanvas.width = w;
  faceCanvas.height = h;
  faceCanvas.getContext('2d').drawImage(sourceCanvas, x, y, w, h, 0, 0, w, h);
  return faceCanvas;
}

export default function FaceEnrollment() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const interpreterRef = useRef(null);
  const capturingRef = useRef(false);

  const [employees, setEmployees] = useState([]);
  const [selectedMatricule, setSelectedMatricule] = useState('');
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [loading, setLoading] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [samples, setSamples] = useState([]);
  const [capturing, setCapturing] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [tabMode, setTabMode] = useState('webcam');
  const [uploadedFile, setUploadedFile] = useState(null);
  const [uploadedImage, setUploadedImage] = useState(null);
  const [uploadEmbedding, setUploadEmbedding] = useState(null);
  const [uploadProcessing, setUploadProcessing] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Load face-api and TFLite model
  useEffect(() => {
  const loadModels = async () => {
    try {
      setStatus('Loading face detection models...');
      
      // 1. Load face-api.js models
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri(FACE_API_MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(FACE_API_MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(FACE_API_MODEL_URL),
        faceapi.nets.faceExpressionNet.loadFromUri(FACE_API_MODEL_URL),
      ]);

      setStatus('Downloading TFLite embedding model...');
      tflite.setWasmPath(TFLITE_WASM_PATH);
      const session = await tflite.loadTFLiteModel(TFLITE_MODEL_URL);
      interpreterRef.current = session;
      setModelsLoaded(true);
      setStatus('Models loaded successfully');
    } catch (err) {
      console.error('Model loading error:', err);
      setError(`Failed to load models: ${err.message}`);
      setStatus('');
    }
  };

  loadModels();

  return () => {
    if (interpreterRef.current) {
      interpreterRef.current.release();
    }
  };
}, []);

  // Load employees on mount
  useEffect(() => {
    const loadEmployees = async () => {
      try {
        const docs = await getDocs(collection(db, 'salaries'));
        const emps = docs.docs.map(d => ({ id: d.id, ...d.data() }));
        setEmployees(emps);
      } catch (err) {
        setError(`Failed to load employees: ${err.message}`);
      }
    };

    loadEmployees();
  }, []);

  // Update selected employee when matricule changes
  useEffect(() => {
    if (selectedMatricule) {
      const emp = employees.find(e => e.matricule === selectedMatricule);
      setSelectedEmployee(emp || null);
    } else {
      setSelectedEmployee(null);
    }
  }, [selectedMatricule, employees]);

  const startCamera = async () => {
    try {
      setError('');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setCameraActive(true);
        setStatus('Camera started');
        await videoRef.current.play().catch(err => {
          console.error('Video play error:', err);
          setError(`Video play error: ${err.message}`);
        });
      }
    } catch (err) {
      setError(`Camera access denied: ${err.message}`);
    }
  };

  const stopCamera = () => {
    capturingRef.current = false; // stop any running capture loop
    if (videoRef.current && videoRef.current.srcObject) {
      videoRef.current.srcObject.getTracks().forEach(track => track.stop());
      setCameraActive(false);
      setCapturing(false);
      setStatus('');
    }
  };

  // Extract 512-dim embedding using w600k_mbf TFLite (NHWC [1, 112, 112, 3])
  const getEmbedding = async (faceCanvas) => {
    if (!interpreterRef.current) {
      throw new Error('TFLite model is not initialized.');
    }

    const inputCanvas = document.createElement('canvas');
    inputCanvas.width = MODEL_INPUT_SIZE[0];
    inputCanvas.height = MODEL_INPUT_SIZE[1];
    const inputCtx = inputCanvas.getContext('2d');
    inputCtx.drawImage(faceCanvas, 0, 0, MODEL_INPUT_SIZE[0], MODEL_INPUT_SIZE[1]);

    const imageData = inputCtx.getImageData(0, 0, MODEL_INPUT_SIZE[0], MODEL_INPUT_SIZE[1]);
    const { data } = imageData;
    const input = new Float32Array(MODEL_INPUT_SIZE[0] * MODEL_INPUT_SIZE[1] * 3);

    for (let i = 0; i < MODEL_INPUT_SIZE[0] * MODEL_INPUT_SIZE[1]; i++) {
      const idx = i * 4;
      input[i * 3]     = (data[idx]     - 127.5) / 128.0; // R
      input[i * 3 + 1] = (data[idx + 1] - 127.5) / 128.0; // G
      input[i * 3 + 2] = (data[idx + 2] - 127.5) / 128.0; // B
    }

    const inputTensor = tf.tensor4d(input, [1, MODEL_INPUT_SIZE[1], MODEL_INPUT_SIZE[0], 3], 'float32');
    const output = await interpreterRef.current.predict(inputTensor);

    let outputTensor;
    if (Array.isArray(output)) {
      outputTensor = output[0];
    } else if (output instanceof tf.Tensor) {
      outputTensor = output;
    } else if (typeof output === 'object' && output !== null) {
      outputTensor = Object.values(output)[0];
    } else {
      throw new Error('Unexpected TFLite model output format');
    }

    const embeddingArray = Array.from(await outputTensor.data());
    inputTensor.dispose();
    outputTensor.dispose();

    if (embeddingArray.length !== EMBEDDING_DIM) {
      throw new Error(`Expected ${EMBEDDING_DIM}-dim embedding, got ${embeddingArray.length}`);
    }

    const norm = Math.sqrt(embeddingArray.reduce((sum, val) => sum + val * val, 0));
    if (norm === 0) {
      throw new Error('Calculated zero norm for embedding vector');
    }

    return embeddingArray.map(val => val / norm);
  };

  const captureFrame = async () => {
    if (!videoRef.current || !canvasRef.current) return null;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;

    ctx.drawImage(videoRef.current, 0, 0);

    try {
      // Detect face with face-api
      const detections = await faceapi
        .detectAllFaces(canvas, SSD_MOBILENET_OPTIONS)
        .withFaceLandmarks()
        .withFaceDescriptors();

      if (detections.length === 0) {
        return null;
      }

      if (detections.length > 1) {
        setError('Multiple faces detected. Please ensure only one person is in frame.');
        return null;
      }

      // Extract face region
      const detection = detections[0];
      const box = detection.detection.box;
      const [x, y, w, h] = [box.x, box.y, box.width, box.height];

      // Create face canvas
      const faceCanvas = document.createElement('canvas');
      faceCanvas.width = w;
      faceCanvas.height = h;
      const faceCtx = faceCanvas.getContext('2d');
      faceCtx.drawImage(canvas, x, y, w, h, 0, 0, w, h);

      // Get embedding using MobileFaceNet
      const embedding = await getEmbedding(faceCanvas);

      return embedding;
    } catch (err) {
      console.error('Error detecting face:', err);
      setError(`Detection error: ${err.message}`);
      return null;
    }
  };

  const captureSamples = async () => {
    if (!selectedMatricule || !cameraActive || !modelsLoaded) {
      setError('Please select a matricule and start the camera');
      return;
    }

    capturingRef.current = true;
    setCapturing(true);
    setError('');
    setSamples([]);
    const newSamples = [];
    const captureInterval = 800; // 800ms between captures (faster than Pi)

    setStatus(`Capturing ${NUM_SAMPLES} samples. Look at the camera...`);

    let consecutiveStable = 0;
    const requiredStable = 2;

    while (newSamples.length < NUM_SAMPLES && capturingRef.current) {
      const descriptor = await captureFrame();

      if (descriptor) {
        consecutiveStable += 1;
        if (consecutiveStable >= requiredStable) {
          newSamples.push(descriptor);
          setSamples([...newSamples]);
          setStatus(
            `Captured ${newSamples.length}/${NUM_SAMPLES} samples. Keep steady...`
          );
          consecutiveStable = 0;
          await new Promise(resolve => setTimeout(resolve, captureInterval));
        }
      } else {
        consecutiveStable = 0;
        setStatus('No face detected. Please look at the camera...');
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (newSamples.length >= NUM_SAMPLES) {
      setStatus('✅ All samples captured! Review and save.');
      setSaveDialogOpen(true);
    } else if (newSamples.length > 0) {
      setError(`Only captured ${newSamples.length}/${NUM_SAMPLES} samples. Try again.`);
    }

    capturingRef.current = false;
    setCapturing(false);
  };

  const clearUploadState = () => {
    setUploadedFile(null);
    setUploadedImage(null);
    setUploadEmbedding(null);
    setUploadProcessing(false);
  };

  const processImageFile = async (file) => {
    if (!modelsLoaded) {
      setError('Models are still loading. Please wait.');
      return;
    }

    if (!file.type.startsWith('image/')) {
      setError('Please upload an image file (PNG, JPG, etc.).');
      return;
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      setError('Image is too large. Maximum size is 5 MB.');
      return;
    }

    clearUploadState();
    setError('');
    setStatus('Processing image...');
    setUploadedFile(file);
    setUploadProcessing(true);

    try {
      const dataUrl = await readFileAsDataUrl(file);
      const img = await loadImageElement(dataUrl);
      setUploadedImage(img);

      const detectionCanvas = createScaledCanvas(img);
      const detections = await faceapi.detectAllFaces(
        detectionCanvas,
        SSD_MOBILENET_OPTIONS
      );

      if (detections.length === 0) {
        throw new Error('No face detected in the uploaded image. Try a clearer front-facing photo.');
      }

      if (detections.length > 1) {
        throw new Error('Multiple faces detected. Please upload an image with only one face.');
      }

      const faceCanvas = cropFaceCanvas(detectionCanvas, detections[0].box);
      const embedding = await getEmbedding(faceCanvas);

      setUploadEmbedding(embedding);
      setStatus('✓ Face detected in image');
    } catch (err) {
      console.error('Error processing image:', err);
      setError(`Error processing image: ${err.message}`);
      clearUploadState();
      setStatus('');
    } finally {
      setUploadProcessing(false);
    }
  };

  const handleFileUpload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await processImageFile(file);
  };

  const handleDragOver = (event) => {
    event.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const handleDrop = async (event) => {
    event.preventDefault();
    setDragOver(false);
    const file = event.dataTransfer.files?.[0];
    if (file) {
      await processImageFile(file);
    }
  };

  const saveEnrollment = async () => {
    if (!selectedMatricule) {
      setError('Please select a matricule');
      return;
    }

    let embeddingToSave;

    if (tabMode === 'webcam') {
      if (samples.length === 0) {
        setError('No samples to save');
        return;
      }

      // Average the descriptors from webcam
      const avgDescriptor = samples[0].map((_, idx) =>
        samples.reduce((sum, sample) => sum + sample[idx], 0) / samples.length
      );

      // Normalize
      const norm = Math.sqrt(
        avgDescriptor.reduce((sum, val) => sum + val * val, 0)
      );
      embeddingToSave = avgDescriptor.map(val => val / norm);
    } else {
      if (!uploadEmbedding) {
        setError('No embedding extracted from uploaded image');
        return;
      }
      embeddingToSave = uploadEmbedding;
    }

    setLoading(true);
    setError('');

    try {
      // Save to Firestore
      await setDoc(doc(db, 'face_enrollments', selectedMatricule), {
        matricule: selectedMatricule,
        nom: selectedEmployee?.nom || '',
        prenom: selectedEmployee?.prenom || '',
        embedding: embeddingToSave,
        embedding_dim: embeddingToSave.length,
        embedding_model: `Custom TFLite embedding model (${EMBEDDING_DIM}-dim)`,
        enrolled: true,
        updated_at: new Date().toISOString(),
      });

      setSuccess(true);
      setStatus(`✅ Successfully enrolled ${selectedMatricule}`);
      setSaveDialogOpen(false);

      // Reset states
      setSamples([]);
      clearUploadState();
      setSelectedMatricule('');

      setTimeout(() => {
        setSuccess(false);
        setStatus('');
      }, 3000);
    } catch (err) {
      setError(`Failed to save enrollment: ${err.message}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box sx={{ p: 3, maxWidth: 1000, mx: 'auto' }}>
      {/* Header */}
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
        <CardContent sx={{ p: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
            <Camera size={32} color="#8e24aa" />
            <Box>
              <Typography variant="h4" fontWeight={700}>
                Face Enrollment
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Capture face samples via webcam or upload an image (${EMBEDDING_DIM}-dim TFLite embedding model)
              </Typography>
            </Box>
          </Box>
        </CardContent>
      </Card>

      {/* Status Messages */}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 2 }}>{status}</Alert>}
      {status && !error && !success && (
        <Alert severity="info" sx={{ mb: 2 }}>{status}</Alert>
      )}

      {/* Models Status */}
      {!modelsLoaded && (
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <CircularProgress size={24} />
              <Typography>Loading face detection and embedding models...</Typography>
            </Box>
          </CardContent>
        </Card>
      )}

      {modelsLoaded && (
        <Grid container spacing={3}>
          {/* Left: Controls */}
          <Grid item xs={12} sm={5}>
            <Card>
              <CardContent>
                <Typography variant="h6" gutterBottom fontWeight={700}>
                  Enrollment Setup
                </Typography>

                {/* Employee Selection */}
                <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
                  1. Select Employee
                </Typography>
                <TextField
                  select
                  fullWidth
                  label="Matricule"
                  value={selectedMatricule}
                  onChange={(e) => setSelectedMatricule(e.target.value)}
                  size="small"
                  disabled={cameraActive || capturing}
                  SelectProps={{ native: true }}
                >
                  <option value="">Choose matricule...</option>
                  {employees.map(emp => (
                    <option key={emp.matricule || emp.id} value={emp.matricule || emp.id}>
                      {`${emp.matricule || emp.id} - ${emp.prenom || ''} ${emp.nom || ''}`}
                    </option>
                  ))}
                </TextField>

                {selectedEmployee && (
                  <Chip
                    label={`${selectedEmployee.prenom} ${selectedEmployee.nom}`}
                    sx={{ mt: 1 }}
                    color="primary"
                    variant="outlined"
                  />
                )}

                {/* Camera Controls */}
                <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
                  2. {tabMode === 'webcam' ? 'Start Camera' : 'Upload Image'}
                </Typography>
                {tabMode === 'webcam' && (
                  <Box sx={{ display: 'flex', gap: 1 }}>
                    <Button
                      variant="contained"
                      onClick={startCamera}
                      disabled={!selectedMatricule || cameraActive || capturing}
                      fullWidth
                    >
                      Start Camera
                    </Button>
                    <Button
                      variant="outlined"
                      onClick={stopCamera}
                      disabled={!cameraActive}
                      fullWidth
                    >
                      Stop
                    </Button>
                  </Box>
                )}

                {/* Capture Button */}
                <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
                  3. {tabMode === 'webcam' ? 'Capture Samples' : 'Save Enrollment'}
                </Typography>
                {tabMode === 'webcam' ? (
                  <Button
                    variant="contained"
                    onClick={captureSamples}
                    disabled={!cameraActive || !selectedMatricule || capturing || loading}
                    fullWidth
                    color={samples.length > 0 ? 'success' : 'primary'}
                  >
                    {capturing ? (
                      <>
                        <CircularProgress size={20} sx={{ mr: 1 }} />
                        Capturing...
                      </>
                    ) : samples.length > 0 ? (
                      <>
                        <Check size={20} sx={{ mr: 1 }} />
                        Captured {samples.length}/{NUM_SAMPLES}
                      </>
                    ) : (
                      <>
                        <Camera size={20} sx={{ mr: 1 }} />
                        Start Capture
                      </>
                    )}
                  </Button>
                ) : (
                  <Button
                    variant="contained"
                    onClick={() => setSaveDialogOpen(true)}
                    disabled={!uploadEmbedding || !selectedMatricule || loading}
                    fullWidth
                    color={uploadEmbedding ? 'success' : 'primary'}
                  >
                    {uploadEmbedding ? (
                      <>
                        <Check size={20} sx={{ mr: 1 }} />
                        Save Enrollment
                      </>
                    ) : (
                      <>
                        <Upload size={20} sx={{ mr: 1 }} />
                        Upload Image First
                      </>
                    )}
                  </Button>
                )}

                {/* Sample Progress - Webcam Only */}
                {tabMode === 'webcam' && samples.length > 0 && (
                  <Box sx={{ mt: 2 }}>
                    <Typography variant="caption" color="text.secondary">
                      Samples captured: {samples.length}/{NUM_SAMPLES}
                    </Typography>
                    <LinearProgress
                      variant="determinate"
                      value={(samples.length / NUM_SAMPLES) * 100}
                      sx={{ mt: 1 }}
                    />
                  </Box>
                )}

                {/* Model Info */}
                <Box sx={{ mt: 3, p: 2, bgcolor: '#f5f5f5', borderRadius: 1 }}>
                  <Typography variant="caption" color="text.secondary" display="block">
                    🧠 <strong>Model:</strong> Custom TFLite embedding model
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    📊 <strong>Embedding:</strong> {EMBEDDING_DIM}-dimensional vector
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    ✅ <strong>Compatible with:</strong> Pi recognition system
                  </Typography>
                </Box>
              </CardContent>
            </Card>
          </Grid>

          {/* Right: Video Feed / Upload */}
          <Grid item xs={12} sm={7}>
            <Card>
              <CardContent>
                <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
                  <Tabs
                    value={tabMode}
                    onChange={(e, newValue) => {
                      if (newValue === 'upload') {
                        stopCamera();
                      } else {
                        clearUploadState();
                      }
                      setTabMode(newValue);
                    }}
                    disabled={cameraActive || capturing || loading || uploadProcessing}
                  >
                    <Tab label="Webcam Capture" value="webcam" />
                    <Tab label="Upload Image" value="upload" />
                  </Tabs>
                </Box>

                {/* Webcam Mode */}
                {tabMode === 'webcam' && (
                  <Box>
                    <Typography variant="h6" gutterBottom fontWeight={700}>
                      Camera Feed
                    </Typography>
                    <Box
                      sx={{
                        position: 'relative',
                        width: '100%',
                        aspectRatio: '4/3',
                        bgcolor: '#000',
                        borderRadius: 2,
                        overflow: 'hidden',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {/* Always render video so videoRef is available when startCamera assigns the stream */}
                      <video
                        ref={videoRef}
                        autoPlay
                        muted
                        playsInline
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                          display: cameraActive ? 'block' : 'none',
                        }}
                      />
                      {!cameraActive && (
                        <Box sx={{ textAlign: 'center', color: '#999' }}>
                          <Camera size={48} sx={{ mb: 1, opacity: 0.5 }} />
                          <Typography variant="body2">Camera inactive</Typography>
                        </Box>
                      )}
                    </Box>

                    {/* Hidden canvas for face detection */}
                    <canvas ref={canvasRef} style={{ display: 'none' }} />

                    <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
                      ✓ Position your face in the center and keep still while capturing {NUM_SAMPLES} samples
                    </Typography>
                  </Box>
                )}

                {/* Upload Mode */}
                {tabMode === 'upload' && (
                  <Box>
                    <Typography variant="h6" gutterBottom fontWeight={700}>
                      Upload Face Image
                    </Typography>
                    <Box
                      onClick={() => !uploadProcessing && fileInputRef.current?.click()}
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                      onDrop={handleDrop}
                      sx={{
                        position: 'relative',
                        width: '100%',
                        aspectRatio: '4/3',
                        bgcolor: dragOver ? '#eef2ff' : '#f5f5f5',
                        borderRadius: 2,
                        overflow: 'hidden',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: '2px dashed',
                        borderColor: dragOver
                          ? 'primary.main'
                          : uploadedImage
                            ? 'success.main'
                            : 'divider',
                        cursor: uploadProcessing ? 'wait' : 'pointer',
                        transition: 'all 0.3s ease',
                        opacity: uploadProcessing ? 0.85 : 1,
                        '&:hover': {
                          borderColor: 'primary.main',
                          bgcolor: dragOver ? '#eef2ff' : '#fafafa',
                        },
                      }}
                    >
                      {uploadedImage ? (
                        <img
                          src={uploadedImage.src}
                          alt="Uploaded"
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        />
                      ) : (
                        <Box sx={{ textAlign: 'center', color: '#666' }}>
                          <Upload size={48} sx={{ mb: 1, opacity: 0.7 }} />
                          <Typography variant="body2">Click or drag to upload image</Typography>
                          <Typography variant="caption" color="text.secondary">
                            PNG, JPG up to 5MB
                          </Typography>
                        </Box>
                      )}
                    </Box>

                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/jpg,image/webp"
                      onChange={handleFileUpload}
                      style={{ display: 'none' }}
                    />

                    {uploadProcessing && (
                      <Box sx={{ mt: 2 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <CircularProgress size={20} />
                          <Typography variant="caption">Processing image...</Typography>
                        </Box>
                      </Box>
                    )}

                    {uploadEmbedding && !uploadProcessing && (
                      <Box sx={{ mt: 2 }}>
                        <Chip
                          icon={<Check size={16} />}
                          label={`Face detected - Ready to save`}
                          color="success"
                          variant="outlined"
                          fullWidth
                        />
                      </Box>
                    )}

                    <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
                      ✓ Upload a clear face photo for best results
                    </Typography>
                  </Box>
                )}
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      )}

      {/* Save Dialog */}
      <Dialog open={saveDialogOpen} onClose={() => !loading && setSaveDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Confirm Enrollment</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mt: 2 }}>
            Ready to save enrollment for:
          </Typography>
          <Typography variant="h6" color="primary" sx={{ my: 1 }}>
            {selectedEmployee ? `${selectedEmployee.prenom} ${selectedEmployee.nom}` : selectedMatricule}
          </Typography>
          {tabMode === 'webcam' ? (
            <Typography variant="body2" color="text.secondary">
              Samples captured: <strong>{samples.length}/{NUM_SAMPLES}</strong>
            </Typography>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Image source: <strong>Uploaded file</strong>
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Embedding dimension: <strong>{EMBEDDING_DIM} (Custom TFLite model)</strong>
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSaveDialogOpen(false)} disabled={loading}>
            {tabMode === 'webcam' ? 'Retake Samples' : 'Change Image'}
          </Button>
          <Button
            onClick={saveEnrollment}
            variant="contained"
            disabled={loading}
          >
            {loading ? <CircularProgress size={24} /> : 'Save Enrollment'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
