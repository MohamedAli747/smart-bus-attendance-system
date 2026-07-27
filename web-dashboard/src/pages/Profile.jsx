import { useState, useEffect } from 'react'
import { updateProfile, onAuthStateChanged } from 'firebase/auth'
import { auth } from '../firebase'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Avatar from '@mui/material/Avatar'
import Typography from '@mui/material/Typography'
import TextField from '@mui/material/TextField'
import Button from '@mui/material/Button'
import Alert from '@mui/material/Alert'
import { User } from 'lucide-react'

export default function Profile() {
  const [user, setUser] = useState(null)
  const [displayName, setDisplayName] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

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
      setError('No authenticated user found.')
      return
    }
    setSaving(true)
    setError('')
    setMessage('')

    try {
      await updateProfile(auth.currentUser, {
        displayName: displayName.trim() || auth.currentUser.displayName || '',
      })
      setMessage('Profile updated successfully.')
    } catch (err) {
      setError(err.message || 'Unable to update profile.')
    } finally {
      setSaving(false)
    }
  }

  const profileEmail = user?.email || 'Not available'
  const profileName = user?.displayName || 'No display name'

  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
      <Paper sx={{ width: '100%', maxWidth: 720, p: 4, borderRadius: 3 }} elevation={4}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
          <Avatar sx={{ bgcolor: 'primary.main', width: 56, height: 56 }}>
            <User size={30} />
          </Avatar>
          <Box>
            <Typography variant="h4">Profile</Typography>
            <Typography variant="body2" color="text.secondary">
              Manage your account settings and profile information.
            </Typography>
          </Box>
        </Box>

        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {message && <Alert severity="success" sx={{ mb: 2 }}>{message}</Alert>}

        <Box component="form" onSubmit={handleSave} sx={{ display: 'grid', gap: 2 }}>
          <TextField
            label="Display Name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            fullWidth
          />
          <TextField
            label="Email"
            value={profileEmail}
            fullWidth
            disabled
          />
          <TextField
            label="User ID"
            value={user?.uid || ''}
            fullWidth
            disabled
          />
          <Button type="submit" variant="contained" disabled={saving}>
            {saving ? 'Saving...' : 'Save profile'}
          </Button>
        </Box>

        <Box sx={{ mt: 4, p: 3, bgcolor: 'background.paper', borderRadius: 2, border: '1px solid rgba(0,0,0,0.04)' }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
            Account details
          </Typography>
          <Typography variant="body2">Email verified: {user?.emailVerified ? 'Yes' : 'No'}</Typography>
          <Typography variant="body2">Provider: {user?.providerData?.[0]?.providerId || 'firebase'}</Typography>
        </Box>
      </Paper>
    </Box>
  )
}
