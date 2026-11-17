import React from 'react';
import ReactDOM from 'react-dom/client';
import { AdminStudio, WpAdminBootConfig } from './AdminStudio';
import { CptMetaBox } from './CptMetaBox';
import '../styles.css';
import './admin.css';

declare global {
  interface Window {
    KisekiRelationAdminBoot?: WpAdminBootConfig;
  }
}

function initAdmin() {
  const boot = window.KisekiRelationAdminBoot;
  if (!boot) return;

  const studioEl = document.getElementById('kiseki-relation-admin-root');
  if (studioEl && !studioEl.dataset.mounted) {
    studioEl.dataset.mounted = '1';
    ReactDOM.createRoot(studioEl).render(
      <React.StrictMode>
        <AdminStudio boot={boot} />
      </React.StrictMode>
    );
  }

  const metaboxEl = document.getElementById('kiseki-relation-metabox-root');
  if (metaboxEl && boot.postContext && !metaboxEl.dataset.mounted) {
    metaboxEl.dataset.mounted = '1';
    ReactDOM.createRoot(metaboxEl).render(
      <React.StrictMode>
        <CptMetaBox boot={boot} />
      </React.StrictMode>
    );
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAdmin);
} else {
  initAdmin();
}
