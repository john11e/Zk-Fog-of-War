import React from 'react';
import ReactDOM from 'react-dom/client';
import { Auth0Provider } from '@auth0/auth0-react';
import App from './App';

// ── Replace these with your real Auth0 application credentials ──────────────
const AUTH0_DOMAIN    = import.meta.env?.VITE_AUTH0_DOMAIN    ?? 'dev-2plosangvjgquflg.us.auth0.com';
const AUTH0_CLIENT_ID = import.meta.env?.VITE_AUTH0_CLIENT_ID ?? 'sXug7kjN34NzzXOKxEU4pW9te73qy1aZ';

/** True when real Auth0 creds are present */
export const AUTH0_READY = !AUTH0_DOMAIN.startsWith('YOUR') && !AUTH0_CLIENT_ID.startsWith('YOUR');

/** Stable redirect_uri */
const REDIRECT_URI = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Auth0Provider
      domain={AUTH0_READY ? AUTH0_DOMAIN : 'placeholder.auth0.com'}
      clientId={AUTH0_READY ? AUTH0_CLIENT_ID : 'placeholder_client_id'}
      authorizationParams={{ redirect_uri: REDIRECT_URI }}
      // cacheLocation="localstorage" keeps the session across hard-refreshes
      cacheLocation="localstorage"
      useRefreshTokens={AUTH0_READY}
    >
      <App />
    </Auth0Provider>
  </React.StrictMode>,
);