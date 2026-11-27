import './design-system/styles/globals.css';
import './shared/styles/tokens.css';
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/inter/wght-italic.css';
import '@fontsource/jetbrains-mono/400.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from './design-system/ui/Tooltip';
import { useKeyboardFocusVisibility } from './design-system/useKeyboardFocusVisibility';
import { AuthGate } from './features/auth/AuthGate';
import App from './App';

import { AccountEmailLanding } from './features/auth/AccountEmailForm';

function RootApp() {
  useKeyboardFocusVisibility();
  const action = new URLSearchParams(window.location.search).get('account-email');
  if (action === 'verify' || action === 'reset') return <TooltipProvider><AccountEmailLanding action={action} /></TooltipProvider>;
  return (
    <TooltipProvider>
      <AuthGate>
        <App />
      </AuthGate>
    </TooltipProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootApp />
  </StrictMode>
);
