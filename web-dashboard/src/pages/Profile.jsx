import { useState, useEffect } from 'react'
import {
  updateProfile,
  onAuthStateChanged,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
} from 'firebase/auth'
import { auth } from '../firebase'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Avatar from '@mui/material/Avatar'
import Typography from '@mui/material/Typography'
import TextField from '@mui/material/TextField'
import Button from '@mui/material/Button'
import Alert from '@mui/material/Alert'
import Divider from '@mui/material/Divider'
import { User, KeyRound } from 'lucide-react'

export default function Profile() {
  const [user, setUser] = useState(null)
  const [displayName, setDisplayName] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pwSaving, setPwSaving] = useState(false)
  const [pwMessage, setPwMessage] = useState('')
  const [pwError, setPwError] = useState('')

  useEffect(() => {
    if (!auth) return
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (currentUser) {
        setUser(currentUser)
        setDisplayName(currentUser.displayName || '')
      } else {
        setUser(null)
      }
    })

    return () => unsubscribe()
  }, [])

  const handleSave = async (event) => {
    event.preventDefault()
    if (!auth?.currentUser) {
      setError('Aucun utilisateur authentifié trouvé.')
      return
    }
    setSaving(true)
    setError('')
    setMessage('')

    try {
      await updateProfile(auth.currentUser, {
        displayName: displayName.trim() || auth.currentUser.displayName || '',
      })
      setMessage('Profil mis à jour avec succès.')
    } catch (err) {
      setError(err.message || 'Impossible de mettre à jour le profil.')
    } finally {
      setSaving(false)
    }
  }

  const handleChangePassword = async (event) => {
    event.preventDefault()
    setPwError('')
    setPwMessage('')

    if (!auth?.currentUser) {
      setPwError('Aucun utilisateur authentifié trouvé.')
      return
    }
    if (newPassword.length < 6) {
      setPwError('Le nouveau mot de passe doit contenir au moins 6 caractères.')
      return
    }
    if (newPassword !== confirmPassword) {
      setPwError('Les deux mots de passe ne correspondent pas.')
      return
    }

    setPwSaving(true)
    try {
      // Firebase exige une reconnexion récente pour changer le mot de passe
      const credential = EmailAuthProvider.credential(auth.currentUser.email, currentPassword)
      await reauthenticateWithCredential(auth.currentUser, credential)
      await updatePassword(auth.currentUser, newPassword)
      setPwMessage('Mot de passe modifié avec succès.')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      console.error(err)
      if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
        setPwError('Mot de passe actuel incorrect.')
      } else if (err.code === 'auth/too-many-requests') {
        setPwError('Trop de tentatives. Réessayez plus tard.')
      } else {
        setPwError(err.message || 'Impossible de modifier le mot de passe.')
      }
    } finally {
      setPwSaving(false)
    }
  }

  const profileEmail = user?.email || 'Non disponible'
  const profileName = user?.displayName || "Aucun nom d'affichage"

  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
      <Paper sx={{ width: '100%', maxWidth: 720, p: 4, borderRadius: 3 }} elevation={4}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
          <Avatar sx={{ bgcolor: 'primary.main', width: 56, height: 56 }}>
            <User size={30} />
          </Avatar>
          <Box>
            <Typography variant="h4">Profil</Typography>
            <Typography variant="body2" color="text.secondary">
              Gérez les paramètres de votre compte et vos informations de profil.
            </Typography>
          </Box>
        </Box>

        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {message && <Alert severity="success" sx={{ mb: 2 }}>{message}</Alert>}

        <Box component="form" onSubmit={handleSave} sx={{ display: 'grid', gap: 2 }}>
          <TextField
            label="Nom d'affichage"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            fullWidth
          />
          <TextField
            label="E-mail"
            value={profileEmail}
            fullWidth
            disabled
          />
          <TextField
            label="ID utilisateur"
            value={user?.uid || ''}
            fullWidth
            disabled
          />
          <Button type="submit" variant="contained" disabled={saving}>
            {saving ? 'Enregistrement...' : 'Enregistrer le profil'}
          </Button>
        </Box>

        <Box sx={{ mt: 4, p: 3, bgcolor: 'background.paper', borderRadius: 2, border: '1px solid rgba(0,0,0,0.04)' }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
            Détails du compte
          </Typography>
          <Typography variant="body2">E-mail vérifié : {user?.emailVerified ? 'Oui' : 'Non'}</Typography>
          <Typography variant="body2">Fournisseur : {user?.providerData?.[0]?.providerId || 'firebase'}</Typography>
        </Box>

        <Divider sx={{ my: 4 }} />

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
          <Avatar sx={{ bgcolor: 'primary.main', width: 56, height: 56 }}>
            <KeyRound size={26} />
          </Avatar>
          <Box>
            <Typography variant="h5">Changer le mot de passe</Typography>
            <Typography variant="body2" color="text.secondary">
              Choisissez un nouveau mot de passe pour votre compte.
            </Typography>
          </Box>
        </Box>

        {pwError && <Alert severity="error" sx={{ mb: 2 }}>{pwError}</Alert>}
        {pwMessage && <Alert severity="success" sx={{ mb: 2 }}>{pwMessage}</Alert>}

        <Box component="form" onSubmit={handleChangePassword} sx={{ display: 'grid', gap: 2 }}>
          <TextField
            label="Mot de passe actuel"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            fullWidth
          />
          <TextField
            label="Nouveau mot de passe"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            fullWidth
            helperText="6 caractères minimum"
          />
          <TextField
            label="Confirmer le nouveau mot de passe"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            fullWidth
          />
          <Button type="submit" variant="contained" disabled={pwSaving}>
            {pwSaving ? 'Modification...' : 'Modifier le mot de passe'}
          </Button>
        </Box>
      </Paper>
    </Box>
  )
}
