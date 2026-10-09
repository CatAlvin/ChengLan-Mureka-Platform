import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AuthGate } from './components/auth';
import { App } from './app';
import { PlayerProvider } from './components/player';
import './styles.css';
import { Demo } from './components/demo';
const client = new QueryClient({ defaultOptions: { queries: { staleTime: 2000, retry: 1 }, mutations: { retry: false } } });
function Workspace() {
  const location = useLocation();
  if (location.pathname === '/demo') return <Demo />;
  return <AuthGate><PlayerProvider><App /></PlayerProvider></AuthGate>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><QueryClientProvider client={client}><BrowserRouter><Workspace /></BrowserRouter><Toaster position="top-center" richColors closeButton /></QueryClientProvider></React.StrictMode>,
);
