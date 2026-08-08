import { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from './firebase';

import Login from './pages/Login';
import DashboardLayout from './components/DashboardLayout';
import Dashboard from './pages/Dashboard';
import DataManagement from './pages/DataManagement';
import BusMap from './pages/BusMap';
import FaceEnrollment from './pages/FaceEnrollment';
import Assignation from './pages/Assignation';
import Historique from './pages/Historique';
import FleetStats from './pages/FleetStats';

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Temporarily bypass auth for debugging
    setLoading(false);
    setUser({ email: 'test@test.com' }); // Mock user
    
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoading(false);
    }, (error) => {
      console.error('Auth error:', error);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>
        Loading Admin Portal...
      </div>
    );
  }

  return (
    <Router>
      <Routes>
        <Route 
          path="/login" 
          element={!user ? <Login /> : <Navigate to="/" />} 
        />
        
        {/* Protected Routes */}
        <Route 
          path="/" 
          element={user ? <DashboardLayout /> : <Navigate to="/login" />}
        >
          <Route index element={<Dashboard />} />
          <Route path="employees" element={<DataManagement collectionName="salaries" title="Employees" />} />
          <Route path="face-enrollments" element={<DataManagement collectionName="face_enrollments" title="Face Enrollments" />} />
          <Route path="buses" element={<DataManagement collectionName="buses" title="Buses" />} />
          <Route path="circuits" element={<DataManagement collectionName="circuits" title="Circuits" />} />
          <Route path="conducteurs" element={<DataManagement collectionName="conducteurs" title="Conducteurs" />} />
          <Route path="assignation" element={<Assignation />} />
          <Route path="historique" element={<Historique />} />
          <Route path="planning" element={<DataManagement collectionName="planning" title="Planning" />} />
          <Route path="enroll-face" element={<FaceEnrollment />} />
          <Route path="map" element={<BusMap />} />
          <Route path="fleet-stats" element={<FleetStats />} />
        </Route>
      </Routes>
    </Router>
  );
}

export default App;
