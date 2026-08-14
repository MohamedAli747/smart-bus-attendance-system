import { useState, useEffect } from 'react'
import { Outlet, NavLink, useNavigate } from 'react-router-dom'
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
import Tooltip from '@mui/material/Tooltip'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import { Menu as MenuIcon, LayoutDashboard, Users, Bus, Map, UserCog, CalendarDays, Navigation, LogOut, Camera, Shuffle, History, BarChart3, ChevronLeft, ChevronRight, KeyRound, UserCircle } from 'lucide-react'
import ChatBot from './ChatBot'

const drawerWidth = 260
const collapsedWidth = 72

export default function DashboardLayout() {
  const navigate = useNavigate()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar_collapsed') === '1')
  const [accountAnchor, setAccountAnchor] = useState(null)
  const accountMenuOpen = Boolean(accountAnchor)

  useEffect(() => {
    localStorage.setItem('sidebar_collapsed', collapsed ? '1' : '0')
  }, [collapsed])

  const handleDrawerToggle = () => {
    setMobileOpen(!mobileOpen)
  }

  const handleCollapseToggle = () => {
    setCollapsed((v) => !v)
  }

  const handleLogout = () => {
    setAccountAnchor(null)
    signOut(auth)
  }

  const handleOpenAccountMenu = (e) => {
    setAccountAnchor(e.currentTarget)
  }

  const handleCloseAccountMenu = () => {
    setAccountAnchor(null)
  }

  const handleChangePassword = () => {
    setAccountAnchor(null)
    navigate('/profile')
  }

  const navItems = [
    { path: '/', label: 'Tableau de bord', icon: <LayoutDashboard size={18} /> },
    { path: '/employees', label: 'Employés', icon: <Users size={18} /> },
    { path: '/enroll-face', label: 'Enrôler un visage', icon: <Camera size={18} /> },
    { path: '/face-enrollments', label: 'Visages enregistrés', icon: <Users size={18} /> },
    { path: '/conducteurs', label: 'Conducteurs', icon: <UserCog size={18} /> },
    { path: '/buses', label: 'Bus', icon: <Bus size={18} /> },
    { path: '/circuits', label: 'Circuits', icon: <Map size={18} /> },
    { path: '/planning', label: 'Planning', icon: <CalendarDays size={18} /> },
    { path: '/assignation', label: 'Assignation', icon: <Shuffle size={18} /> },
    { path: '/map', label: 'Carte des bus', icon: <Navigation size={18} /> },
    { path: '/fleet-stats', label: 'Flotte & Stats', icon: <BarChart3 size={18} /> },
    { path: '/historique', label: 'Historique & Export', icon: <History size={18} /> },
  ]

  const drawer = (isCollapsed) => (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Box sx={{ p: isCollapsed ? 1.5 : 2, display: 'flex', alignItems: 'center', gap: 2, justifyContent: isCollapsed ? 'center' : 'flex-start' }}>
        <Avatar sx={{ bgcolor: 'primary.main' }}>AD</Avatar>
        {!isCollapsed && (
          <Box sx={{ overflow: 'hidden' }}>
            <Typography variant="h6" noWrap>Administration</Typography>
            <Typography variant="body2" color="text.secondary" noWrap>WICMIC Transport</Typography>
          </Box>
        )}
      </Box>
      <Divider />
      <List sx={{ flex: 1 }}>
        {navItems.map((item) => (
          <ListItem key={item.path} disablePadding>
            <NavLink
              to={item.path}
              style={{ textDecoration: 'none', color: 'inherit', width: '100%' }}
            >
              <Tooltip title={isCollapsed ? item.label : ''} placement="right">
                <ListItemButton sx={{ justifyContent: isCollapsed ? 'center' : 'flex-start', px: isCollapsed ? 1 : 2 }}>
                  <ListItemIcon sx={{ minWidth: isCollapsed ? 0 : 40, justifyContent: 'center' }}>{item.icon}</ListItemIcon>
                  {!isCollapsed && <ListItemText primary={item.label} />}
                </ListItemButton>
              </Tooltip>
            </NavLink>
          </ListItem>
        ))}
      </List>
      <Divider />
      <Box sx={{ p: isCollapsed ? 1 : 2 }}>
        <Tooltip title={isCollapsed ? 'Compte' : ''} placement="right">
          <ListItemButton
            onClick={handleOpenAccountMenu}
            sx={{ justifyContent: isCollapsed ? 'center' : 'flex-start', px: isCollapsed ? 1 : 2 }}
          >
            <ListItemIcon sx={{ minWidth: isCollapsed ? 0 : 40, justifyContent: 'center' }}>
              <UserCircle size={18} />
            </ListItemIcon>
            {!isCollapsed && <ListItemText primary="Compte" />}
          </ListItemButton>
        </Tooltip>
        <Menu anchorEl={accountAnchor} open={accountMenuOpen} onClose={handleCloseAccountMenu}>
          <MenuItem onClick={handleChangePassword}>
            <ListItemIcon><KeyRound size={18} /></ListItemIcon>
            Changer le mot de passe
          </MenuItem>
          <MenuItem onClick={handleLogout}>
            <ListItemIcon><LogOut size={18} /></ListItemIcon>
            Déconnexion
          </MenuItem>
        </Menu>
      </Box>
    </Box>
  )

  const currentWidth = collapsed ? collapsedWidth : drawerWidth

  return (
    <Box sx={{ display: 'flex' }}>
      <AppBar
        position="fixed"
        sx={{
          zIndex: (theme) => theme.zIndex.drawer + 1,
          width: { sm: `calc(100% - ${currentWidth}px)` },
          ml: { sm: `${currentWidth}px` },
          transition: 'width 0.2s, margin 0.2s',
        }}
      >
        <Toolbar>
          <IconButton
            color="inherit"
            edge="start"
            onClick={handleDrawerToggle}
            sx={{ mr: 2, display: { sm: 'none' } }}
          >
            <MenuIcon size={22} />
          </IconButton>
        </Toolbar>
      </AppBar>

      <Box component="nav" sx={{ width: { sm: currentWidth }, flexShrink: { sm: 0 }, transition: 'width 0.2s' }}>
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={handleDrawerToggle}
          ModalProps={{ keepMounted: true }}
          sx={{ display: { xs: 'block', sm: 'none' }, '& .MuiDrawer-paper': { width: drawerWidth } }}
        >
          {drawer(false)}
        </Drawer>

        <Drawer
          variant="permanent"
          sx={{
            display: { xs: 'none', sm: 'block' },
            '& .MuiDrawer-paper': {
              width: currentWidth,
              boxSizing: 'border-box',
              overflowX: 'hidden',
              transition: 'width 0.2s',
            },
          }}
          open
        >
          {drawer(collapsed)}
          <IconButton
            onClick={handleCollapseToggle}
            size="small"
            sx={{
              position: 'absolute',
              top: 12,
              right: -14,
              bgcolor: 'background.paper',
              border: '1px solid',
              borderColor: 'divider',
              boxShadow: 1,
              '&:hover': { bgcolor: 'grey.100' },
              zIndex: 1,
            }}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </IconButton>
        </Drawer>
      </Box>

      <Box component="main" sx={{ flexGrow: 1, p: 3, width: { sm: `calc(100% - ${currentWidth}px)` }, transition: 'width 0.2s' }}>
        <Toolbar />
        <Outlet />
      </Box>

      <ChatBot />
    </Box>
  )
}
