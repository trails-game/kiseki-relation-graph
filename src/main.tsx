import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ViewerMountConfig } from './types/graph';
import './styles.css';

declare global {
  interface Window {
    KisekiRelationViewer?: {
      mount: (el: HTMLElement, config?: ViewerMountConfig) => void;
      mountAll: () => void;
    };
  }
}

function mount(el: HTMLElement, config?: ViewerMountConfig) {
  if (el.dataset.krMounted === '1') return;
  el.dataset.krMounted = '1';
  ReactDOM.createRoot(el).render(
    <React.StrictMode>
      <App config={config} />
    </React.StrictMode>
  );
}

function mountAll() {
  const containers = document.querySelectorAll<HTMLElement>('.kiseki-relation-mount');
  containers.forEach((el) => {
    let cfg: ViewerMountConfig = {};
    if (el.dataset.config) {
      try {
        cfg = JSON.parse(el.dataset.config);
      } catch (e) {
        console.error('Invalid kiseki-relation data-config:', e);
      }
    }
    mount(el, cfg);
  });

  const standaloneRoot = document.getElementById('root');
  if (standaloneRoot && !standaloneRoot.dataset.krMounted) {
    standaloneRoot.style.width = '100vw';
    standaloneRoot.style.height = '100vh';
    mount(standaloneRoot, { height: '100vh', enableDemoSandbox: true });
  }
}

window.KisekiRelationViewer = { mount, mountAll };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountAll);
} else {
  mountAll();
}
