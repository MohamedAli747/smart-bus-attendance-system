import { createTheme } from '@mui/material/styles';

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#1565c0',
    },
    secondary: {
      main: '#00acc1',
    },
    background: {
      default: '#f6f9fc',
      paper: '#ffffff',
    },
  },
  typography: {
    fontFamily: 'Inter, Roboto, sans-serif',
    h6: { fontWeight: 600 },
  },
});

export default theme;
