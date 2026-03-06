import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env variables from .env file
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    define: {
      // Expose API_KEY to the client-side code, making it available as process.env.API_KEY
      'process.env.API_KEY': JSON.stringify(env.API_KEY),
    },
  };
});
