import { useState } from 'react'
import { Outlet, NavLink } from 'react-router-dom'
import { signOut } from 'firebase/auth'
import { auth } from '../firebase'
import AppBar from '@mui/material/AppBar'
import Box from '@mui/material/Box'
import Toolbar from '@mui/material/Toolbar'
import Typography from '@mui/material/Typography'
import IconButton from '@mui/material/IconButton'
import Drawer from '@mui/material/Drawer'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Divider from '@mui/material/Divider'
import Avatar from '@mui/material/Avatar'
import { Menu, LayoutDashboard, Users, Bus, Map, UserCog, CalendarDays, Navigation, LogOut, Camera, Shuffle, History, BarChart3 } from 'lucide-react'

const drawerWidth = 260

export default function DashboardLayout() {
  const [mobileOpen, setMobileOpen] = useState(false)

  const handleDrawerToggle = () => {
    setMobileOpen(!mobileOpen)
  }

  const handleLogout = () => {
    signOut(auth)
  }

  const navItems = [
    { path: '/', label: 'Dashboard', icon: <LayoutDashboard size={18} /> },
    { path: '/enroll-face', label: 'Enroll Face', icon: <Camera size={18} /> },
    { path: '/employees', label: 'Employees', icon: <Users size={18} /> },
    { path: '/face-enrollments', label: 'Face Records', icon: <Users size={18} /> },
    { path: '/buses', label: 'Buses', icon: <Bus size={18} /> },
    { path: '/circuits', label: 'Circuits', icon: <Map size={18} /> },
    { path: '/conducteurs', label: 'Conducteurs', icon: <UserCog size={18} /> },
    { path: '/assignation', label: 'Assignation', icon: <Shuffle size={18} /> },
    { path: '/historique', label: 'Historique & Export', icon: <History size={18} /> },
    { path: '/planning', label: 'Planning', icon: <CalendarDays size={18} /> },
    { path: '/map', label: 'Bus Map', icon: <Navigation size={18} /> },
    { path: '/fleet-stats', label: 'Fleet & Stats', icon: <BarChart3 size={18} /> },
  ]

  const drawer = (
    <div>
      <Box sx={{ p: 2, display: 'flex', alignItems: 'center', gap: 2 }}>
        <Avatar sx={{ bgcolor: 'primary.main' }}>AP</Avatar>
        <Box>
          <Typography variant="h6">AdminPro</Typography>
          <Typography variant="body2" color="text.secondary">Bus Attendance</Typography>
        </Box>
      </Box>
      <Divider />
      <List>
        {navItems.map((item) => (
          <ListItem key={item.path} disablePadding>
            <NavLink
              to={item.path}
              style={{ textDecoration: 'none', color: 'inherit', width: '100%' }}
            >
              <ListItemButton>
                <ListItemIcon>{item.icon}</ListItemIcon>
                <ListItemText primary={item.label} />
              </ListItemButton>
            </NavLink>
          </ListItem>
        ))}
      </List>
      <Box sx={{ flex: 1 }} />
      <Divider />
      <Box sx={{ p: 2 }}>
        <ListItemButton onClick={handleLogout}>
          <ListItemIcon>
            <LogOut size={18} />
          </ListItemIcon>
          <ListItemText primary="Sign Out" />
        </ListItemButton>
      </Box>
    </div>
  )

  return (
    <Box sx={{ display: 'flex' }}>
      <AppBar position="fixed" sx={{ zIndex: (theme) => theme.zIndex.drawer  }}>
        <Toolbar>
          <IconButton color="inherit" edge="start" onClick={handleDrawerToggle} sx={{ mr: 2 }}>
            <Menu size={22} />
          </IconButton>
          <Typography variant="h6" noWrap component="div">
            Admin Dashboard
          </Typography>
        </Toolbar>
      </AppBar>

      <Box component="nav" sx={{ width: { sm: drawerWidth }, flexShrink: { sm: 0 } }}>
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={handleDrawerToggle}
          ModalProps={{ keepMounted: true }}
          sx={{ display: { xs: 'block', sm: 'none' }, '& .MuiDrawer-paper': { width: drawerWidth } }}
        >
          {drawer}
        </Drawer>

        <Drawer
          variant="permanent"
          sx={{ display: { xs: 'none', sm: 'block' }, '& .MuiDrawer-paper': { width: drawerWidth, boxSizing: 'border-box' } }}
          open
        >
          {drawer}
        </Drawer>
      </Box>

      <Box component="main" sx={{ flexGrow: 1, p: 3, width: { sm: `calc(100% - ${drawerWidth}px)` } }}>
        <Toolbar />
        <Outlet />
      </Box>
    </Box>
  )
}
