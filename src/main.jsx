import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'

// Polyfill window.storage para Capacitor/PWA
// En el artifact de Claude usa window.storage nativo
// En producción Vite lo emulamos con localStorage
if (!window.storage) {
  window.storage = {
    get: async (key) => {
      try {
        const val = localStorage.getItem(key)
        return val ? { key, value: val } : null
      } catch { return null }
    },
    set: async (key, value) => {
      try {
        localStorage.setItem(key, value)
        return { key, value }
      } catch { return null }
    },
    delete: async (key) => {
      try {
        localStorage.removeItem(key)
        return { key, deleted: true }
      } catch { return null }
    },
    list: async (prefix = '') => {
      try {
        const keys = Object.keys(localStorage).filter(k => k.startsWith(prefix))
        return { keys }
      } catch { return { keys: [] } }
    }
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)
